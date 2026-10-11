import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { history, quote, unitName, unitsOf } from './agents/cfo.ts';
import { env } from './env.ts';
import { approveMore, createJob, runJob } from './runner.ts';
import { getJob, listJobs, onEvent, onJob, readEvents } from './store.ts';
import type { Job, ServiceId } from './types.ts';
import { SERVICES } from './catalog.ts';
import { BRIEFS } from '../evals/cases.ts';
import { goldScore } from '../evals/score.ts';


export const api = new Hono();
api.use('*', cors());

api.get('/health', (c) =>
  c.json({ ok: true, keys: { litellm: !!env.litellmKey, neatlogs: !!env.neatlogsKey, crustdata: !!env.crustKey }, models: env.models, chaos: env.chaos }),
);

api.get('/services', (c) => c.json(SERVICES.map((s) => ({ ...s, history: history(s.id).length }))));

/** The CFO quotes before any money is spent. */
api.post('/quote', async (c) => {
  const body = await c.req.json<{ service: ServiceId; input: Record<string, any>; client?: Job['client']; tag?: string }>();
  const svc = SERVICES.find((s) => s.id === body.service);
  if (!svc) return c.json({ error: 'unknown service' }, 400);
  const job = createJob(svc.id, body.input ?? {}, { client: body.client, tag: body.tag });
  if (!job) return c.json({ error: 'empty brief' }, 400);
  return c.json(view(job));
});

api.post('/jobs/:id/accept', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  if (job.status !== 'quoted') return c.json({ error: `job is ${job.status}` }, 409);
  void runJob(job.id);
  return c.json(view(job));
});

/** Resume a failed job from its last saved step. */
api.post('/jobs/:id/resume', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  if (job.status !== 'failed') return c.json({ error: `job is ${job.status}` }, 409);
  void runJob(job.id);
  return c.json(view(job));
});

api.post('/jobs/:id/approve', (c) => {
  const job = approveMore(c.req.param('id'));
  return job ? c.json(view(job)) : c.json({ error: 'job is not paused' }, 409);
});

// A quote nobody accepted isn't a job yet.
api.get('/jobs', (c) => c.json(listJobs().filter((j) => j.status !== 'quoted').slice(0, 100).map(summary)));

api.get('/jobs/:id', (c) => {
  const job = getJob(c.req.param('id'));
  return job ? c.json(view(job)) : c.json({ error: 'not found' }, 404);
});

/** The full event log as plain JSON, for replays. */
api.get('/jobs/:id/log', (c) => {
  const id = c.req.param('id');
  return getJob(id) ? c.json(readEvents(id)) : c.json({ error: 'not found' }, 404);
});

api.get('/jobs/:id/events', (c) => {
  const id = c.req.param('id');
  if (!getJob(id)) return c.json({ error: 'not found' }, 404);
  // no-transform: proxies (Next's rewrite included) must not gzip-buffer the stream.
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    for (const e of readEvents(id)) await stream.writeSSE({ event: 'event', data: JSON.stringify(e) });
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const push = (name: string, data: unknown) => {
      queue.push(JSON.stringify({ name, data }));
      wake?.();
    };
    const offE = onEvent(id, (e) => push('event', e));
    const offJ = onJob((j) => j.id === id && push('job', view(j)));
    stream.onAbort(() => {
      offE();
      offJ();
      wake?.();
    });
    push('job', view(getJob(id)!));
    while (!stream.aborted) {
      while (queue.length) {
        const { name, data } = JSON.parse(queue.shift()!);
        await stream.writeSSE({ event: name, data: JSON.stringify(data) });
      }
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 15_000);
      });
      wake = null;
      if (!queue.length) await stream.writeSSE({ event: 'ping', data: '{}' });
    }
  });
});

/** The CFO's books: every delivered job, priced vs. what it cost. */
api.get('/books', (c) => {
  const jobs = listJobs().filter((j) => j.status === 'delivered' || j.status === 'paused' || j.status === 'failed');
  // Eval, dev and live-test runs are ours: real cost, but nobody paid. Keep them out of revenue.
  const isTest = (j: Job) => !!j.tag;
  const totalsOf = (js: Job[]) => {
    const delivered = js.filter((j) => j.status === 'delivered');
    const revenue = delivered.reduce((a, j) => a + (j.result?.books?.revenueUsd ?? 0), 0);
    const cost = js.reduce((a, j) => a + j.spend.totalUsd, 0);
    return { jobs: js.length, delivered: delivered.length, revenueUsd: revenue, costUsd: cost, marginPct: revenue ? ((revenue - cost) / revenue) * 100 : 0 };
  };
  const client = totalsOf(jobs.filter((j) => !isTest(j)));
  const test = totalsOf(jobs.filter(isTest));
  const perService = SERVICES.map((s) => {
    const h = history(s.id, 50);
    const units = h.map((x) => x.perUnit).sort((a, b) => a - b);
    return {
      service: s.id,
      jobs: h.length,
      unit: unitName(s.id),
      medianCostPerUnit: units.length ? units[Math.floor(units.length / 2)] : null,
      p75CostPerUnit: units.length ? units[Math.min(units.length - 1, Math.floor(units.length * 0.75))] : null,
      nextQuote: quote({ service: s.id, input: { count: 10 } }),
    };
  });
  return c.json({
    totals: client,
    test,
    perService,
    jobs: jobs.slice(0, 50).map((j) => ({ ...summary(j), books: j.result?.books, units: unitsOf(j) })),
  });
});

api.get('/evals', (c) => {
  const dir = join(env.root, 'server/evals/results');
  if (!existsSync(dir)) return c.json([]);
  // Gold scores recomputed with the current gold set (same rule as scripts/compare.ts): single-run jobs only.
  return c.json(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .map((e) => ({
        ...e,
        rows: e.rows.map((r: any) => {
          const k = BRIEFS.find((b) => b.id === r.case);
          const job = r.service === 'company-brief' && k ? getJob(r.jobId) : undefined;
          if (!job || job.runs !== 1 || !job.result) return r;
          const g = goldScore(k!, job.result.facts ?? []);
          return { ...r, goldRight: g.filter((x) => x === 'right').length, goldWrong: g.filter((x) => x === 'wrong').length };
        }),
      })),
  );
});

function summary(j: Job) {
  return {
    id: j.id,
    service: j.service,
    brief: j.brief,
    status: j.status,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    priceUsd: j.result?.priceUsd ?? j.quote?.priceUsd,
    costUsd: j.spend.totalUsd,
    stats: j.result?.stats,
    tag: j.tag,
    runs: j.runs,
  };
}

function view(j: Job) {
  const { steps, ...rest } = j;
  // Field's fetched pages are big; the client gets the step list plus the live, partial work.
  const s = Object.values(steps).map(({ output, ...m }) => m);
  const out = (k: string) => (steps[k]?.status === 'done' ? (steps[k].output as any) : undefined);
  const live = {
    intake: out('intake'),
    company: out('resolve'),
    records: out('records')?.claims,
    field: out('field')?.claims,
    sources: out('field')?.pages?.map((p: any) => ({ id: p.id, url: p.url, title: p.title })),
    facts: out('verify'),
    leads: Object.keys(steps)
      .filter((k) => k.startsWith('check:') && steps[k].status === 'done')
      .map((k) => steps[k].output),
    // Newer services: each checked person, competitor or company as it lands.
    items: Object.keys(steps)
      .filter((k) => /^(check|confirm|teardown):/.test(k) && steps[k].status === 'done' && j.service !== 'lead-list')
      .map((k) => steps[k].output),
  };
  return { ...rest, steps: s, live };
}
