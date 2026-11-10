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
import { assignmentFor, auction, closeLots, takePricing, type LotRecord } from './lots.ts';
import { NEARAI_HOST } from './nearai.ts';
import { NEAR, ROOM_MIN, balanceOf, bankRoom, call, isAccountId, sha256, tg, timed, toUnits, txUrl, view } from './near/chain.ts';
import { priceFor, recordSpend } from './cfo/treasury.ts';
import { findService, type Delivery } from './services/index.ts';
import { briefOf } from './services/check.ts';
import { settleBills } from './settle.ts';
import { depositStatus, openDeposit, type Deposit } from './oneclick.ts';
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
  /** A sub-job: the job and part an agent hired it for, and the agent. */
  parent?: { id: string; lot: number; by: string };
  /** The sub-jobs agents hired for this job's parts. */
  subs?: { id: string; title: string; by: string; amount: number; tx: string }[];
  /** Paid from another chain through NEAR Intents (oneclick.ts): the deposit address and how it went. */
  intents?: Deposit;
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
const AUCTION_MAX_MS = Number(process.env.PARALLAX_AUCTION_MAX_MS ?? 12 * 60_000);
const DEMO_PAYER = process.env.PARALLAX_DEMO_PAYER ?? NEAR?.house ?? NEAR?.owner ?? '';
export const demoPayer = () => DEMO_PAYER;

/** Quote an order. On NEAR the CFO opens the job in the bank, waiting for the customer's USDC. */
export async function quote(serviceId: string, input: Record<string, string>, customer?: string, isPrivate = false): Promise<Order> {
  const svc = findService(serviceId);
  if (!svc) throw new Error('no such service');
  if (customer && !isAccountId(customer)) throw new Error('that is not a NEAR account');
  for (const f of svc.fields) if (!f.optional && !input[f.key]?.trim()) throw new Error(`${f.label} is missing`);
  const clean = Object.fromEntries(svc.fields.map((f) => [f.key, String(input[f.key] ?? '').slice(0, f.long ? 600 : 160).trim()]));
  if (!DRY && (await bankRoom()) < ROOM_MIN) throw new Error('The bank is out of room on chain for new jobs until it is topped up with NEAR. Nothing was charged; try again later.');
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
 * Pay from another chain: a real 1Click deposit address whose swap lands as USDC in this job's escrow. The
 * customer stays whoever the quote named (the house wallet accepts for a visitor without a NEAR wallet).
 */
export async function payFromChain(o: Order, assetId: string, refundTo: string) {
  if (DRY || !NEAR) throw new Error('paying from another chain needs the live bank');
  if (o.state !== 'quoted') throw new Error('this job is already paid');
  if (o.intents && ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING'].includes(o.intents.status) && Date.parse(o.intents.deadline) > Date.now()) return o;
  o.intents = await openDeposit(NEAR.bank, NEAR.usdc, o.id, assetId, o.priceUsd, refundTo);
  save(o);
  watchDeposit(o.id);
  return o;
}

const watching = new Set<string>();
/** Poll 1Click until the swap settles; when it does, the bank holds the escrow and the job starts. */
export function watchDeposit(id: string) {
  if (watching.has(id)) return;
  watching.add(id);
  void (async () => {
    try {
      for (let i = 0; i < 400; i++) {
        const o = getOrder(id);
        if (!o?.intents || o.state !== 'quoted') return;
        const s = await depositStatus(o.intents.address, o.intents.memo).catch(() => undefined);
        if (s) {
          const was = o.intents.status;
          Object.assign(o.intents, { status: s.status, txs: s.txs, updatedAt: new Date().toISOString() });
          if (s.status !== was) save(o);
          if (s.status === 'SUCCESS') {
            for (const t of s.txs.filter((x) => x.chain === 'near')) tx(o, `NEAR Intents paid ${o.priceUsd} USDC into escrow`, t.hash);
            save(o);
            for (let k = 0; k < 12 && (await jobState(o.id, 'Funded')) !== 'Funded'; k++) await new Promise((r) => setTimeout(r, 5000));
            await fund(o, false);
            return;
          }
          if (['REFUNDED', 'FAILED'].includes(s.status)) return;
        }
        if (Date.parse(o.intents.deadline) + 3600_000 < Date.now()) return;
        await new Promise((r) => setTimeout(r, i < 60 ? 8000 : 20_000));
      }
    } catch (e: any) {
      const o = getOrder(id);
      if (o?.intents) { o.intents.status = `ERROR: ${String(e?.message ?? e).slice(0, 80)}`; save(o); }
    } finally { watching.delete(id); }
  })();
}
/** After a restart: pick up deposits still in flight. */
/**
 * A job whose work passed the auditor but where a part's filing failed (the lot stayed awarded on chain, so the bank
 * refused the delivery): file the open parts again and submit, while the escrow is still in time. Runs at start.
 */
export async function finishOpenLots() {
  if (DRY || !NEAR) return;
  for (const o of listOrders(200)) {
    if (o.state !== 'failed' || !o.delivery?.check?.pass || !o.lots.some((l) => l.status === 'awarded')) continue;
    const j = await view<{ state: string; deliver_by: string }>(NEAR.bank, 'get_job', { id: o.id }).catch(() => undefined);
    if (!j || j.state !== 'Funded' || Date.now() * 1e6 > Number(j.deliver_by)) continue;
    try {
      o.lots = clean(await closeLots(o.id, o.lots, { steps: o.steps, receipt: o.receipt }, true));
      const stuck = o.lots.filter((l) => l.status === 'awarded');
      if (stuck.length) { o.error = `still could not file ${stuck.map((l) => l.title).join(', ')}: ${stuck[0].error ?? ''}`.slice(0, 200); save(o); continue; }
      tx(o, 'Work submitted to the bank', (await call(NEAR.cfo, NEAR.bank, 'submit_job', { id: o.id, deliverable_hash: sha256(JSON.stringify(o.delivery)) })).hash);
      o.steps = [...o.steps, { at: new Date().toISOString(), agent: 'messenger', kind: 'done', text: 'Delivered. It is waiting for you to accept.' } as any];
      o.state = 'delivered'; o.error = undefined; save(o);
    } catch (e: any) { o.error = String(e?.message ?? e).slice(0, 200); save(o); }
  }
}

export function resumeDeposits() {
  for (const o of listOrders(200)) if (o.state === 'quoted' && o.intents && !['SUCCESS', 'REFUNDED', 'FAILED'].includes(o.intents.status)) watchDeposit(o.id);
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

/**
 * A sub-job an agent just put on the bank for its part (subjobs.ts): already funded from the agent's balance,
 * so it starts at the auction.
 */
export function startSubJob(p: { id: string; parent: string; lot: number; by: string; name: string; input: Record<string, string>; text: string; amount: number; tx: string }) {
  const now = new Date().toISOString();
  const o: Order = {
    id: p.id, service: 'factcheck', input: p.input, brief: p.text, priceUsd: p.amount, customer: p.by, state: 'funded',
    createdAt: now, updatedAt: now, txs: [], lots: [], steps: [], receipt: [], parent: { id: p.parent, lot: p.lot, by: p.by },
  };
  tx(o, `Posted by ${p.name} for its part of job ${p.parent}, paid from its own balance`, p.tx);
  save(o);
  void run(o);
  return o;
}

/** Records a sub-job on the job it was hired for. */
export function noteSub(parentId: string, s: NonNullable<Order['subs']>[number], name: string) {
  const o = getOrder(parentId);
  if (!o) return;
  o.subs = [...(o.subs ?? []), s];
  tx(o, `${name} hired a ${s.title.toLowerCase()} for ${s.amount} USDC from its own balance`, s.tx);
  save(o);
}

/** The agent that hired a sub-job accepted it on the bank. */
export function markAccepted(o: Order, what: string, hash: string) {
  tx(o, what, hash);
  o.state = 'accepted';
  save(o);
}

/** Auction, work, inspect, submit. */
async function run(o: Order) {
  const svc = findService(o.service)!;
  try {
    o.state = 'bidding'; save(o);
    // an auction is two short windows per lot; one that runs this long has lost a call, and the customer should be told
    const lots = await timed(auction(o.id, o.service, o.priceUsd, o.private ? undefined : o.brief), AUCTION_MAX_MS, 'the auction')
      .catch((e) => { throw new Error(/^timeout/.test(String(e?.message)) ? 'The bidding stalled, so the job was stopped. The bank refunds the full price once the delivery deadline passes.' : String(e?.message ?? e)); });
    o.lots = clean(lots);
    o.state = 'working'; save(o);
    const job = new Job(o.id, o.service, { budgetUsd: o.priceUsd * 0.5, allowHosts: [NEARAI_HOST] }, assignmentFor(o.id));
    for (const line of takePricing(o.id)) job.receipt.push(line); // the agents' own pricing calls, billed to each with the job
    let d: Delivery | undefined, err: string | undefined;
    try { d = await svc.run(job, o.input); } catch (e: any) { err = String(e?.message ?? e).slice(0, 200); job.log('cfo', 'error', err); }
    const pass = !!d?.check.pass;
    // when the auditor stops a job, the check did its work; when a part breaks, the parts that never ran did nothing wrong
    const culprit = err && /^([a-z]+(?:-\d)?):/.exec(err)?.[1];
    const spare = (l: LotRecord) => d && l.roles.includes('auditor') ? 'caught the problem that stopped the job'
      : culprit && !l.roles.includes(culprit as any) && l.winnerRole !== culprit ? `never ran: the job stopped at ${culprit}` : undefined;
    o.lots = clean(await closeLots(o.id, lots, job, pass, spare));
    o.steps = job.steps; o.receipt = job.receipt;
    if (!d || !pass) {
      o.state = 'failed'; o.error = err ?? `The auditor stopped it: ${d!.check.notes.join('; ')}`;
      if (d) o.delivery = strip(o.id, d);
      save(o);
      return;
    }
    o.delivery = strip(o.id, d);
    const stuck = o.lots.filter((l) => l.status === 'awarded');
    if (stuck.length) throw new Error(`${stuck.map((l) => `${l.title} could not be filed (${l.error ?? 'unknown'})`).join('; ')}`.slice(0, 200));
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
    if (o.customer === DEMO_PAYER) tx(o, 'Accepted; escrow released to the winners', (await call(o.customer, NEAR!.bank, 'accept', { id: o.id }, { tgas: tg(40, 150) })).hash);
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
    tx(o, 'Not delivered in time; the full price refunded', (await call(NEAR.cfo, NEAR.bank, 'refund_late', { id: o.id }, { tgas: tg(30, 60) })).hash);
    o.refunded = true;
    if (o.state !== 'failed') { o.state = 'failed'; o.error = 'The team did not deliver in time.'; }
    save(o);
    did.push(`refunded job ${o.id}: not delivered by its deadline`);
  }
  return did;
}
