// buy(): the only way a Parallax agent spends money. On NEAR the team's paid tools are NEAR AI Cloud
// models (and Agent Market hires, see market.ts). Before a call: the host must be on the job's
// allowlist, the job's budget must cover it, and the agent's own NEAR account must hold enough USDC.
// After it: the measured cost becomes a receipt line booked to that agent. settle.ts then has each
// agent pay what it used from its own account to the compute account, one transfer per agent per job,
// and writes that transaction onto the receipt lines. No receipt, no spend.
import { DRY } from './config.ts';
import { NEARAI_HOST, nearaiKey } from './nearai.ts';
import { NEAR, usdcOf } from './near/chain.ts';
import { type Role } from './wallets.ts';
import type { Job } from './job.ts';

export type ReceiptLine = {
  at: string;
  agent: Role;
  vendor: string;
  url: string;
  amount: string; // USDC atomic units (6 decimals), as a string
  usd: number;
  transaction: string; // the provider's reference for the call (a completion id)
  reason: string;
  status: number;
  dry: boolean;
  account?: string; // the NEAR account that pays for it (a lot's winner may not be the role's own account)
  settledTx?: string; // the NEAR transaction in which the agent paid for it (filled in by settle.ts)
  settledAt?: string;
};

export class SpendRefused extends Error {}
/** The agent's own account can't cover the call. Callers may fall back to a cheaper model. */
export class NoWalletFunds extends SpendRefused {}

const TRANSIENT = /timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up|\b(429|502|503|504)\b|rate limit|overloaded/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What each agent has used but not paid yet, so two calls can't both spend the same balance.
const unpaid = new Map<string, number>();
export const unpaidUsd = (account: string) => unpaid.get(account) ?? 0;
export function markPaid(account: string, usd: number) { unpaid.set(account, Math.max(0, unpaidUsd(account) - usd)); }

const balances = new Map<string, { usd: number; at: number }>();
/** An agent's USDC on NEAR (cached 20 s). */
export async function walletUsdc(id: string): Promise<number> {
  const hit = balances.get(id);
  if (hit && Date.now() - hit.at < 20_000) return hit.usd;
  const usd = await usdcOf(id);
  balances.set(id, { usd, at: Date.now() });
  return usd;
}
export const forgetBalance = (account: string) => balances.delete(account);

/** Request headers for a host we pay by account: NEAR AI takes the founder's API key. */
function auth(host: string): Record<string, string> {
  if (host === NEARAI_HOST) {
    const key = nearaiKey();
    if (!key) throw new SpendRefused('NEAR AI Cloud has no API key yet (set NEARAI_API_KEY)');
    return { authorization: `Bearer ${key}` };
  }
  throw new SpendRefused(`${host} is not a seller the team pays on NEAR`);
}

export async function buy<T>(
  job: Job,
  opts: {
    agent: Role;
    vendor: string;
    url: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    reason: string;
    maxUsd: number; // hard cap for this single call
    expectUsd: number; // listed price, used for budgeting, the wallet check and dry runs
    dryData: () => T;
    cost?: (data: any) => Promise<number | undefined> | number | undefined; // measured cost of the call
    form?: FormData; // multipart body instead of JSON
  },
): Promise<T> {
  const account = job.payer(opts.agent); // the lot's winner does, and pays for, its part of the job
  opts = { ...opts, agent: job.who(opts.agent) };
  const host = new URL(opts.url).host;
  if (!job.policy.allowHosts.includes(host)) throw new SpendRefused(`${opts.agent}: ${host} is not on the allowlist for ${job.service}`);
  if (job.spentUsd() + opts.expectUsd > job.policy.budgetUsd) {
    throw new SpendRefused(`${opts.agent}: job budget ${job.policy.budgetUsd} USDC would be exceeded`);
  }

  if (DRY) {
    // test hook: OUTLAY_DRY_FAIL="NEAR AI" makes that vendor fail like a provider that is down
    if (process.env.OUTLAY_DRY_FAIL && opts.vendor.includes(process.env.OUTLAY_DRY_FAIL)) throw new Error('provider unavailable, please retry');
    const delay = Number(process.env.OUTLAY_DRY_DELAY ?? 0);
    if (delay) await sleep(delay * (0.6 + Math.random() * 0.8));
    const data = opts.dryData();
    job.addReceipt({
      at: new Date().toISOString(), agent: opts.agent, vendor: opts.vendor, url: opts.url,
      amount: String(Math.round(opts.expectUsd * 1e6)), usd: opts.expectUsd, transaction: 'dry-run',
      reason: opts.reason, status: 200, dry: true,
    });
    return data;
  }

  const headers = auth(host);
  if (NEAR) {
    const have = (await walletUsdc(account)) - unpaidUsd(account);
    if (have < opts.expectUsd) throw new NoWalletFunds(`${account} holds ${Math.max(0, have).toFixed(3)} USDC on NEAR; this call needs about ${opts.expectUsd.toFixed(3)}`);
  }

  let res: Response | undefined, data: any;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(opts.url, {
        method: opts.method ?? 'POST',
        headers: opts.form ? headers : { ...headers, 'content-type': 'application/json' },
        body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
        signal: AbortSignal.timeout(300_000),
      });
      data = await res.json().catch(() => undefined);
      if (res.ok) break;
      const msg = `${res.status} ${String(data?.error?.message ?? data?.error ?? data?.message ?? '').slice(0, 160)}`;
      if (attempt >= 3 || !TRANSIENT.test(msg)) throw new Error(`${opts.vendor}: ${msg}`);
    } catch (e: any) {
      if (attempt >= 3 || !TRANSIENT.test(String(e?.message ?? e))) throw e;
    }
    job.log(opts.agent, 'retry', `${opts.vendor}: busy, trying again`);
    await sleep(attempt * 2500);
  }

  const measured = await opts.cost?.(data);
  const usd = Math.min(opts.maxUsd, measured ?? opts.expectUsd);
  unpaid.set(account, unpaidUsd(account) + usd);
  job.addReceipt({
    at: new Date().toISOString(), agent: opts.agent, vendor: opts.vendor, url: opts.url,
    amount: String(Math.round(usd * 1e6)), usd, transaction: String(data?.id ?? data?.created ?? 'call'),
    reason: opts.reason, status: res!.status, dry: false, account,
  });
  return data as T;
}
