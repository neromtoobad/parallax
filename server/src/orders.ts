// An order from quote to payout. On NEAR: the CFO opens the job in the bank, the customer funds it with
// USDC (job:<id>), the lots are auctioned, the winners do the work, each lot is inspected, the job is
// submitted, and the customer's accept releases the escrow to the winners. In demo mode the same steps
// run in memory.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR, DRY } from './config.ts';
import { publish } from './bus.ts';
import { Job } from './job.ts';
import { assignmentFor, auction, closeLots, type LotRecord } from './lots.ts';
import { NEARAI_HOST } from './nearai.ts';
import { NEAR, call, payBank, sha256, toUnits, txUrl, view } from './near/chain.ts';
import { priceFor, recordSpend } from './cfo/treasury.ts';
import { findService, type Delivery } from './services/index.ts';
import { briefOf } from './services/check.ts';
import { settleBills } from './settle.ts';
import type { ReceiptLine } from './meter.ts';
import type { Step } from './job.ts';

export type State = 'quoted' | 'funded' | 'bidding' | 'working' | 'delivered' | 'accepted' | 'failed';
export type Order = {
  id: string; service: string; input: Record<string, string>; brief: string; priceUsd: number;
  customer: string; state: State; createdAt: string; updatedAt: string;
  txs: { what: string; hash: string; url: string }[];
  lots: LotRecord[]; steps: Step[]; receipt: ReceiptLine[];
  delivery?: Omit<Delivery, 'site'> & { site?: { path: string } };
  error?: string; private?: boolean;
};

const dir = () => join(DATA_DIR, 'orders');
const cache = new Map<string, Order>();
export function getOrder(id: string): Order | undefined {
  if (!/^[a-z0-9]{8,16}$/.test(id)) return undefined;
  if (!cache.has(id) && existsSync(join(dir(), `${id}.json`))) cache.set(id, JSON.parse(readFileSync(join(dir(), `${id}.json`), 'utf8')));
  return cache.get(id);
}
export function listOrders(limit = 20): Order[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => getOrder(f.slice(0, -5))!).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
function save(o: Order) {
  o.updatedAt = new Date().toISOString();
  cache.set(o.id, o);
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${o.id}.json`), JSON.stringify(o));
  publish({ type: 'order', orderId: o.id, data: { state: o.state, error: o.error } });
}
function tx(o: Order, what: string, hash: string) { o.txs.push({ what, hash, url: txUrl(hash) }); }

/** The house test wallet that pays for demo orders on testnet (the judge's "pay with test USDC"). */
const DEMO_PAYER = process.env.PARALLAX_DEMO_PAYER ?? NEAR?.owner ?? '';

/** Quote an order. On NEAR the CFO opens the job in the bank, waiting for the customer's USDC. */
export async function quote(serviceId: string, input: Record<string, string>, customer?: string, isPrivate = false): Promise<Order> {
  const svc = findService(serviceId);
  if (!svc) throw new Error('no such service');
  for (const f of svc.fields) if (!f.optional && !input[f.key]?.trim()) throw new Error(`${f.label} is missing`);
  const clean = Object.fromEntries(svc.fields.map((f) => [f.key, String(input[f.key] ?? '').slice(0, f.long ? 600 : 160).trim()]));
  const policy = DRY ? { min_margin_bps: 2000 } : await view<{ min_margin_bps: number }>(NEAR!.bank, 'get_policy');
  const now = new Date().toISOString();
  const o: Order = {
    id: randomBytes(5).toString('hex'), service: svc.id, input: clean, brief: briefOf(svc.fields, clean),
    priceUsd: priceFor(svc.id, svc.priceUsd, policy.min_margin_bps), customer: customer || DEMO_PAYER || 'demo-customer',
    state: 'quoted', createdAt: now, updatedAt: now, txs: [], lots: [], steps: [], receipt: [], private: isPrivate,
  };
  if (!DRY) {
    const r = await call(NEAR!.cfo, NEAR!.bank, 'open_job', { id: o.id, customer: o.customer, amount: toUnits(o.priceUsd), bond: '0', spec_hash: sha256(o.brief), fund_secs: 1800, deliver_secs: 3600 });
    tx(o, 'Job opened by the CFO', r.hash);
  }
  save(o);
  return o;
}

/** Pay with the house test wallet (testnet), or confirm a payment the customer's own wallet made. */
export async function fund(o: Order, withDemoWallet: boolean) {
  if (o.state !== 'quoted') return o;
  if (!DRY) {
    if (withDemoWallet) {
      if (o.customer !== DEMO_PAYER) throw new Error('this order is paid from its own wallet');
      tx(o, `Paid ${o.priceUsd} USDC into escrow`, (await payBank(DEMO_PAYER, o.priceUsd, `job:${o.id}`)).hash);
    }
    const j = await view<{ state: string }>(NEAR!.bank, 'get_job', { id: o.id });
    if (j?.state !== 'Funded') throw new Error('the bank has not received the payment yet');
  }
  o.state = 'funded';
  save(o);
  void run(o);
  return o;
}

/** Auction, work, inspect, submit. */
async function run(o: Order) {
  const svc = findService(o.service)!;
  try {
    o.state = 'bidding'; save(o);
    const lots = await auction(o.id, o.service, o.priceUsd, o.private ? undefined : o.brief);
    o.lots = clean(lots);
    o.state = 'working'; save(o);
    const job = new Job(o.id, o.service, { budgetUsd: o.priceUsd * 0.5, allowHosts: [NEARAI_HOST] }, assignmentFor(o.id));
    let d: Delivery | undefined, err: string | undefined;
    try { d = await svc.run(job, o.input); } catch (e: any) { err = String(e?.message ?? e).slice(0, 200); job.log('cfo', 'error', err); }
    const pass = !!d?.check.pass;
    o.lots = clean(await closeLots(o.id, lots, job, pass));
    o.steps = job.steps; o.receipt = job.receipt;
    if (!d || !pass) {
      o.state = 'failed'; o.error = err ?? `The auditor stopped it: ${d!.check.notes.join('; ')}`;
      if (d) o.delivery = strip(o.id, d);
      save(o);
      return;
    }
    o.delivery = strip(o.id, d);
    if (!DRY) tx(o, 'Work submitted to the bank', (await call(NEAR!.cfo, NEAR!.bank, 'submit_job', { id: o.id, deliverable_hash: sha256(JSON.stringify(o.delivery)) })).hash);
    job.log('messenger', 'done', 'Delivered. It is waiting for you to accept.');
    o.steps = job.steps;
    recordSpend(o.service, job.receipt);
    o.state = 'delivered'; save(o);
    await settleBills(job);
    o.receipt = job.receipt; save(o);
  } catch (e: any) {
    o.state = 'failed'; o.error = String(e?.message ?? e).slice(0, 200); save(o);
  }
}

/** A lot as the order keeps it: no salts or timers. */
const clean = (lots: LotRecord[]) => lots.map(({ salts, outside, cost, commitEnd, revealEnd, ...l }: any) => l as LotRecord);

/** A built website is written to disk and served at /sites/<id>/; the order keeps just its address. */
function strip(id: string, d: Delivery) {
  if (!d.site) return d;
  const at = join(DATA_DIR, 'sites', id);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'index.html'), d.site.html);
  return { ...d, site: { path: d.site.path } };
}
export const sitePath = (id: string) => join(DATA_DIR, 'sites', id, 'index.html');

/** The customer accepts: the bank pays each lot's winner and keeps its margin. */
export async function accept(o: Order) {
  if (o.state !== 'delivered') throw new Error('nothing to accept yet');
  if (!DRY) {
    if (o.customer !== DEMO_PAYER) throw new Error('accept from your own wallet');
    tx(o, 'Accepted; escrow released to the winners', (await call(o.customer, NEAR!.bank, 'accept', { id: o.id })).hash);
  }
  o.state = 'accepted'; save(o);
  return o;
}
