import { AsyncLocalStorage } from 'node:async_hooks';
import { span } from 'neatlogs';
import { env } from './env.ts';
import { emit, saveJob } from './store.ts';
import type { AgentId, Job } from './types.ts';

interface Ctx {
  job: Job;
  agent: AgentId;
}

const als = new AsyncLocalStorage<Ctx>();

export const current = () => als.getStore();

export class BudgetExceeded extends Error {
  spent: number;
  budget: number;
  constructor(spent: number, budget: number) {
    super(`budget reached: spent $${spent.toFixed(4)} of $${budget.toFixed(4)}`);
    this.spent = spent;
    this.budget = budget;
  }
}

/** A failure that retrying won't fix (bad input, 4xx). */
export class Permanent extends Error {}

/** Record money spent by the current agent on the current job. Throws once the job is over budget. */
export function charge(c: { usd?: number; credits?: number; llm?: boolean }) {
  const ctx = current();
  if (!ctx) return;
  const s = ctx.job.spend;
  const creditsUsd = (c.credits ?? 0) * env.usdPerCredit;
  s.llmUsd += c.usd ?? 0;
  s.credits += c.credits ?? 0;
  s.creditsUsd += creditsUsd;
  s.totalUsd = s.llmUsd + s.creditsUsd;
  if (c.llm) s.llmCalls++;
  else s.toolCalls++;
  const a = (s.byAgent[ctx.agent] ??= { usd: 0, credits: 0 });
  a.usd += (c.usd ?? 0) + creditsUsd;
  a.credits += c.credits ?? 0;
}

/** Called before anything that costs money. */
export function assertBudget() {
  const ctx = current();
  const b = ctx?.job.quote?.budgetUsd;
  if (ctx && b && ctx.job.spend.totalUsd >= b) throw new BudgetExceeded(ctx.job.spend.totalUsd, b);
}

export function say(text: string, kind: Parameters<typeof emit>[1]['kind'] = 'say', data?: unknown) {
  const ctx = current();
  if (ctx) emit(ctx.job, { agent: ctx.agent, kind, text, data });
}

export function asAgent<T>(job: Job, agent: AgentId, fn: () => Promise<T>): Promise<T> {
  return als.run({ job, agent }, fn);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A checkpointed unit of work. If the job already finished this step (before a crash or restart),
 * the saved output comes back and nothing runs or costs money again. Otherwise it runs as a neatlogs
 * AGENT span, retries transient failures with backoff, and saves the result to disk.
 */
export async function step<T>(
  job: Job,
  agent: AgentId,
  key: string,
  fn: () => Promise<T>,
  opts: { retries?: number; goal?: string } = {},
): Promise<T> {
  const done = job.steps[key];
  if (done?.status === 'done') return done.output as T;

  const retries = opts.retries ?? 2;
  const startedAt = Date.now();
  const before = job.spend.totalUsd;
  let attempts = 0;
  let lastErr: unknown;

  const traced = span({ kind: 'AGENT', name: `${agent}.${key.split(':')[0]}`, role: agent, goal: opts.goal ?? key }, async (_key: string) => {
    for (;;) {
      attempts++;
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err instanceof BudgetExceeded || err instanceof Permanent || attempts > retries) throw err;
        const wait = 800 * 2 ** (attempts - 1);
        emit(job, { agent, kind: 'retry', text: `${key} failed (${short(err)}), retrying in ${wait / 1000}s`, data: { attempt: attempts } });
        await sleep(wait);
      }
    }
  });

  return asAgent(job, agent, async () => {
    try {
      const output = await traced(key);
      job.steps[key] = { key, agent, status: 'done', output, attempts, startedAt, endedAt: Date.now(), costUsd: job.spend.totalUsd - before };
      saveJob(job);
      return output;
    } catch (err) {
      job.steps[key] = { key, agent, status: 'failed', error: short(err), attempts, startedAt, endedAt: Date.now(), costUsd: job.spend.totalUsd - before };
      saveJob(job);
      throw lastErr ?? err;
    }
  });
}

export function short(err: unknown) {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 180 ? m.slice(0, 180) + '…' : m;
}
