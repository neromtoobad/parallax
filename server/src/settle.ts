// After a job, each agent that ran model calls pays its own bill: one pay_bill call on the bank, from its
// balance there to the compute account, for exactly what its receipt lines add up to. The bank holds
// these bills to the policy's daily model cap.
import { DRY } from './config.ts';
import type { Job } from './job.ts';
import { forgetBalance, markPaid } from './meter.ts';
import { NEAR, payBill, txUrl } from './near/chain.ts';
import { publish } from './bus.ts';
import { nameOf } from './wallets.ts';

export async function settleBills(job: Job) {
  const owed = new Map<string, number>();
  for (const r of job.receipt) if (!r.dry && r.account && !r.settledTx) owed.set(r.account, (owed.get(r.account) ?? 0) + r.usd);
  if (DRY || !NEAR?.compute) return [];
  const paid: { account: string; usd: number; tx: string }[] = [];
  for (const [account, raw] of owed) {
    const usd = Math.ceil(raw * 1e6) / 1e6;
    if (usd <= 0) continue;
    try {
      const { hash } = await payBill(account, usd, `model calls, job ${job.orderId}`);
      markPaid(account, usd);
      forgetBalance(account);
      for (const r of job.receipt) if (r.account === account && !r.dry) Object.assign(r, { settledTx: hash, settledAt: new Date().toISOString() });
      paid.push({ account, usd, tx: hash });
      publish({ type: 'bill', orderId: job.orderId, data: { agent: nameOf(account), usd, tx: hash, url: txUrl(hash) } });
    } catch (e: any) {
      publish({ type: 'bill', orderId: job.orderId, data: { agent: nameOf(account), usd, error: String(e?.message ?? e).slice(0, 120) } });
    }
  }
  return paid;
}
