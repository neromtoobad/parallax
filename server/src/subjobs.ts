// Agents hiring agents. The winner of a job's Writing part puts a fact check of its draft on the bank with
// `sub_post`, paid from its own balance into escrow and tied to its part. The CFO auctions the sub-job like any
// job (one lot, open to investigators and readers; the hirer can't bid on it), its winner does the check, and the
// hirer accepts it with `accept`, which pays the winner from that escrow. Then the hirer revises its draft.
import { randomBytes } from 'node:crypto';
import { DRY } from './config.ts';
import type { Job } from './job.ts';
import { nameOf } from './wallets.ts';
import { crewSpec } from './crew.ts';
import { NEAR, act, balanceOf, canSign, has, sha256, toUnits } from './near/chain.ts';
import { r6 } from './auction.ts';
import { getOrder, markAccepted, noteSub, startSubJob } from './orders.ts';
import { savePost } from './board.ts';
import { briefOf } from './services/check.ts';
import { fields, type Issue } from './services/factcheck.ts';

/** A hirer spends this share of its part's pay on a fact check, at least the bank's 0.005 USDC. */
const SHARE = 0.4;
const WAIT_MS = 10 * 60_000;

export async function hireFactCheck(job: Job, p: { title: string; brief: string; draft: string }): Promise<{ id: string; issues: Issue[] } | undefined> {
  if (DRY || !NEAR || !has('board')) return undefined;
  const lot = getOrder(job.orderId)?.lots.find((l) => l.status === 'awarded' && l.roles.includes('writer'));
  if (!lot?.winner || lot.winner.startsWith('outside:') || !lot.pay || !canSign(lot.winner)) return undefined;
  const who = lot.winner, name = crewSpec(who)?.name ?? nameOf(who), amount = r6(Math.min(lot.pay, Math.max(0.005, lot.pay * SHARE)));
  if (amount > lot.pay || (await balanceOf(who).catch(() => 0)) < amount) {
    job.log('writer', 'note', `${name} can't cover a fact check from its balance, so it writes on without one`);
    return undefined;
  }
  const input = { title: p.title, brief: p.brief.slice(0, 2000), draft: p.draft }, text = briefOf(fields, input), hash = sha256(text);
  const id = randomBytes(5).toString('hex');
  savePost({ id, hash, title: `Fact check: ${p.title}`.slice(0, 100), brief: `${name} hired a check of its draft for job ${job.orderId}.`, days: 1, budgetUsd: amount, at: new Date().toISOString(), parent: job.orderId, by: who }, text);
  job.log('writer', 'start', `${name} hires a fact check of its draft for ${amount} USDC, from its own balance`);
  const r = await act(who, 'sub_post', { lot: lot.id, id, spec: hash, amount: toUnits(amount) }, { tgas: 30 });
  noteSub(job.orderId, { id, title: 'Fact check', by: who, amount, tx: r.hash }, name);
  startSubJob({ id, parent: job.orderId, lot: lot.id, by: who, name, input, text, amount, tx: r.hash });

  const done = await finished(id);
  if (done?.state !== 'delivered' || !done.delivery?.factcheck) {
    job.log('writer', 'note', `The fact check ${done?.state === 'failed' ? 'failed' : 'did not come back in time'}; ${name} writes on without it`);
    return undefined;
  }
  // accepting only moves balances inside the bank, so it needs no more gas than posting did
  const a = await act(who, 'accept', { id }, { tgas: 30 }).catch((e: any) => {
    job.log('writer', 'note', `${name} could not accept the fact check, so it writes on without it: ${String(e?.message ?? e).slice(0, 120)}`);
    return undefined;
  });
  if (!a) return undefined;
  markAccepted(done, `Accepted by ${name}; escrow released to the checker`, a.hash);
  const issues = done.delivery.factcheck.issues;
  job.log('writer', 'done', `${name} accepted the fact check (${issues.length} to fix) and paid for it`);
  return { id, issues };
}

async function finished(id: string) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const o = getOrder(id);
    if (!o || ['delivered', 'failed', 'accepted', 'rejected'].includes(o.state) || Date.now() > until) return o;
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}
