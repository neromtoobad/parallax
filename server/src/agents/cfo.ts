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
  // ~3 person searches + up to 8 web searches (1 credit each) + a fast and a smart model call.
  'people-map': { perUnit: 0.15, minPrice: 3, unit: 'map' },
  // A 25-row semantic search, ~6 homepages (free direct fetch first) and 7 extractions + one smart write-up.
  'competitor-teardown': { perUnit: 0.18, minPrice: 4, unit: 'teardown' },
  // Per company: a share of the search and screen, one homepage read, one fast model call.
  'market-map': { perUnit: 0.04, minPrice: 2, unit: 'company' },
  // Enrich (2 credits), a people search, 3 web searches, a homepage read, one classification call.
  'vendor-check': { perUnit: 0.08, minPrice: 2, unit: 'check' },
  // 2-4 small searches, 1 web search, free team-page fetches, one fast model call.
  'person-check': { perUnit: 0.05, minPrice: 1, unit: 'check' },
};

/** What one unit of a service is called ("lead", "check"...). */
export const unitName = (service: ServiceId) => PRIOR[service]?.unit ?? 'job';

export function unitsOf(job: Pick<Job, 'service' | 'input'>) {
  return job.service === 'lead-list' || job.service === 'market-map' ? Math.max(1, Number(job.input.count ?? 10)) : 1;
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
