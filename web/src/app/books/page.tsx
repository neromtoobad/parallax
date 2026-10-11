'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, cents, usd } from '@/lib/api';
import { serviceById } from '@/lib/catalog';
import { sprite } from '@/lib/cast';

export default function Books() {
  const [b, setB] = useState<any>(null);
  useEffect(() => {
    api('/books').then(setB).catch(() => {});
  }, []);
  if (!b) return <main className="wrap" style={{ padding: 60 }}>Opening the books…</main>;
  const t = b.test;

  return (
    <main className="wrap" style={{ padding: '40px 24px' }}>
      <div className="card" style={{ display: 'flex', gap: 24, alignItems: 'flex-end', padding: '26px 28px 0', overflow: 'hidden', background: 'color-mix(in srgb, var(--cfo) 7%, #fff)' }}>
        <div style={{ flex: 1, paddingBottom: 26 }}>
          <span className="eyebrow" style={{ color: 'var(--cfo)' }}>
            the cfo’s books
          </span>
          <h1 className="display" style={{ fontSize: 'clamp(34px, 4.6vw, 54px)', margin: '10px 0 10px' }}>
            What every job really costs.
          </h1>
          <p className="lede" style={{ fontSize: 17 }}>
            Every model call and every data call is metered as it happens and charged to the agent that made it. The CFO prices the next job from these numbers (the 75th percentile of recent cost per unit), so quotes get sharper with every job.
          </p>
        </div>
        <img src={sprite('cfo', 'work')} alt="The CFO" style={{ height: 250, width: 'auto' }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 18 }}>
        {[
          ['Client jobs delivered', `${b.totals.delivered}`, 'paid work from real clients'],
          ['Client revenue', usd(b.totals.revenueUsd), b.totals.revenueUsd ? `${b.totals.marginPct.toFixed(1)}% gross margin` : 'first clients this week'],
          ['Test and eval runs', `${t.delivered}`, `${usd(t.costUsd, 2)} real spend, not charged`],
          ['Value of those runs at list price', usd(t.revenueUsd), `${t.revenueUsd ? ((1 - t.costUsd / t.revenueUsd) * 100).toFixed(1) : 0}% margin had they been paid`],
        ].map(([k, v, sub]) => (
          <div key={k} className="card pad">
            <div className="muted" style={{ fontSize: 13 }}>
              {k}
            </div>
            <div style={{ fontFamily: 'var(--display)', fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em' }}>{v}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {sub}
            </div>
          </div>
        ))}
      </div>

      <h2 className="display" style={{ fontSize: 30, marginTop: 44 }}>
        Unit economics by service
      </h2>
      <div className="grid3" style={{ marginTop: 14 }}>
        {b.perService.map((s: any) => {
          const def = serviceById(s.service);
          return (
            <div key={s.service} className="card pad">
              <h3>{def?.name ?? s.service}</h3>
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
                      {s.medianCostPerUnit == null ? '–' : usd(s.medianCostPerUnit, 3)}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">75th percentile (priced from)</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {s.p75CostPerUnit == null ? '–' : usd(s.p75CostPerUnit, 3)}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Next quote</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {usd(s.nextQuote.priceUsd)} · cap {usd(s.nextQuote.budgetUsd, 2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <h2 className="display" style={{ fontSize: 30, marginTop: 44 }}>
        Every job, priced against what it cost
      </h2>
      <div className="card" style={{ marginTop: 14, overflowX: 'auto' }}>
        <table className="t" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Price</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th style={{ textAlign: 'right' }}>vs estimate</th>
              <th style={{ textAlign: 'right' }}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {b.jobs.map((j: any) => (
              <tr key={j.id}>
                <td>
                  <Link href={`/jobs/${j.id}`} style={{ fontWeight: 600 }}>
                    {serviceById(j.service)?.name ?? j.service}
                  </Link>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {j.brief.split('\n')[0].slice(0, 64)} {j.tag && <span className="pill" style={{ height: 18, fontSize: 10.5 }}>{j.tag}</span>}
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
