/**
 * Run the fixed eval set and score it.
 *
 *   node --env-file=../.env scripts/eval.ts --label v1 [--only briefs|leads|services] [--cases linear,figma]
 *
 * Every job runs as a normal traced job tagged `eval:<label>`, so each row links to its neatlogs
 * trace. Results go to evals/results/<label>.json; `scripts/compare.ts` turns two labels into a table.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init, flush, shutdown } from 'neatlogs';
import { BRIEFS, LEADS, SERVICE_CASES } from '../evals/cases.ts';
import type { ServiceId } from '../src/types.ts';
import { goldScore } from '../evals/score.ts';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const label = opt('label') ?? `run-${Date.now()}`;
const only = opt('only')?.split(',');
const runs = (k: string) => !only || only.includes(k);
const pick = opt('cases')?.split(',');

await init({ apiKey: process.env.NEATLOGS_API_KEY, endpoint: 'https://ingest.neatlogs.com', workflowName: 'research-job', tags: ['parallax', 'eval', label], registerShutdownHandlers: false });
const { createJob, runJob } = await import('../src/runner.ts');

const HEDGES = /\b(likely|probably|possibly|perhaps|may|might|could|suggests?|suggesting|presumably|appears to|seems?|will resonate|potentially)\b/gi;

const rows: any[] = [];

async function run(service: ServiceId, id: string, input: any) {
  const job = createJob(service, input, { tag: `eval:${label}` })!;
  const t0 = Date.now();
  process.stdout.write(`${label} ${service} ${id} … `);
  await runJob(job.id);
  const secs = (Date.now() - t0) / 1000;
  console.log(`${job.status} in ${secs.toFixed(0)}s, $${job.spend.totalUsd.toFixed(4)}`);
  return { job, secs };
}

if (runs('briefs')) {
  for (const c of BRIEFS.filter((c) => !pick || pick.includes(c.id))) {
    const { job, secs } = await run('company-brief', c.id, c.input);
    const r = job.result ?? {};
    const facts: any[] = r.facts ?? [];
    const gold = goldScore(c, facts);
    const points: any[] = r.points ?? [];
    const hedged = points.filter((p) => (p.text.match(HEDGES) ?? []).length > 0).length;
    rows.push({
      service: 'company-brief',
      case: c.id,
      status: job.status,
      secs,
      costUsd: job.spend.totalUsd,
      llmUsd: job.spend.llmUsd,
      credits: job.spend.credits,
      llmCalls: job.spend.llmCalls,
      toolCalls: job.spend.toolCalls,
      verified: r.stats?.verified ?? 0,
      facts: r.stats?.facts ?? 7,
      twoAngle: facts.filter((f) => f.agreement === 'agree' || f.agreement === 'conflict').length,
      fieldFound: facts.filter((f) => f.field).length,
      conflicts: r.stats?.conflicts ?? 0,
      goldRight: gold.filter((g) => g === 'right').length,
      goldWrong: gold.filter((g) => g === 'wrong').length,
      points: points.length,
      hedgedPoints: hedged,
      draftRounds: r.stats?.draftRounds ?? 0,
      recoveries: job.runs - 1,
      jobId: job.id,
      traces: job.traces,
    });
  }
}

if (runs('leads')) {
  for (const c of LEADS.filter((c) => !pick || pick.includes(c.id))) {
    const { job, secs } = await run('lead-list', c.id, c.input);
    const r = job.result ?? {};
    rows.push({
      service: 'lead-list',
      case: c.id,
      status: job.status,
      secs,
      costUsd: job.spend.totalUsd,
      llmUsd: job.spend.llmUsd,
      credits: job.spend.credits,
      llmCalls: job.spend.llmCalls,
      toolCalls: job.spend.toolCalls,
      wanted: r.stats?.wanted ?? c.input.count,
      verified: r.stats?.verified ?? 0,
      checked: r.stats?.checked ?? 0,
      twoSource: r.stats?.twoSource ?? 0,
      costPerLead: r.stats?.verified ? job.spend.totalUsd / r.stats.verified : null,
      jobId: job.id,
      traces: job.traces,
    });
  }
}

// Newer services share one output shape, so one generic row each: status, cost, time, verdict, stats.
if (runs('services')) {
  for (const c of SERVICE_CASES.filter((c) => !pick || pick.includes(c.id))) {
    const { job, secs } = await run(c.service, c.id, c.input);
    const r = job.result ?? {};
    rows.push({
      service: c.service,
      case: c.id,
      status: job.status,
      secs,
      costUsd: job.spend.totalUsd,
      llmUsd: job.spend.llmUsd,
      credits: job.spend.credits,
      llmCalls: job.spend.llmCalls,
      toolCalls: job.spend.toolCalls,
      verdict: r.verdict ?? null,
      verdictOk: c.verdicts ? c.verdicts.includes(r.verdict) : null,
      headline: r.headline ?? null,
      stats: r.stats ?? {},
      items: (r.items ?? []).filter((i: any) => i.status === 'verified').length,
      points: (r.points ?? []).length,
      hedgedPoints: (r.points ?? []).filter((p: any) => (p.text.match(HEDGES) ?? []).length > 0).length,
      error: job.error ?? null,
      recoveries: job.runs - 1,
      jobId: job.id,
      traces: job.traces,
    });
  }
}

const dir = join(import.meta.dirname, '../evals/results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), rows }, null, 2));
console.log(`\nwrote evals/results/${label}.json`);
await flush();
await shutdown();
process.exit(0);
