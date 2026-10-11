/**
 * Run one job in-process and print what came back.
 *
 *   node --env-file=../.env scripts/try.ts <service> '<json input>'
 *   node --env-file=../.env scripts/try.ts person-check '{"name":"Karri Saarinen","company":"Linear","title":"CEO"}'
 *   node --env-file=../.env scripts/try.ts --resume <jobId>      (raise a paused job's budget 2x and carry on)
 */
import { init, flush, shutdown } from 'neatlogs';
import type { ServiceId } from '../src/types.ts';

const [service, raw] = process.argv.slice(2);
if (!service || !raw) {
  console.error("usage: scripts/try.ts <service> '<json input>'");
  process.exit(1);
}

await init({ apiKey: process.env.NEATLOGS_API_KEY, endpoint: 'https://ingest.neatlogs.com', workflowName: 'research-job', tags: ['parallax', 'dev'], registerShutdownHandlers: false });
const { createJob, runJob } = await import('../src/runner.ts');

const { getJob, saveJob } = await import('../src/store.ts');
const job = service === '--resume' ? getJob(raw) : createJob(service as ServiceId, JSON.parse(raw), { tag: 'dev' });
if (!job) {
  console.error('unknown service, job or empty input');
  process.exit(1);
}
if (service === '--resume' && job.quote) {
  job.quote.budgetUsd *= 2;
  saveJob(job);
}
console.log(`${job.id}: quoted $${job.quote?.priceUsd} (est. cost $${job.quote?.estCostUsd}, budget $${job.quote?.budgetUsd})`);
const t0 = Date.now();
await runJob(job.id);
const r = job.result ?? {};
console.log(`\nstatus:   ${job.status}${job.error ? ` (${job.error})` : ''} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`headline: ${r.headline ?? '-'}`);
if (r.verdict) console.log(`verdict:  ${r.verdict}`);
console.log(`stats:    ${JSON.stringify(r.stats ?? {})}`);
console.log(`cost:     $${job.spend.totalUsd.toFixed(4)} (llm $${job.spend.llmUsd.toFixed(4)}, ${job.spend.credits} credits)`);
console.log(`traces:   ${job.traces.join(', ')}`);
await flush();
await shutdown();
process.exit(0);
