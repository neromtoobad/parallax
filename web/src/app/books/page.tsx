'use client';

import { useEffect, useState } from 'react';
import { api, cents, usd } from '@/lib/api';

export default function Books() {
  const [b, setB] = useState<any>(null);
  const [evals, setEvals] = useState<any[]>([]);
  useEffect(() => {
    api('/books').then(setB).catch(() => {});
    api<any[]>('/evals').then((e) => setEvals(e.sort((x, y) => x.label.localeCompare(y.label)))).catch(() => {});
  }, []);
  if (!b) return <main className="wrap" style={{ padding: 60 }}>Loading the books…</main>;

  return (
    <main className="wrap" style={{ padding: '40px 24px' }}>
      <div className="eyebrow">The CFO’s books</div>
      <h2 style={{ marginTop: 8 }}>What each job really costs, and what we charge</h2>
      <p className="muted" style={{ maxWidth: 680 }}>
        Every model call and data call is metered as it happens and charged to the agent that made it. The CFO prices the next job from these numbers (the 75th percentile of recent cost per unit), so quotes get sharper with every job.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 20 }}>
        {[
          ['Jobs delivered', `${b.totals.delivered}`],
          ['Revenue', usd(b.totals.revenueUsd)],
          ['Cost', usd(b.totals.costUsd, 4)],
          ['Gross margin', `${b.totals.marginPct.toFixed(1)}%`],
        ].map(([k, v]) => (
          <div key={k} className="card pad">
            <div className="muted" style={{ fontSize: 13 }}>
              {k}
            </div>
            <div style={{ fontSize: 28, fontWeight: 650, letterSpacing: '-0.02em' }}>{v}</div>
          </div>
        ))}
      </div>

      <div className="grid2" style={{ marginTop: 18 }}>
        {b.perService.map((s: any) => (
          <div key={s.service} className="card pad">
            <h3>{s.service === 'company-brief' ? 'Company brief' : 'Lead list'}</h3>
            <table className="t">
              <tbody>
                <tr>
                  <td className="muted">Delivered jobs measured</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {s.jobs}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Median cost per {s.unit}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {s.medianCostPerUnit == null ? '–' : usd(s.medianCostPerUnit, 4)}
                  </td>
                </tr>
                <tr>
                  <td className="muted">75th percentile (what the CFO prices from)</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {s.p75CostPerUnit == null ? '–' : usd(s.p75CostPerUnit, 4)}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Next quote{s.service === 'lead-list' ? ' (10 leads)' : ''}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {usd(s.nextQuote.priceUsd)} · cap {usd(s.nextQuote.budgetUsd, 3)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {evals.length > 0 && <Evals evals={evals} />}

      <div className="card" style={{ marginTop: 18 }}>
        <table className="t">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th style={{ textAlign: 'right' }}>vs estimate</th>
              <th style={{ textAlign: 'right' }}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {b.jobs.map((j: any) => (
              <tr key={j.id}>
                <td>
                  <a href={`/jobs/${j.id}`}>{j.service === 'company-brief' ? 'Company brief' : `Lead list (${j.units})`}</a>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {j.brief.split('\n')[0].slice(0, 60)} {j.tag && `· ${j.tag}`}
                  </div>
                </td>
                <td>{j.status}</td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {usd(j.books?.revenueUsd ?? 0)}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {cents(j.costUsd)}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {j.books?.vsEstimate != null ? `${j.books.vsEstimate}%` : '–'}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {j.books ? `${j.books.marginPct}%` : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Evals({ evals }: { evals: any[] }) {
  const briefs = (rows: any[]) => rows.filter((r) => r.service === 'company-brief');
  const leads = (rows: any[]) => rows.filter((r) => r.service === 'lead-list');
  const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');
  const metrics: [string, (rows: any[]) => string][] = [
    ['Facts seen from both angles', (r) => pct(sum(briefs(r), 'twoAngle'), sum(briefs(r), 'facts'))],
    ['Facts verified', (r) => pct(sum(briefs(r), 'verified'), sum(briefs(r), 'facts'))],
    ['Gold facts wrong', (r) => `${sum(briefs(r), 'goldWrong')} of ${briefs(r).length * 2}`],
    ['Brief points with guesswork', (r) => pct(sum(briefs(r), 'hedgedPoints'), sum(briefs(r), 'points'))],
    ['Avg cost per brief', (r) => usd(sum(briefs(r), 'costUsd') / Math.max(1, briefs(r).length), 4)],
    ['Leads delivered / wanted', (r) => `${sum(leads(r), 'verified')}/${sum(leads(r), 'wanted')}`],
    ['Cost per delivered lead', (r) => usd(sum(leads(r), 'costUsd') / Math.max(1, sum(leads(r), 'verified')), 4)],
  ];
  return (
    <div className="card pad" style={{ marginTop: 18 }}>
      <h3>Evals: the same fixed jobs, run on each version of the team</h3>
      <table className="t">
        <thead>
          <tr>
            <th>Metric</th>
            {evals.map((e) => (
              <th key={e.label}>{e.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map(([name, f]) => (
            <tr key={name}>
              <td>{name}</td>
              {evals.map((e) => (
                <td key={e.label} className="mono">
                  {f(e.rows)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
