import { listJobs, emit, saveJob } from '../store.ts';
import type { Job, Quote, ServiceId } from '../types.ts';

/**
 * The CFO prices work from what it really cost before. Each delivered job's spend is measured
 * call by call (model tokens and Crustdata credits, the same numbers neatlogs shows per span),
 * so the quote gets better with every job.
 */

const TARGET_MARGIN = 0.75;
const BUDGET_HEADROOM = 2.5; // the hard cap, as a multiple of expected cost

/** Starting estimates before there's any history, in USD per unit. */
const PRIOR: Record<ServiceId, { perUnit: number; minPrice: number; unit: string }> = {
  'company-brief': { perUnit: 0.12, minPrice: 2, unit: 'brief' },
  'lead-list': { perUnit: 0.05, minPrice: 2, unit: 'lead' },
};

export function unitsOf(job: Pick<Job, 'service' | 'input'>) {
  return job.service === 'lead-list' ? Math.max(1, Number(job.input.count ?? 10)) : 1;
}

/** Cost per unit for past delivered jobs of a service, newest first. */
export function history(service: ServiceId, limit = 12) {
  return listJobs()
    .filter((j) => j.service === service && j.status === 'delivered' && j.spend.totalUsd > 0)
    .slice(0, limit)
    .map((j) => ({ id: j.id, perUnit: j.spend.totalUsd / unitsOf(j), totalUsd: j.spend.totalUsd, tag: j.tag }));
}

export function quote(job: Pick<Job, 'service' | 'input'>): Quote {
  const units = unitsOf(job);
  const past = history(job.service);
  const prior = PRIOR[job.service];
  let perUnit = prior.perUnit;
  let basis = `no past ${job.service} jobs yet, using the starting estimate of $${prior.perUnit.toFixed(2)} per ${prior.unit}`;
  if (past.length) {
    // 75th percentile, not the mean: one cheap lucky run shouldn't set the price for everyone.
    const sorted = past.map((p) => p.perUnit).sort((a, b) => a - b);
    perUnit = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
    basis = `75th percentile cost of the last ${past.length} delivered ${job.service} job${past.length > 1 ? 's' : ''}: $${perUnit.toFixed(4)} per ${prior.unit}`;
  }
  const estCostUsd = perUnit * units;
  const priceUsd = Math.max(prior.minPrice, Math.ceil((estCostUsd / (1 - TARGET_MARGIN)) * 2) / 2);
  return {
    priceUsd,
    estCostUsd: round(estCostUsd),
    budgetUsd: round(Math.max(estCostUsd * BUDGET_HEADROOM, 0.05)),
    basis,
    sampleSize: past.length,
  };
}

/** Close the books on a finished job. */
export function closeBooks(job: Job) {
  const q = job.quote!;
  const cost = job.spend.totalUsd;
  const revenue = job.status === 'delivered' ? (job.result?.partial ? job.result.priceUsd : q.priceUsd) : 0;
  const books = {
    revenueUsd: revenue,
    costUsd: round(cost),
    marginUsd: round(revenue - cost),
    marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0,
    vsEstimate: q.estCostUsd ? Math.round((cost / q.estCostUsd) * 100) : null,
    llmUsd: round(job.spend.llmUsd),
    credits: Math.round(job.spend.credits * 100) / 100,
    creditsUsd: round(job.spend.creditsUsd),
  };
  job.result = { ...(job.result ?? {}), books };
  emit(job, {
    agent: 'cfo',
    kind: 'money',
    text: `Books closed: revenue $${revenue.toFixed(2)}, cost $${cost.toFixed(4)} (${books.vsEstimate}% of estimate), margin ${books.marginPct}%`,
    data: books,
  });
  saveJob(job);
  return books;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;
