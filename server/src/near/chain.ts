// NEAR: accounts, keys, signed calls and reads for Parallax's bank, its USDC and its agents.
//
// The deployment (accounts and contracts) is deployments/near-<net>.json, net = PARALLAX_NEAR_NET
// (default testnet; empty in demo mode, which turns everything on-chain off), or the file PARALLAX_DEPLOYMENT.
//
// Keys never live in this repo. Each account's key comes from PARALLAX_NEAR_KEYS (a JSON object
// { account: "ed25519:…" }, for hosting) or from the near-cli keychain in ~/.near-credentials/<net>.
// The CFO, the agents and the house wallet sign with function-call keys that can only call the bank
// (<account>.bank-key.json): no call of theirs attaches a deposit, so none of them needs a full-access key.
// Enlisted agents (<slug>.<crew>) have no keys of their own: the crew operator signs for them (act()).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, baseEncode, encodeTransaction, type KeyPairString } from 'near-api-js';
import { DRY } from '../config.ts';

export const NET = process.env.PARALLAX_NEAR_NET ?? (DRY ? '' : 'testnet');

export type Deployment = {
  network: 'testnet' | 'mainnet';
  rpc: string;
  rpcFallbacks?: string[];
  explorer: string;
  owner: string;
  bank: string;
  usdc: string;
  usdcFaucet?: boolean;
  cfo: string;
  contributors: string;
  compute?: string; // receives what agents pay for their model calls
  house?: string; // pays for demo jobs; hired by the bank so the CFO can top it up
  crew?: string; // the crew operator, which signs for enlisted agents named <slug>.<crew>
  team: Record<string, string>;
};

function load(): Deployment | null {
  if (!NET) return null;
  const f = process.env.PARALLAX_DEPLOYMENT ?? new URL(`../../../deployments/near-${NET}.json`, import.meta.url).pathname;
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}
export const NEAR = load();

const RPCS = NEAR ? [process.env.NEAR_RPC ?? NEAR.rpc, ...(NEAR.rpcFallbacks ?? [])] : [];
let rpcAt = 0;
let provider = RPCS.length ? new JsonRpcProvider({ url: RPCS[0] }) : (null as unknown as JsonRpcProvider);
/** Move to the next public RPC when one fails or rate-limits. */
function rotate() {
  rpcAt = (rpcAt + 1) % RPCS.length;
  provider = new JsonRpcProvider({ url: RPCS[rpcAt] });
  accounts.clear();
}
export const rpc = () => provider;

export const USDC = 1e6; // 6 decimals
export const toUnits = (usd: number) => BigInt(Math.round(usd * USDC)).toString();
export const fromUnits = (u: string | number | bigint) => Number(u) / USDC;
const TGAS = 1_000_000_000_000n;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const txUrl = (hash: string) => `${NEAR?.explorer}/txns/${hash}`;
export const accountUrl = (id: string) => `${NEAR?.explorer}/address/${id}`;

/** A NEAR account id (implicit 64-hex, or named like ada.testnet / ada.near). */
export const isAccountId = (s: string) =>
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s) && s.length >= 2 && s.length <= 64;

// ---------------------------------------------------------------- keys

const fromEnv: Record<string, string> = (() => {
  try { return JSON.parse(process.env.PARALLAX_NEAR_KEYS ?? '{}'); } catch { return {}; }
})();

function keyFile(account: string): string | null {
  const dir = join(homedir(), '.near-credentials', NEAR?.network ?? 'testnet');
  for (const f of [`${account}.bank-key.json`, `${account}.json`]) {
    const p = join(dir, f);
    if (existsSync(p)) return p;
  }
  return null;
}

export function hasKey(account: string) {
  return !!fromEnv[account] || !!keyFile(account);
}

/** An agent someone enlisted: named under the crew operator, which signs for it. */
export const isCrew = (account: string) => !!NEAR?.crew && account.endsWith(`.${NEAR.crew}`);
/** Whether we can sign for an agent: with its own key, or the operator's for an enlisted one. */
export const canSign = (account: string) => (isCrew(account) ? hasKey(NEAR!.crew!) : hasKey(account));
/** An agent's call on the bank: from its own account, or crew_<method> from the operator for an enlisted agent. */
export const act = (agent: string, method: string, args: Record<string, unknown>, o: { tgas?: number } = {}) =>
  isCrew(agent) ? call(NEAR!.crew!, NEAR!.bank, `crew_${method}`, { agent, ...args }, o) : call(agent, NEAR!.bank, method, args, o);

function keyOf(account: string): KeyPairString {
  if (fromEnv[account]) return fromEnv[account] as KeyPairString;
  const f = keyFile(account);
  if (!f) throw new Error(`No key for ${account}: add it to PARALLAX_NEAR_KEYS or ~/.near-credentials`);
  return JSON.parse(readFileSync(f, 'utf8')).private_key;
}

/** Sign bytes with an account's key (the CFO signs its decision log this way). */
export function signWith(account: string, data: Uint8Array): { sig: string; publicKey: string } {
  const kp = KeyPair.fromString(keyOf(account));
  return { sig: Buffer.from(kp.sign(data).signature).toString('hex'), publicKey: kp.getPublicKey().toString() };
}
export const verifySig = (publicKey: string, data: Uint8Array, sigHex: string) => {
  try { return PublicKey.fromString(publicKey).verify(data, Buffer.from(sigHex, 'hex')); } catch { return false; }
};

/** The public keys an account has on chain. */
export async function keysOf(id: string): Promise<string[]> {
  const r: any = await (provider as any).viewAccessKeyList({ accountId: id, blockQuery: { finality: 'optimistic' } }).catch(() => null);
  return (r?.keys ?? []).map((k: any) => k.public_key);
}

const accounts = new Map<string, Account>();
function account(id: string): Account {
  let a = accounts.get(id);
  if (!a) accounts.set(id, (a = new Account(id, provider, keyOf(id))));
  return a;
}

// ---------------------------------------------------------------- writes

export class ChainError extends Error {}

export type Sent = { hash: string; block: number; value?: any; logs: string[] };

const queues = new Map<string, Promise<unknown>>();
/** One transaction at a time per signer, so nonces never collide. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

let seenHeight = 0;

/**
 * Call a contract method as `signer`. A panic in the contract becomes a ChainError with its message.
 * The transaction is signed here, so its hash is known before it is sent: when a node errors after the
 * send (public RPCs time out on cross-contract calls), we look the hash up instead of guessing, and only
 * sign again when the chain has never seen it. That is what keeps a flaky node from paying twice.
 * The signer must hold the whole prepaid gas up front (about 0.001 NEAR per Tgas, mostly refunded), so each
 * call asks for what it needs rather than the most it could: 30 Tgas unless it says otherwise.
 */
export function call(signer: string, contract: string, method: string, args: object, o: { deposit?: bigint; tgas?: number } = {}): Promise<Sent> {
  return serial(signer, async () => {
    for (let attempt = 0; ; attempt++) {
      let hash: string | undefined;
      try {
        const signed = await account(signer).createSignedTransaction({
          receiverId: contract, actions: [actions.functionCall(method, args, BigInt(o.tgas ?? 30) * TGAS, o.deposit ?? 0n)],
        });
        hash = baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest());
        await rpc().sendTransactionUntil(signed, 'INCLUDED').catch((e: any) => {
          const m = String(e?.message ?? e);
          if (/NotEnoughBalance|Not enough balance/i.test(m)) throw new ChainError(`${signer} has too little NEAR to cover this call's gas (${o.tgas ?? 30} Tgas needs about ${((o.tgas ?? 30) / 1000).toFixed(3)} NEAR free)`);
          if (/panicked|InvalidNonce|expired|LackBalanceForState|InvalidAccessKey|DoesNotFitStorage/i.test(m)) throw e;
          // anything else: the node may still have taken it; the status lookup below decides
        });
        const r = await outcome(hash, signer);
        if (!r) throw new Error(`transaction ${hash} was never seen on chain (expired)`);
        const logs: string[] = [r.transaction_outcome, ...r.receipts_outcome].flatMap((x: any) => x.outcome?.logs ?? []);
        const failure = r.receipts_outcome.find((x: any) => x.outcome?.status?.Failure)?.outcome.status.Failure;
        if (failure) throw new ChainError(panicText(failure));
        const ok = r.status?.SuccessValue;
        const block = await heightOf(r.receipts_outcome.at(-1)?.block_hash);
        return { hash, block, logs, value: ok ? JSON.parse(Buffer.from(ok, 'base64').toString()) : undefined };
      } catch (e: any) {
        if (e instanceof ChainError) throw e;
        const m = /Smart contract panicked: (.*)/.exec(String(e?.message ?? e));
        if (m) throw new ChainError(m[1]);
        // Never seen on chain, an old nonce, or a node down before sending: sign again, on another RPC, a few times.
        if (attempt >= 3 || !/never seen|expired|timeout|fetch failed|429|50\d|ECONNRESET|InvalidNonce|Internal server/i.test(String(e?.message ?? e))) throw e;
        rotate();
        await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
      }
    }
  });
}

/** A sent transaction's final outcome, asking each RPC in turn; null when the chain has no record of it. */
async function outcome(hash: string, sender: string): Promise<any | null> {
  const until = Date.now() + 90_000;
  for (let i = 0; Date.now() < until; i++) {
    try {
      return await (provider as any).viewTransactionStatus({ txHash: hash, accountId: sender, waitUntil: 'FINAL' });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // unknown after a while means it never landed (or expired); keep asking while the node is merely slow
      if (/UNKNOWN_TRANSACTION|doesn't exist|not found/i.test(msg) && i >= 8) return null;
      if (i % 2) rotate();
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  return null;
}

function panicText(f: any): string {
  const s = JSON.stringify(f);
  return /Smart contract panicked: ([^"\\]*)/.exec(s)?.[1] ?? s.slice(0, 300);
}

async function heightOf(blockHash?: string): Promise<number> {
  if (!blockHash) return 0;
  for (let i = 0; i < 20; i++) {
    try {
      const b = await provider.viewBlock({ blockId: blockHash });
      seenHeight = Math.max(seenHeight, b.header.height);
      return b.header.height;
    } catch {
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }
  return 0;
}

// ---------------------------------------------------------------- reads

/** A view call that sees our own last write (public RPCs are load-balanced, a node can lag a block). */
export async function view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const r: any = await provider.callFunctionRaw({ contractId: contract, method, args, blockQuery: { finality: 'optimistic' } });
      if (r.block_height >= seenHeight || i >= 20) return JSON.parse(Buffer.from(r.result).toString()) as T;
      await new Promise((ok) => setTimeout(ok, 250));
    } catch (e: any) {
      if (i >= 3) throw e;
      rotate();
    }
  }
}

/** The chain's clock, in seconds. Deadlines are judged by block time, not the server's. */
export async function chainNow(): Promise<number> {
  const b = await provider.viewBlock({ finality: 'optimistic' });
  return Math.floor(Number(b.header.timestamp) / 1e9);
}

export async function nearBalance(id: string): Promise<number> {
  try {
    const a: any = await provider.viewAccount({ accountId: id, blockQuery: { finality: 'optimistic' } } as any);
    return Number(BigInt(a.amount) / 10n ** 18n) / 1e6;
  } catch {
    return 0;
  }
}

/**
 * NEAR the bank holds beyond what its code and state lock up. Every job's lots stay in its state for good (about
 * 3 KB, 0.03 NEAR a job), so when this runs out the bank can't store a new lot and an order would fail halfway.
 * Read at most once a minute.
 */
let room = { at: 0, near: Infinity };
export async function bankRoom(): Promise<number> {
  if (!NEAR || Date.now() - room.at < 60_000) return room.near;
  try {
    const a: any = await provider.viewAccount({ accountId: NEAR.bank, blockQuery: { finality: 'optimistic' } } as any);
    const free = Number((BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n) / 10n ** 18n) / 1e6;
    room = { at: Date.now(), near: free };
    if (free < 0.5) console.warn(`bank: only ${free.toFixed(3)} NEAR left for storage; send NEAR to ${NEAR.bank}`);
  } catch { /* keep the last reading */ }
  return room.near;
}
/** Below this the CFO takes no new work: enough for a job or two in flight to finish. */
export const ROOM_MIN = 0.08;

export async function usdcOf(id: string): Promise<number> {
  return fromUnits(await view<string>(NEAR!.usdc, 'ft_balance_of', { account_id: id }));
}

/** What an agent (or the house wallet) holds inside the bank. */
export async function balanceOf(id: string): Promise<number> {
  return fromUnits(await view<string>(NEAR!.bank, 'balance_of', { account: id }));
}

/** Logs from a transaction someone else sent (a customer's wallet), with its outcome. */
export async function txLogs(hash: string, sender: string): Promise<{ ok: boolean; logs: string[]; block: number } | null> {
  try {
    const r: any = await (provider as any).viewTransactionStatus({ txHash: hash, accountId: sender, waitUntil: 'EXECUTED_OPTIMISTIC' });
    const logs: string[] = r.receipts_outcome.flatMap((x: any) => x.outcome?.logs ?? []);
    const ok = !r.receipts_outcome.some((x: any) => x.outcome?.status?.Failure);
    return { ok, logs, block: await heightOf(r.receipts_outcome.at(-1)?.block_hash) };
  } catch {
    return null;
  }
}

/** Parse NEP-297 events ("EVENT_JSON:…") of the parallax standard out of logs. */
export function events(logs: string[], name?: string): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = [];
  for (const l of logs) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(l.slice(11));
      if (e.standard !== 'parallax' || (name && e.event !== name)) continue;
      for (const d of e.data ?? []) out.push({ event: e.event, data: d });
    } catch { /* not ours */ }
  }
  return out;
}

// ---------------------------------------------------------------- USDC

/** An agent pays a model bill from its balance at the bank; the bank sends it to the compute account. */
export const payBill = (agent: string, usd: number, memo: string) =>
  act(agent, 'pay_bill', { amount: toUnits(usd), memo: memo.slice(0, 120) }, { tgas: 40 });

/** Send USDC into the bank with a message (a deposit, or `job:<id>` to fund a job). */
export const payBank = (from: string, usd: number, msg: string) =>
  call(from, NEAR!.usdc, 'ft_transfer_call', { receiver_id: NEAR!.bank, amount: toUnits(usd), msg }, { deposit: 1n, tgas: 80 });
