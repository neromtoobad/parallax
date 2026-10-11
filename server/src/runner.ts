import { setTraceOutput, trace } from 'neatlogs';
import { BudgetExceeded, short } from './context.ts';
import { closeBooks } from './agents/cfo.ts';
import { emit, getJob, leaseHeld, listJobs, newId, saveJob } from './store.ts';
import { quote } from './agents/cfo.ts';
import { SERVICES as CATALOG } from './catalog.ts';
import { runCompanyBrief } from './services/company-brief.ts';
import { runLeadList } from './services/lead-list.ts';
import { emptySpend, type Job, type ServiceId } from './types.ts';

const SERVICES: Record<ServiceId, (job: Job) => Promise<any>> = {
  'company-brief': runCompanyBrief,
  'lead-list': runLeadList,
};

const WORKFLOW_NAMES: Record<ServiceId, string> = {
  'company-brief': 'company-brief',
  'lead-list': 'lead-list',
};

const active = new Set<string>();

/** Open a job from a client's form and have the CFO quote it. Nothing runs until the quote is accepted. */
export function createJob(service: ServiceId, raw: Record<string, any>, opts: { client?: Job['client']; tag?: string } = {}) {
  const svc = CATALOG.find((s) => s.id === service);
  if (!svc) return null;
  const input = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v.trim().slice(0, 500) : v]));
  if (input.count != null) input.count = Math.max(1, Math.min(25, Number(input.count) || 10));
  const brief = svc.fields.map((f) => (input[f.name] ? `${f.label} ${input[f.name]}` : '')).filter(Boolean).join('\n');
  if (!brief) return null;
  const job: Job = {
    id: newId('job'),
    service,
    brief,
    input,
    client: opts.client,
    status: 'quoted',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: {},
    spend: emptySpend(),
    traces: [],
    runs: 0,
    tag: opts.tag,
  };
  job.quote = quote(job);
  saveJob(job);
  return job;
}

/**
 * Run (or resume) a job as one neatlogs WORKFLOW trace. Steps already done are skipped, so a job
 * that died halfway picks up where it stopped and pays nothing twice.
 */
export async function runJob(id: string) {
  const job = getJob(id);
  if (!job || active.has(id)) return;
  active.add(id);
  const resumed = Object.keys(job.steps).length > 0;
  job.status = 'running';
  job.runs = (job.runs ?? 0) + 1;
  job.error = undefined;
  saveJob(job);
  emit(job, { agent: 'system', kind: 'status', text: resumed ? `Resumed (run ${job.runs}); ${Object.values(job.steps).filter((s) => s.status === 'done').length} finished steps kept` : 'Job started' });

  try {
    // One WORKFLOW root per job run, labelled with its service so each service is its own workflow in neatlogs.
    const root = {
      name: `${WORKFLOW_NAMES[job.service]} · ${job.id}${job.runs > 1 ? ` · run ${job.runs}` : ''}`,
      kind: 'WORKFLOW' as const,
      input: { id: job.id, brief: job.brief, input: job.input, run: job.runs },
      attributes: { 'neatlogs.workflow.name': WORKFLOW_NAMES[job.service] },
    };
    await trace(root, async (span) => {
      job.traces.push(span.spanContext().traceId);
      span.setAttribute('parallax.job_id', job.id);
      span.setAttribute('parallax.service', job.service);
      span.setAttribute('parallax.run', job.runs);
      if (job.tag) span.setAttribute('parallax.tag', job.tag);
      saveJob(job);
      try {
        const result = await SERVICES[job.service](job);
        job.result = { ...result, priceUsd: result.priceUsd ?? job.quote?.priceUsd };
        job.status = 'delivered';
        emit(job, { agent: 'system', kind: 'status', text: 'Delivered' });
      } catch (err) {
        if (err instanceof BudgetExceeded) {
          job.status = 'paused';
          job.error = err.message;
          emit(job, {
            agent: 'cfo',
            kind: 'money',
            text: `Stopped the job: it hit its $${err.budget.toFixed(4)} budget. Nothing more will be spent until the client approves more.`,
          });
        } else {
          job.status = 'failed';
          job.error = short(err);
          emit(job, { agent: 'system', kind: 'error', text: `Failed: ${job.error}. Finished steps are saved; the job can be resumed.` });
        }
      }
      span.setAttribute('parallax.status', job.status);
      span.setAttribute('parallax.cost_usd', job.spend.totalUsd);
      span.setAttribute('parallax.credits', job.spend.credits);
      span.setAttribute('parallax.price_usd', job.quote?.priceUsd ?? 0);
      setTraceOutput({ status: job.status, costUsd: job.spend.totalUsd, stats: job.result?.stats, error: job.error });
      saveJob(job);
    });
    if ((job.status as string) === 'delivered') closeBooks(job);
  } finally {
    active.delete(id);
  }
  return job;
}

/** The client (or the owner) raises the budget on a paused job; it carries on from where it stopped. */
export function approveMore(id: string, factor = 1.5) {
  const job = getJob(id);
  if (!job || job.status !== 'paused' || !job.quote) return null;
  job.quote.budgetUsd = Math.round(job.quote.budgetUsd * factor * 1e5) / 1e5;
  emit(job, { agent: 'cfo', kind: 'money', text: `Budget raised to $${job.quote.budgetUsd.toFixed(4)}; resuming` });
  saveJob(job);
  void runJob(id);
  return job;
}

/** On boot: anything that was mid-run when the process died gets picked up again. */
export function resumeInterrupted() {
  for (const j of listJobs()) {
    if (j.status === 'running' && !leaseHeld(j)) {
      emit(j, { agent: 'system', kind: 'recover', text: 'The server restarted mid-job; resuming from the last saved step' });
      void runJob(j.id);
    }
  }
}
