'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENTS, api, cents, fmtValue, host, usd, type AgentId, type Claim, type Fact, type JobEvent, type JobView } from '@/lib/api';

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

  if (!job) return <div className="wrap" style={{ padding: 60 }}>Loading…</div>;

  const running = job.status === 'running';
  const lastAgent = [...events].reverse().find((e) => e.agent !== 'system')?.agent;

  return (
    <main className="wrap" style={{ padding: '34px 24px' }}>
      <Header job={job} />
      <AgentStrip job={job} active={running ? lastAgent : undefined} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 18, marginTop: 18, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 18 }}>
          {job.service === 'company-brief' ? <Brief job={job} /> : <Leads job={job} />}
          <Steps job={job} />
        </div>
        <div style={{ display: 'grid', gap: 18, position: 'sticky', top: 76 }}>
          <Money job={job} />
          <Timeline events={events} running={running} />
        </div>
      </div>
    </main>
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
  const title = job.service === 'company-brief' ? `Company brief${job.live.company ? `: ${job.live.company.name}` : ''}` : `Lead list${job.live.intake?.count ? `: ${job.live.intake.count} leads` : ''}`;
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div>
        <div className="eyebrow">
          {job.id} {job.runs > 1 && `· run ${job.runs}`} {job.tag && `· ${job.tag}`}
        </div>
        <h2 style={{ marginTop: 8 }}>{title}</h2>
        <div className="muted" style={{ whiteSpace: 'pre-line', fontSize: 14 }}>
          {job.brief}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <StatusPill status={job.status} />
        {job.status === 'paused' && (
          <button className="btn" style={{ height: 34 }} onClick={() => api(`/jobs/${job.id}/approve`, { method: 'POST' })}>
            Approve 50% more budget
          </button>
        )}
        {job.status === 'failed' && (
          <button className="btn" style={{ height: 34 }} onClick={() => api(`/jobs/${job.id}/resume`, { method: 'POST' })}>
            Resume from last step
          </button>
        )}
      </div>
    </div>
  );
}

function AgentStrip({ job, active }: { job: JobView; active?: AgentId }) {
  const ids: AgentId[] = ['lead', 'cfo', 'records', 'field', 'arbiter', 'verifier', 'writer'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gap: 8, marginTop: 22 }}>
      {ids.map((a) => {
        const spent = job.spend.byAgent?.[a]?.usd ?? 0;
        const on = active === a;
        return (
          <div
            key={a}
            className="card"
            style={{
              padding: '10px 12px',
              borderColor: on ? AGENTS[a].color : undefined,
              boxShadow: on ? `0 0 0 3px color-mix(in srgb, ${AGENTS[a].color} 18%, transparent)` : undefined,
              transition: 'box-shadow .2s, border-color .2s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 620, color: AGENTS[a].color, fontSize: 14 }}>
              {on && <span className="dot" style={{ animation: 'pulse 1s infinite' }} />}
              {AGENTS[a].name}
            </div>
            <div className="mono muted" style={{ fontSize: 11.5 }}>
              {spent ? cents(spent) : '·'}
            </div>
          </div>
        );
      })}
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
      <div className="eyebrow">The money</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10 }}>
        <span style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em' }}>{usd(job.result?.priceUsd ?? q?.priceUsd)}</span>
        <span className="muted" style={{ fontSize: 13 }}>
          price
        </span>
      </div>
      <div style={{ marginTop: 14, fontSize: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="muted">Spent</span>
          <span className="mono">
            {usd(spent, 4)} / {usd(q?.budgetUsd, 4)} cap
          </span>
        </div>
        <div style={{ height: 8, background: '#eeeee8', borderRadius: 99, marginTop: 6, overflow: 'hidden' }}>
          <div style={{ width: `${pctBudget}%`, height: '100%', background: pctBudget > 85 ? 'var(--conflict)' : 'var(--agree)', transition: 'width .4s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
          <span className="muted">Models · {job.spend.llmCalls} calls</span>
          <span className="mono">{usd(job.spend.llmUsd, 4)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="muted">Data · {job.spend.toolCalls} calls</span>
          <span className="mono">
            {job.spend.credits.toFixed(2)} cr · {usd(job.spend.creditsUsd, 4)}
          </span>
        </div>
        {books && (
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
            <span>Margin</span>
            <span className="mono" style={{ color: 'var(--agree)', fontWeight: 600 }}>
              {books.marginPct}% · {books.vsEstimate}% of estimate
            </span>
          </div>
        )}
      </div>
      {job.traces.length > 0 && (
        <div style={{ marginTop: 14, fontSize: 12 }}>
          <div className="muted">neatlogs trace{job.traces.length > 1 ? 's' : ''}</div>
          {job.traces.map((t) => (
            <div key={t} className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {t}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Timeline({ events, running }: { events: JobEvent[]; running: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' });
  }, [events.length]);
  const mark: Record<string, string> = { retry: '↻', recover: '✚', conflict: '⚡', resolve: '⚖', check: '✓', money: '$', error: '✕' };
  return (
    <div className="card" style={{ padding: '16px 0 6px' }}>
      <div className="eyebrow" style={{ padding: '0 18px' }}>
        What the team is doing {running && <span className="live" style={{ color: 'var(--agree)' }}>● live</span>}
      </div>
      <div ref={box} style={{ maxHeight: 460, overflow: 'auto', padding: '8px 18px', marginTop: 4 }}>
        {events.map((e) => (
          <div key={e.seq} className="fade-in" style={{ display: 'grid', gridTemplateColumns: '68px 1fr', gap: 8, padding: '6px 0', fontSize: 13, borderBottom: '1px dashed var(--line)' }}>
            <span style={{ color: AGENTS[e.agent]?.color, fontWeight: 600 }}>{AGENTS[e.agent]?.name}</span>
            <span style={{ color: e.kind === 'error' ? 'var(--conflict)' : e.kind === 'recover' ? 'var(--agree)' : 'var(--ink-2)' }}>
              {mark[e.kind] && <b style={{ marginRight: 5 }}>{mark[e.kind]}</b>}
              {e.text}
            </span>
          </div>
        ))}
        {!events.length && <div className="muted" style={{ fontSize: 13 }}>Waiting for the team…</div>}
      </div>
    </div>
  );
}

function Steps({ job }: { job: JobView }) {
  if (!job.steps.length) return null;
  return (
    <details className="card pad">
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Checkpoints ({job.steps.filter((s) => s.status === 'done').length} saved steps)</summary>
      <p className="muted" style={{ fontSize: 13 }}>
        Every step is saved when it finishes. If the job stops, a resume skips straight past these and pays nothing twice.
      </p>
      <table className="t">
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
    </details>
  );
}

// ---- company brief -------------------------------------------------------------------------

function Brief({ job }: { job: JobView }) {
  const facts = job.result?.facts ?? job.live.facts;
  const rec = job.live.records ?? [];
  const fld = job.live.field ?? [];
  const byKey = (xs: Claim[], k: string) => xs.find((c) => c.key === k);
  const rows = FACT_LABELS.map(([k, label]) => facts?.find((f: Fact) => f.key === k) ?? ({ key: k, label, value: null, agreement: 'neither', chosen: '', reason: '', records: byKey(rec, k), field: byKey(fld, k) } as Fact));
  const points: { text: string; cites: string[] }[] = job.result?.points ?? [];

  return (
    <>
      <div className="card pad">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>Two angles, side by side</h3>
          {job.result?.stats && (
            <span className="muted" style={{ fontSize: 13 }}>
              {job.result.stats.verified}/{job.result.stats.facts} verified · {job.result.stats.agreed} seen by both · {job.result.stats.conflicts} settled
            </span>
          )}
        </div>
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: '17%' }}>Fact</th>
              <th className="records" style={{ width: '27%' }}>
                Records <span className="muted">· database</span>
              </th>
              <th className="field" style={{ width: '33%' }}>
                Field <span className="muted">· open web</span>
              </th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.key} className="fade-in">
                <td style={{ fontWeight: 560 }}>{f.label}</td>
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

      {points.length > 0 && (
        <div className="card pad fade-in">
          <h3>Your brief</h3>
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
      )}
    </>
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
      {f.verified && f.key !== 'what' && <div className="mono">{clip(value, 60)}</div>}
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
