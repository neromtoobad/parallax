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
import { NEAR, balanceOf, call, isAccountId, sha256, toUnits, txUrl, view } from './near/chain.ts';
import { priceFor, recordSpend } from './cfo/treasury.ts';
import { findService, type Delivery } from './services/index.ts';
import { briefOf } from './services/check.ts';
import { settleBills } from './settle.ts';
import type { ReceiptLine } from './meter.ts';
import type { Step } from './job.ts';

export type State = 'quoted' | 'funded' | 'bidding' | 'working' | 'delivered' | 'accepted' | 'rejected' | 'failed';
export type Order = {
  id: string; service: string; input: Record<string, string>; brief: string; priceUsd: number;
  customer: string; state: State; createdAt: string; updatedAt: string;
  txs: { what: string; hash: string; url: string }[];
  lots: LotRecord[]; steps: Step[]; receipt: ReceiptLine[];
  delivery?: Omit<Delivery, 'site'> & { site?: { path: string } };
  error?: string; private?: boolean;
  /** The bank refunded it after the delivery deadline. */
  refunded?: boolean;
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
const DEMO_PAYER = process.env.PARALLAX_DEMO_PAYER ?? NEAR?.house ?? NEAR?.owner ?? '';
export const demoPayer = () => DEMO_PAYER;

/** Quote an order. On NEAR the CFO opens the job in the bank, waiting for the customer's USDC. */
export async function quote(serviceId: string, input: Record<string, string>, customer?: string, isPrivate = false): Promise<Order> {
  const svc = findService(serviceId);
  if (!svc) throw new Error('no such service');
  if (customer && !isAccountId(customer)) throw new Error('that is not a NEAR account');
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
      if ((await balanceOf(DEMO_PAYER)) < o.priceUsd) throw new Error('The house wallet is empty until the CFO refills it from the margin. Pay from your own NEAR wallet, or try again later.');
      tx(o, `Paid ${o.priceUsd} USDC into escrow`, (await call(DEMO_PAYER, NEAR!.bank, 'pay_job', { id: o.id }, { tgas: 30 })).hash);
    }
    if ((await jobState(o.id, 'Funded')) !== 'Funded') throw new Error('the bank has not received the payment yet');
  }
  o.state = 'funded';
  save(o);
  void run(o);
  return o;
}

/**
 * A board job the CFO has just taken (board.ts): the customer's own brief and budget, already in escrow on the
 * bank, so it starts at the auction.
 */
export function startBoardJob(p: { id: string; title: string; brief: string; text: string; budgetUsd: number; customer: string; postTx?: string; takeTx: string }) {
  const now = new Date().toISOString();
  const o: Order = {
    id: p.id, service: 'board', input: { title: p.title, brief: p.brief }, brief: p.text, priceUsd: p.budgetUsd,
    customer: p.customer, state: 'funded', createdAt: now, updatedAt: now, txs: [], lots: [], steps: [], receipt: [],
  };
  if (p.postTx) tx(o, `Posted on the board with ${p.budgetUsd} USDC in escrow`, p.postTx);
  tx(o, 'Brief screened and taken by the CFO', p.takeTx);
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
    o.lots = clean(await closeLots(o.id, lots, job, pass, !!d && !pass));
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
export async function accept(o: Order, txHash?: string) {
  if (o.state !== 'delivered') throw new Error('nothing to accept yet');
  if (!DRY) {
    if (o.customer === DEMO_PAYER) tx(o, 'Accepted; escrow released to the winners', (await call(o.customer, NEAR!.bank, 'accept', { id: o.id }, { tgas: 150 })).hash);
    else {
      // The customer signed bank.accept in their own wallet; the bank is the record of it.
      if ((await jobState(o.id, 'Accepted')) !== 'Accepted') throw new Error('the bank has not seen your acceptance yet');
      if (txHash) tx(o, 'Accepted from your wallet; escrow released to the winners', txHash);
    }
  }
  o.state = 'accepted'; save(o);
  return o;
}

/** The customer rejected the work from their own wallet: the bank refunded the full price. */
export async function rejected(o: Order, txHash?: string) {
  if (o.state !== 'delivered') throw new Error('nothing to reject');
  if (!DRY && (await jobState(o.id, 'Rejected')) !== 'Rejected') throw new Error('the bank has not seen your rejection yet');
  if (txHash) tx(o, 'Rejected from your wallet; the full price refunded', txHash);
  o.state = 'rejected'; save(o);
  return o;
}

/** The job's state on the bank, waiting a little for a wallet's transaction to be final. */
async function jobState(id: string, want: string): Promise<string | undefined> {
  let s: string | undefined;
  for (let i = 0; i < 6; i++) {
    s = (await view<{ state: string }>(NEAR!.bank, 'get_job', { id }).catch(() => undefined))?.state;
    if (s === want) return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return s;
}

/** A job the team didn't deliver by its deadline (it failed, or the server stopped mid-run): the bank refunds
 *  the full price and the bond (RULES.md 12). refund_late is open to anyone; the CFO calls it in its round. */
export async function refundLate(): Promise<string[]> {
  if (DRY || !NEAR) return [];
  const did: string[] = [];
  for (const o of listOrders(200).filter((o) => ['funded', 'bidding', 'working', 'failed'].includes(o.state) && !o.refunded)) {
    const j = await view<{ state: string; deliver_by: string }>(NEAR.bank, 'get_job', { id: o.id }).catch(() => undefined);
    if (!j || j.state !== 'Funded' || Date.now() * 1e6 <= Number(j.deliver_by)) continue;
    tx(o, 'Not delivered in time; the full price refunded', (await call(NEAR.cfo, NEAR.bank, 'refund_late', { id: o.id }, { tgas: 60 })).hash);
    o.refunded = true;
    if (o.state !== 'failed') { o.state = 'failed'; o.error = 'The team did not deliver in time.'; }
    save(o);
    did.push(`refunded job ${o.id}: not delivered by its deadline`);
  }
  return did;
}
