'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENTS, api, cents, fmtValue, host, usd, type Claim, type Fact, type JobEvent, type JobView } from '@/lib/api';
import { AGENT_IDS, type AgentState, type Pose } from '@/lib/cast';
import { Studio } from './Studio';
import { serviceById } from '@/lib/catalog';

const FACT_LABELS: [string, string][] = [
  ['what', 'What they do'],
  ['founded', 'Founded'],
  ['hq', 'Headquarters'],
  ['headcount', 'Employees'],
  ['funding_total', 'Total funding'],
  ['last_round', 'Latest round'],
  ['ceo', 'CEO'],
];

export function JobLive({ id }: { id: string }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    api<JobView>(`/jobs/${id}`).then(setJob).catch(() => {});
    const es = new EventSource(`/api/jobs/${id}/events`);
    es.addEventListener('event', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as JobEvent;
      if (seen.current.has(e.seq)) return;
      seen.current.add(e.seq);
      setEvents((xs) => [...xs, e].sort((a, b) => a.seq - b.seq));
    });
    es.addEventListener('job', (m) => setJob(JSON.parse((m as MessageEvent).data)));
    return () => es.close();
  }, [id]);

  const states = useMemo(() => (job ? agentStates(job, events) : {}), [job, events]);

  if (!job) return <div className="wrap" style={{ padding: 60 }}>Loading…</div>;
  const running = job.status === 'running';

  return (
    <main className="wrap job" style={{ maxWidth: 1140 }}>
      <Header job={job} />
      <div className="job-stage">
        <Studio states={states} />
      </div>
      <Headline job={job} />
      <div className="job-grid">
        <div className="job-main">
          {job.service === 'company-brief' ? <Brief job={job} /> : job.service === 'lead-list' ? <Leads job={job} /> : <Generic job={job} />}
        </div>
        <aside className="job-aside">
          <Money job={job} />
          <Timeline events={events} running={running} />
        </aside>
      </div>
      <Details job={job} />
    </main>
  );
}

const POSE_FOR: Record<string, Pose> = { conflict: 'talk', resolve: 'talk', money: 'talk', check: 'work', retry: 'work', recover: 'work', tool: 'work', step: 'talk', say: 'work', error: 'talk' };

/** Turn the event stream into what each character is doing right now. */
function agentStates(job: JobView, events: JobEvent[]) {
  const out: Partial<Record<(typeof AGENT_IDS)[number], AgentState>> = {};
  for (const a of AGENT_IDS) out[a] = { pose: 'idle' };
  const last = [...events].reverse().find((e) => e.agent !== 'system');
  if (job.status === 'delivered') {
    for (const a of AGENT_IDS) out[a] = { pose: 'done' };
    const money = [...events].reverse().find((e) => e.kind === 'money');
    out.cfo = { pose: 'done', on: true, bubble: money ? clip(money.text, 120) : 'Delivered.' };
    return out;
  }
  if (job.status === 'quoted') {
    out.cfo = { pose: 'talk', on: true, bubble: `Quoted ${usd(job.quote?.priceUsd)}. Waiting for the go-ahead.` };
    return out;
  }
  if (job.status === 'paused') {
    out.cfo = { pose: 'talk', on: true, bubble: 'Budget reached. Nobody spends another cent until you approve more.' };
    return out;
  }
  if (job.status === 'failed') {
    const a = (last?.agent ?? 'lead') as (typeof AGENT_IDS)[number];
    out[a] = { pose: 'talk', on: true, bubble: clip(job.error ?? 'Stopped.', 110) };
    return out;
  }
  if (last && last.agent !== 'system') {
    const a = last.agent as (typeof AGENT_IDS)[number];
    const rejecting = a === 'verifier' && /reject|✗|not found|failed|doesn't/i.test(last.text);
    out[a] = { pose: rejecting ? 'talk' : POSE_FOR[last.kind] ?? 'work', on: true, bubble: clip(last.text, 120) };
  }
  return out;
}

/** One-line answer at the top of the results. */
function Headline({ job }: { job: JobView }) {
  const r = job.result;
  if (!r) return null;
  const s = r.stats ?? {};
  const line =
    r.headline ??
    (job.service === 'company-brief'
      ? `${s.verified} of ${s.facts} facts verified on ${job.live.company?.name ?? 'the company'}; ${s.agreed} seen by both angles, ${s.conflicts} disagreement${s.conflicts === 1 ? '' : 's'} settled.`
      : job.service === 'lead-list'
        ? `${s.verified} of ${s.wanted} leads verified from ${s.checked} candidates checked.`
        : 'Delivered.');
  const v = r.verdict as string | undefined;
  const vcls = v === 'green' || v === 'confirmed' ? 'agree' : v === 'red' || v === 'mismatch' ? 'conflict' : v ? 'warn' : '';
  return (
    <div className="card fade-in" style={{ padding: '18px 22px', display: 'flex', gap: 14, alignItems: 'center', borderColor: v ? `var(--${vcls === 'agree' ? 'agree' : vcls === 'conflict' ? 'conflict' : 'warn'})` : undefined }}>
      {v && <span className={`pill ${vcls}`} style={{ height: 30, fontSize: 13.5, textTransform: 'uppercase' }}>{v.replace('-', ' ')}</span>}
      <div style={{ fontSize: 17, fontWeight: 560 }}>{line}</div>
    </div>
  );
}

/** Any service: fact rows, item cards with checks, written points, CSV. */
function Generic({ job }: { job: JobView }) {
  const r = job.result ?? {};
  const items: any[] = r.items ?? [];
  const facts: Fact[] = r.facts ?? [];
  const points: { text: string; cites: string[] }[] = r.points ?? [];
  if (!job.result) return <div className="card pad muted">The team is working. Results appear here as soon as they’re verified.</div>;
  return (
    <>
      {facts.length > 0 && <FactTable rows={facts} />}
      {items.length > 0 && (
        <div className="card pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
            <h3>What the team found</h3>
            <span className="muted" style={{ fontSize: 13 }}>
              {items.filter((i) => i.status === 'verified').length} verified · {items.filter((i) => i.status !== 'verified').length} dropped
            </span>
          </div>
          {r.csv && (
            <a className="btn ghost sm" style={{ margin: '4px 0 12px' }} href={`data:text/csv;charset=utf-8,${encodeURIComponent(r.csv)}`} download={`parallax-${job.service}-${job.id}.csv`}>
              Download CSV
            </a>
          )}
          <div style={{ display: 'grid', gap: 10 }}>
            {items.map((it, k) => (
              <div key={k} className="fade-in" style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 14, opacity: it.status === 'verified' ? 1 : 0.7 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 650 }}>
                      {it.link ? (
                        <a href={it.link} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', textDecorationColor: 'var(--line-2)' }}>
                          {it.title}
                        </a>
                      ) : (
                        it.title
                      )}
                    </div>
                    {it.subtitle && <div className="muted" style={{ fontSize: 13.5 }}>{it.subtitle}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    {(it.checks ?? []).map((c: any) => (
                      <span key={c.name} className={`pill ${c.ok ? 'agree' : c.severity === 'high' ? 'conflict' : 'warn'}`} title={c.note}>
                        {c.ok ? '✓' : '·'} {c.name}
                      </span>
                    ))}
                  </div>
                </div>
                {it.fields && (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
                    {Object.entries(it.fields).map(([k2, v2]) => (
                      <span key={k2}>
                        <span className="muted">{k2}:</span> {String(v2)}
                      </span>
                    ))}
                  </div>
                )}
                {it.dropReason && <div style={{ color: 'var(--conflict)', fontSize: 13, marginTop: 6 }}>{it.dropReason}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      {points.length > 0 && <Points points={points} />}
    </>
  );
}

function Points({ points }: { points: { text: string; cites: string[] }[] }) {
  return (
    <div className="card pad fade-in">
      <h3>The write-up</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Written only from verified facts. Every line cites them, and a draft that guesses or adds an unverified number is sent back.
      </p>
      <ol style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 10 }}>
        {points.map((p, i) => (
          <li key={i}>
            {p.text}{' '}
            {p.cites.map((c) => (
              <span key={c} className="pill" style={{ height: 20, fontSize: 11, marginLeft: 4 }}>
                {c}
              </span>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StatusPill({ status }: { status: JobView['status'] }) {
  const cls = status === 'delivered' ? 'agree' : status === 'failed' ? 'conflict' : status === 'paused' ? 'warn' : '';
  return (
    <span className={`pill ${cls} ${status === 'running' ? 'live' : ''}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

function Header({ job }: { job: JobView }) {
  const name = serviceById(job.service)?.name ?? job.service;
  const subject = job.live.company?.name ?? job.input.company ?? job.input.name ?? job.input.space ?? job.input.icp;
  const purpose = job.input.purpose ?? job.input.goal ?? job.input.context ?? job.input.focus ?? job.input.titles;
  return (
    <div className="job-head">
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">
          {name}
          {job.runs > 1 && ` · resumed, run ${job.runs}`}
        </div>
        <h1 className="display">{subject ? String(subject) : name}</h1>
        {purpose && <p className="muted" style={{ margin: 0, fontSize: 16 }}>{String(purpose)}</p>}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusPill status={job.status} />
        {job.status === 'paused' && (
          <button className="btn sm" onClick={() => api(`/jobs/${job.id}/approve`, { method: 'POST' })}>
            Approve 50% more budget
          </button>
        )}
        {job.status === 'failed' && (
          <button className="btn sm" onClick={() => api(`/jobs/${job.id}/resume`, { method: 'POST' })}>
            Resume from last step
          </button>
        )}
      </div>
    </div>
  );
}

function Money({ job }: { job: JobView }) {
  const q = job.quote;
  const spent = job.spend.totalUsd;
  const pctBudget = q ? Math.min(100, (spent / q.budgetUsd) * 100) : 0;
  const books = job.result?.books;
  return (
    <div className="card pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="eyebrow">price</span>
        {books && <span className="mono" style={{ color: 'var(--agree)', fontWeight: 600 }}>{books.marginPct}% margin</span>}
      </div>
      <div style={{ fontFamily: 'var(--display)', fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em', margin: '4px 0 14px' }}>{usd(job.result?.priceUsd ?? q?.priceUsd)}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
        <span className="muted">Spent</span>
        <span className="mono">
          {usd(spent, 3)} <span className="muted">of {usd(q?.budgetUsd, 2)} cap</span>
        </span>
      </div>
      <div style={{ height: 6, background: 'var(--bg-2)', borderRadius: 99, marginTop: 8, overflow: 'hidden' }}>
        <div style={{ width: `${pctBudget}%`, height: '100%', background: pctBudget > 85 ? 'var(--conflict)' : 'var(--cfo)', transition: 'width .4s' }} />
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        {job.spend.llmCalls} model calls ({usd(job.spend.llmUsd, 3)}) · {job.spend.toolCalls} data calls ({job.spend.credits.toFixed(1)} credits)
      </div>
    </div>
  );
}

function Timeline({ events, running }: { events: JobEvent[]; running: boolean }) {
  const [all, setAll] = useState(false);
  const shown = (all ? events : events.slice(-7)).filter((e) => e.kind !== 'tool' || all);
  const mark: Record<string, string> = { retry: '↻', recover: '✚', conflict: '⚡', resolve: '⚖', check: '✓', money: '$', error: '✕' };
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="eyebrow">activity {running && <span className="pulse" style={{ color: 'var(--agree)' }}>● live</span>}</span>
        {events.length > 7 && (
          <button onClick={() => setAll(!all)} style={{ border: 0, background: 'none', color: 'var(--ink-2)', fontSize: 12.5, cursor: 'pointer', padding: 0 }}>
            {all ? 'Show less' : `All ${events.length}`}
          </button>
        )}
      </div>
      <div style={{ marginTop: 10, display: 'grid', gap: 10, maxHeight: all ? 520 : undefined, overflow: all ? 'auto' : undefined }}>
        {shown.map((e) => (
          <div key={e.seq} className="fade-in" style={{ fontSize: 13.5, lineHeight: 1.45 }}>
            <span style={{ color: AGENTS[e.agent]?.color, fontWeight: 650 }}>{AGENTS[e.agent]?.name}</span>{' '}
            <span style={{ color: e.kind === 'error' ? 'var(--conflict)' : e.kind === 'recover' ? 'var(--agree)' : 'var(--ink-2)' }}>
              {mark[e.kind] && <b style={{ marginRight: 3 }}>{mark[e.kind]}</b>}
              {e.text}
            </span>
          </div>
        ))}
        {!events.length && <div className="muted" style={{ fontSize: 13 }}>Waiting for the team…</div>}
      </div>
    </div>
  );
}

/** Folded away: the saved steps and the trace IDs, for anyone who wants to check our work. */
function Details({ job }: { job: JobView }) {
  if (!job.steps.length) return null;
  return (
    <details className="job-details">
      <summary>
        Under the hood · {job.steps.filter((s) => s.status === 'done').length} saved steps · {job.traces.length} neatlogs trace{job.traces.length === 1 ? '' : 's'}
      </summary>
      <p className="muted" style={{ fontSize: 13.5 }}>
        Every step is saved when it finishes. If the job stops, a resume skips straight past these and pays nothing twice.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="t" style={{ minWidth: 560 }}>
          <tbody>
            {job.steps.map((s) => (
              <tr key={s.key}>
                <td className="mono">{s.key}</td>
                <td style={{ color: AGENTS[s.agent]?.color }}>{AGENTS[s.agent]?.name}</td>
                <td>{s.status === 'done' ? <span className="pill agree">done</span> : <span className="pill conflict">{s.status}</span>}</td>
                <td className="mono muted">{s.attempts > 1 ? `${s.attempts} tries` : ''}</td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {((s.endedAt - s.startedAt) / 1000).toFixed(1)}s · {cents(s.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mono muted" style={{ fontSize: 12, marginTop: 12 }}>
        job {job.id} · traces {job.traces.join(', ')}
      </div>
    </details>
  );
}

function Brief({ job }: { job: JobView }) {
  const facts = job.result?.facts ?? job.live.facts;
  const rec = job.live.records ?? [];
  const fld = job.live.field ?? [];
  const byKey = (xs: Claim[], k: string) => xs.find((c) => c.key === k);
  const rows = FACT_LABELS.map(([k, label]) => facts?.find((f: Fact) => f.key === k) ?? ({ key: k, label, value: null, agreement: 'neither', chosen: '', reason: '', records: byKey(rec, k), field: byKey(fld, k) } as Fact));
  const points: { text: string; cites: string[] }[] = job.result?.points ?? [];
  return (
    <>
      <FactTable rows={rows} />
      {points.length > 0 && <Points points={points} />}
    </>
  );
}

/** The two angles side by side, with the verdict for each fact. */
function FactTable({ rows }: { rows: Fact[] }) {
  const verified = rows.filter((f) => f.verified).length;
  const both = rows.filter((f) => f.agreement === 'agree' || f.agreement === 'conflict').length;
  return (
    <div className="card pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3>Two angles, side by side</h3>
        <span className="muted" style={{ fontSize: 13 }}>
          {verified}/{rows.length} verified · {both} seen by both angles
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="t" style={{ minWidth: 620 }}>
          <thead>
            <tr>
              <th style={{ width: '17%' }}>Fact</th>
              <th className="tc-records" style={{ width: '27%' }}>
                Records <span className="muted">· database</span>
              </th>
              <th className="tc-field" style={{ width: '33%' }}>
                Field <span className="muted">· open web</span>
              </th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.key} className="fade-in">
                <td style={{ fontWeight: 600 }}>{f.label}</td>
                <td className="mono" style={{ fontSize: 13 }}>
                  {f.records ? clip(fmtValue(f.key, f.records.value), 90) : <span className="muted">·</span>}
                </td>
                <td style={{ fontSize: 13 }}>
                  {f.field ? (
                    <>
                      <div className="mono">{clip(fmtValue(f.key, f.field.value), 90)}</div>
                      <a href={f.field.source} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12 }}>
                        {host(f.field.source)}
                      </a>
                    </>
                  ) : (
                    <span className="muted">·</span>
                  )}
                </td>
                <td style={{ fontSize: 13 }}>
                  <Verdict f={f} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Verdict({ f }: { f: Fact }) {
  if (f.verified === undefined && f.agreement === 'neither') {
    if (f.records || f.field) return <span className="muted">checking…</span>;
    return <span className="muted">·</span>;
  }
  const value = fmtValue(f.key, f.value);
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
        {f.agreement === 'agree' && <span className="pill agree">both agree</span>}
        {f.agreement === 'conflict' && <span className="pill conflict">settled</span>}
        {f.agreement === 'records-only' && <span className="pill records">database only</span>}
        {f.agreement === 'field-only' && <span className="pill field">web only</span>}
        {f.agreement === 'neither' && <span className="pill">not found</span>}
        {f.verified === false && f.agreement !== 'neither' && <span className="pill conflict">rejected</span>}
      </div>
      {f.verified && f.chosen === 'tiebreak' && <div className="mono">{clip(value, 60)}</div>}
      {(f.agreement === 'conflict' || (f.check && /failed|not found|does not/.test(f.check))) && (
        <div className="muted" style={{ fontSize: 12 }}>
          {f.reason || f.check}
        </div>
      )}
    </div>
  );
}

// ---- lead list -----------------------------------------------------------------------------

function Leads({ job }: { job: JobView }) {
  const all: any[] = useMemo(() => (job.result ? [...job.result.leads, ...job.result.dropped] : job.live.leads ?? []), [job]);
  const verified = all.filter((l) => l.status === 'verified');
  const dropped = all.filter((l) => l.status !== 'verified');
  return (
    <>
      <div className="card pad">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>Leads that held up from both angles</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            {verified.length} kept · {dropped.length} dropped
          </span>
        </div>
        {job.result?.csv && (
          <a className="btn ghost" style={{ height: 32, fontSize: 13, marginBottom: 10 }} href={`data:text/csv;charset=utf-8,${encodeURIComponent(job.result.csv)}`} download={`parallax-leads-${job.id}.csv`}>
            Download CSV
          </a>
        )}
        <div style={{ display: 'grid', gap: 10 }}>
          {verified.map((l) => (
            <LeadCard key={l.company.domain} l={l} />
          ))}
          {!verified.length && <div className="muted">Checking candidates…</div>}
        </div>
      </div>
      {dropped.length > 0 && (
        <div className="card pad">
          <h3>Dropped, and why</h3>
          <table className="t">
            <tbody>
              {dropped.map((l) => (
                <tr key={l.company.domain}>
                  <td style={{ fontWeight: 560 }}>{l.company.name}</td>
                  <td className="mono muted">{l.company.domain}</td>
                  <td style={{ color: 'var(--conflict)', fontSize: 13 }}>{l.dropReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function LeadCard({ l }: { l: any }) {
  return (
    <div className="fade-in" style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 640 }}>
            {l.company.name} <span className="mono muted">{l.company.domain}</span>
          </div>
          <div style={{ fontSize: 14 }}>
            {l.person?.profileUrl ? (
              <a href={l.person.profileUrl} target="_blank" rel="noreferrer">
                {l.person.name}
              </a>
            ) : (
              l.person?.name
            )}{' '}
            <span className="muted">· {l.person?.title}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {l.checks.map((c: any) => (
            <span key={c.name} className={`pill ${c.ok ? 'agree' : 'warn'}`} title={c.note}>
              {c.ok ? '✓' : '·'} {c.name}
            </span>
          ))}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
        {l.fit}
      </div>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
