/**
 * Unit economics from real, delivered jobs: the numbers the cfo.ai business plan is built on.
 *
 *   node scripts/unit-economics.ts [--tags eval:v2,eval:v3,live-test]   → prints markdown, writes docs/unit-economics.json
 *
 * Every number comes from per-call metering (model tokens × list price, Crustdata credits from the
 * X-Credits-Used header), the same calls that appear as spans in each job's neatlogs trace.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const tagArg = args[args.indexOf('--tags') + 1];
const tags = args.includes('--tags') ? tagArg.split(',') : null;

const root = join(import.meta.dirname, '../..');
const dir = join(root, 'data/jobs');
const jobs = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter((j) => j.status === 'delivered' && (!tags || tags.includes(j.tag)));

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const out: any = { generatedAt: new Date().toISOString(), tags, services: {} };
const order = ['company-brief', 'lead-list', 'people-map', 'competitor-teardown', 'market-map', 'vendor-check', 'person-check'];
for (const service of order) {
  const js = jobs.filter((j) => j.service === service);
  if (!js.length) continue;
  // Lead lists are paid per verified lead, market maps per company mapped; everything else per job.
  const units = (j: any) => (service === 'lead-list' ? Math.max(1, j.result?.stats?.verified ?? 0) : service === 'market-map' ? Math.max(1, Number(j.input?.count ?? 10)) : 1);
  const perUnit = js.map((j) => j.spend.totalUsd / units(j));
  const llmShare = mean(js.map((j) => j.spend.llmUsd / Math.max(1e-9, j.spend.totalUsd)));
  const secs = js.map((j) => (j.updatedAt - j.createdAt) / 1000);
  out.services[service] = {
    jobs: js.length,
    unit: service === 'lead-list' ? 'delivered lead' : service === 'company-brief' ? 'brief' : service === 'market-map' ? 'company mapped' : 'job',
    costPerUnit: { mean: mean(perUnit), p50: q(perUnit, 0.5), p75: q(perUnit, 0.75), max: Math.max(...perUnit) },
    split: { models: llmShare, data: 1 - llmShare },
    creditsPerUnit: mean(js.map((j) => j.spend.credits / units(j))),
    modelCallsPerJob: mean(js.map((j) => j.spend.llmCalls)),
    dataCallsPerJob: mean(js.map((j) => j.spend.toolCalls)),
    secondsPerJob: { p50: q(secs, 0.5), p75: q(secs, 0.75) },
    partialDeliveries: js.filter((j) => j.result?.partial).length,
    sampleTraces: js.slice(0, 3).flatMap((j) => j.traces.slice(-1)),
  };
}

const usd = (n: number, d = 3) => `$${n.toFixed(d)}`;
const lines = [`# Parallax unit economics (measured)`, '', `${jobs.length} delivered jobs${tags ? ` tagged ${tags.join(', ')}` : ''}.`, ''];
for (const [svc, s] of Object.entries<any>(out.services)) {
  lines.push(
    `## ${svc}`,
    '',
    `| | |`,
    `| --- | --- |`,
    `| jobs measured | ${s.jobs} |`,
    `| cost per ${s.unit} (median / p75 / max) | ${usd(s.costPerUnit.p50)} / ${usd(s.costPerUnit.p75)} / ${usd(s.costPerUnit.max)} |`,
    `| split | ${Math.round(s.split.models * 100)}% models, ${Math.round(s.split.data * 100)}% data |`,
    `| Crustdata credits per ${s.unit} | ${s.creditsPerUnit.toFixed(1)} |`,
    `| model calls / data calls per job | ${s.modelCallsPerJob.toFixed(1)} / ${s.dataCallsPerJob.toFixed(1)} |`,
    `| time per job (median / p75) | ${s.secondsPerJob.p50.toFixed(0)}s / ${s.secondsPerJob.p75.toFixed(0)}s |`,
    `| delivered partially (hit budget) | ${s.partialDeliveries} |`,
    `| sample neatlogs traces | ${s.sampleTraces.map((t: string) => '`' + t + '`').join(', ')} |`,
    '',
  );
}
const md = lines.join('\n');
console.log(md);
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs/unit-economics.json'), JSON.stringify(out, null, 2));
writeFileSync(join(root, 'docs/unit-economics.md'), md + '\n');
