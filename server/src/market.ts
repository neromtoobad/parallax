// The NEAR Agent Market (market.near.ai): outside agents that can bid against the team.
//
// When the CFO opens a job's Research lot, it looks up research agents on the market, reads each one's
// default price (free), and scores its quality from its delivery record. A quote at or under the lot's
// reserve is entered on the bank with add_outside, so the bank's Vickrey award weighs it against the
// team's sealed bids by price per unit of quality. An outside winner is hired over A2A and paid by x402:
// one delegated USDC ft_transfer on NEAR mainnet, signed here and relayed by the market, charged only
// when the agent delivers. Its report goes to the team as research notes, and the CFO files it on the
// bank with deliver_outside and the payment receipt.
//
// Quotes cost nothing and are always shown. Entering a quote (so an outside agent can win) needs hiring
// turned on, because a win is a real mainnet payment: PARALLAX_MARKET_HIRE=1, a mainnet payer account with
// USDC (MARKET_PAYER and its key in MARKET_PAYER_KEY), a per-hire cap (MARKET_MAX_USD, default 1) and a
// daily cap (MARKET_DAY_USD, default 3). Nothing is signed outside those caps.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPairSigner, actions, encodeSignedDelegate, type KeyPairString } from 'near-api-js';
import { DATA_DIR } from './config.ts';
import { useSearch, type SearchHit } from './tools.ts';
import type { Job } from './job.ts';
import type { Role } from './wallets.ts';
import { qualityBps } from './auction.ts';

export const MARKET = process.env.MARKET_API ?? 'https://market.near.ai/v1';
/** Native USDC on NEAR mainnet: the only asset a hire is paid in. */
export const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const HIRE_ON = process.env.PARALLAX_MARKET_HIRE === '1';
const PAYER = process.env.MARKET_PAYER ?? '';
const MAX_USD = Number(process.env.MARKET_MAX_USD ?? 1);
const DAY_USD = Number(process.env.MARKET_DAY_USD ?? 3);
const MAINNET_RPC = process.env.NEAR_MAINNET_RPC ?? 'https://rpc.mainnet.fastnear.com';

/** Whether an outside agent may win a lot: only when a win can actually be paid for. */
export const canHire = () => HIRE_ON && !!PAYER && !!process.env.MARKET_PAYER_KEY;
export const hireStatus = () => ({ on: canHire(), payer: PAYER || null, maxUsd: MAX_USD, dayUsd: DAY_USD, spentToday: ledger().day === today() ? ledger().spent : 0 });

export type MarketAgent = {
  id: string; handle: string; name: string; category: string; available: boolean;
  slaSecs: number | null; delivered: number; successPct: number | null;
};
export type Quote = { handle: string; name: string; priceUsd: number; qualityBps: number; ref: string; delivered: number; successPct: number | null };

async function getJson<T>(url: string, ms = 8000): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json() as Promise<T>;
}

/** Agents on the market for a query, best delivery record first. */
export async function searchAgents(q: string, opts: { category?: string; limit?: number } = {}): Promise<MarketAgent[]> {
  const u = new URL(`${MARKET}/agents`);
  u.searchParams.set('q', q);
  u.searchParams.set('sort', 'delivered');
  u.searchParams.set('limit', String(opts.limit ?? 12));
  if (opts.category) u.searchParams.set('category', opts.category);
  const d = await getJson<{ agents: any[] }>(u.toString());
  return (d.agents ?? []).map((a) => ({
    id: a.agent_id, handle: a.handle, name: a.name, category: a.category, available: !!a.available_now,
    slaSecs: a.sla_seconds ?? null, delivered: Number(a.delivered_jobs ?? 0), successPct: a.success_rate ?? null,
  }));
}

/** An agent's default price per call in USD, from its live pricing plan. */
export async function priceOf(agentId: string): Promise<number | undefined> {
  const plans = await getJson<any[]>(`${MARKET}/agents/${agentId}/pricing-plans`);
  const p = plans.find((x) => x.is_default && x.listing_status === 'live') ?? plans.find((x) => x.listing_status === 'live');
  const usd = Number(p?.price_amount);
  return p?.model === 'per_call' && usd > 0 ? usd : undefined;
}


/** Quotes from research agents that take calls now, cheapest per unit of quality first. */
export async function researchQuotes(topic: string, max = 4): Promise<Quote[]> {
  const found = new Map<string, MarketAgent>();
  for (const q of ['research brief', topic.slice(0, 60)]) {
    for (const a of await searchAgents(q, { category: 'research' }).catch(() => [])) if (a.available) found.set(a.handle, a);
  }
  const quotes: Quote[] = [];
  for (const a of [...found.values()].slice(0, 10)) {
    const usd = await priceOf(a.id).catch(() => undefined);
    if (usd === undefined) continue;
    quotes.push({ handle: a.handle, name: a.name, priceUsd: usd, qualityBps: qualityBps(a.delivered, a.successPct), ref: endpoint(a.handle), delivered: a.delivered, successPct: a.successPct });
  }
  return quotes.sort((x, y) => x.priceUsd / x.qualityBps - y.priceUsd / y.qualityBps).slice(0, max);
}

const endpoint = (handle: string) => `https://${handle}.market.near.ai/a2a/v1`;

// ---------- hiring (A2A + x402, NEAR mainnet)

export type Hire = {
  handle: string; taskId: string; state: string; text: string;
  paid: { usd: number; payTo: string; asset: string; payer: string; network: string } | null;
  at: string;
};

type Ledger = { day: string; spent: number; hires: (Omit<Hire, 'text'> & { orderId?: string; chars: number })[] };
const today = () => new Date().toISOString().slice(0, 10);
const ledgerFile = () => join(DATA_DIR, 'market.json');
function ledger(): Ledger {
  try { return JSON.parse(readFileSync(ledgerFile(), 'utf8')); } catch { return { day: today(), spent: 0, hires: [] }; }
}
function book(h: Hire, orderId?: string) {
  const l = ledger();
  if (l.day !== today()) Object.assign(l, { day: today(), spent: 0 });
  l.spent = Math.round((l.spent + (h.paid?.usd ?? 0)) * 1e6) / 1e6;
  const { text, ...rest } = h;
  l.hires.push({ ...rest, orderId, chars: text.length });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ledgerFile(), JSON.stringify(l, null, 2));
}

async function rpc(handle: string, method: string, params: object, xPayment?: string) {
  const r = await fetch(endpoint(handle), {
    method: 'POST', signal: AbortSignal.timeout(75_000),
    headers: { 'content-type': 'application/json', ...(xPayment ? { 'X-PAYMENT': xPayment } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body: any = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

let payer: Account | undefined;
function payerAccount(): Account {
  if (!payer) payer = new Account(PAYER, new JsonRpcProvider({ url: MAINNET_RPC }), KeyPairSigner.fromSecretKey(process.env.MARKET_PAYER_KEY as KeyPairString));
  return payer;
}

/** The x402 payment for a 402 row: one delegated ft_transfer of the asked amount, relayed by the market. */
async function payment(row: any): Promise<string> {
  const { signedDelegate } = await payerAccount().createSignedMetaTransaction({
    receiverId: row.asset,
    blockHeightTtl: Number(row.maxTimeoutSeconds ?? 300),
    actions: [actions.functionCall('ft_transfer', { receiver_id: row.payTo, amount: row.amount }, 30_000_000_000_000n, 1n)],
  });
  const payload = { signedDelegateAction: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') };
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload })).toString('base64');
}

const textOf = (task: any) => (task?.artifacts ?? []).flatMap((a: any) => a.parts ?? []).map((p: any) => p.text ?? '').join('\n').trim();
const DONE = /COMPLETED/i, FAILED = /FAILED|REJECTED|CANCELED/i;

/**
 * Hire an agent for one task. The first call is free and answers with the price (402); the payment is
 * signed only if that price is within what was quoted and inside the caps, and is charged on delivery.
 */
export async function hire(handle: string, task: string, quotedUsd: number, orderId?: string): Promise<Hire> {
  if (!canHire()) throw new Error('hiring on the Agent Market is off (PARALLAX_MARKET_HIRE, MARKET_PAYER, MARKET_PAYER_KEY)');
  const message = { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: task }] }, configuration: { historyLength: 0 } };
  const ask = await rpc(handle, 'SendMessage', message);
  if (ask.status !== 402) throw new Error(`${handle}: expected a price (402), got ${ask.status} ${JSON.stringify(ask.body?.error ?? '').slice(0, 120)}`);
  const row = (ask.body?.accepts ?? []).find((a: any) => a.network === 'near:mainnet' && a.asset === MAINNET_USDC);
  if (!row) throw new Error(`${handle} doesn't take USDC on NEAR`);
  const usd = Number(row.amount) / 1e6;
  const l = ledger(), spent = l.day === today() ? l.spent : 0;
  if (usd > quotedUsd + 1e-6) throw new Error(`${handle} asks ${usd} USDC, above its quote of ${quotedUsd}`);
  if (usd > MAX_USD) throw new Error(`${handle} asks ${usd} USDC, above the per-hire cap of ${MAX_USD}`);
  if (spent + usd > DAY_USD) throw new Error(`a ${usd} USDC hire would pass today's cap of ${DAY_USD} (spent ${spent})`);

  const paid = await rpc(handle, 'SendMessage', { ...message, message: { ...message.message, messageId: randomUUID() } }, await payment(row));
  if (paid.body?.error) throw new Error(`${handle}: ${paid.body.error.code} ${String(paid.body.error.message).slice(0, 120)}`);
  let t = paid.body?.result?.task ?? paid.body?.result;
  const id = String(t?.id ?? '');
  for (let i = 0; i < 60 && id && !DONE.test(t?.status?.state ?? '') && !FAILED.test(t?.status?.state ?? ''); i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    t = (await rpc(handle, 'GetTask', { id })).body?.result?.task ?? t;
  }
  const state = String(t?.status?.state ?? 'unknown');
  const h: Hire = { handle, taskId: id, state, text: textOf(t), paid: DONE.test(state) ? { usd, payTo: row.payTo, asset: row.asset, payer: PAYER, network: row.network } : null, at: new Date().toISOString() };
  book(h, orderId);
  if (!DONE.test(state)) throw new Error(`${handle} ended in ${state}; nothing was charged`);
  return h;
}

/** The receipt the CFO files on the bank with an outside agent's work. */
export const receiptOf = (h: Hire) => JSON.stringify({ market: 'market.near.ai', handle: h.handle, task: h.taskId, ...h.paid });

// ---------- web search through a market agent (MARKET_SEARCH_HANDLE), one paid call per search

const SEARCH_HANDLE = process.env.MARKET_SEARCH_HANDLE;
const SEARCH_USD = Number(process.env.MARKET_SEARCH_USD ?? 0.1);
/** Web search goes through a market agent when one is set up (api.ts calls this at start). */
export function registerSearch() {
  if (!SEARCH_HANDLE || !canHire()) return;
  useSearch(async (job: Job, agent: Role, q: string, reason: string, n: number): Promise<SearchHit[]> => {
    job.log(agent, 'hire', `${SEARCH_HANDLE} on the Agent Market: ${reason}`);
    const h = await hire(SEARCH_HANDLE, `Search the web for: ${q}\nReturn only JSON: {"results":[{"title":"","link":"","snippet":""}]} with up to ${n} results.`, SEARCH_USD, job.orderId);
    const m = h.text.match(/\{[\s\S]*\}/);
    const hits: SearchHit[] = m ? (JSON.parse(m[0]).results ?? []) : [];
    return hits.filter((x) => /^https?:\/\//.test(String(x.link))).slice(0, n);
  });
}
export const searchOn = () => !!SEARCH_HANDLE && canHire();

