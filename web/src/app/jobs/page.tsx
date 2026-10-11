'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, cents, usd } from '@/lib/api';

interface Row {
  id: string;
  service: string;
  brief: string;
  status: string;
  createdAt: number;
  priceUsd?: number;
  costUsd: number;
  stats?: any;
  tag?: string;
  runs: number;
}

export default function Jobs() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [showEval, setShowEval] = useState(false);
  useEffect(() => {
    const load = () => api<Row[]>('/jobs').then(setRows).catch(() => setRows([]));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const list = (rows ?? []).filter((r) => showEval || !r.tag?.startsWith('eval:'));
  return (
    <main className="wrap" style={{ padding: '40px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end' }}>
        <div>
          <div className="eyebrow">Jobs</div>
          <h2 style={{ marginTop: 8 }}>Everything the team has worked on</h2>
        </div>
        <label style={{ fontSize: 13 }} className="muted">
          <input type="checkbox" checked={showEval} onChange={(e) => setShowEval(e.target.checked)} /> include eval runs
        </label>
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <table className="t">
          <thead>
            <tr>
              <th>Job</th>
              <th>Brief</th>
              <th>Status</th>
              <th>Result</th>
              <th style={{ textAlign: 'right' }}>Price</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/jobs/${r.id}`} style={{ fontWeight: 560 }}>
                    {r.service === 'company-brief' ? 'Company brief' : 'Lead list'}
                  </Link>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {new Date(r.createdAt).toLocaleString()} {r.tag && `· ${r.tag}`}
                  </div>
                </td>
                <td style={{ fontSize: 13, maxWidth: 380 }}>{r.brief.split('\n')[0]}</td>
                <td>
                  <span className={`pill ${r.status === 'delivered' ? 'agree' : r.status === 'failed' ? 'conflict' : r.status === 'paused' ? 'warn' : ''}`}>{r.status}</span>
                  {r.runs > 1 && <div className="muted" style={{ fontSize: 11 }}>{r.runs} runs</div>}
                </td>
                <td style={{ fontSize: 13 }}>
                  {r.stats
                    ? r.service === 'company-brief'
                      ? `${r.stats.verified}/${r.stats.facts} facts verified`
                      : `${r.stats.verified}/${r.stats.wanted} leads`
                    : '–'}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {usd(r.priceUsd)}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {cents(r.costUsd)}
                </td>
              </tr>
            ))}
            {rows && !list.length && (
              <tr>
                <td colSpan={6} className="muted">
                  No jobs yet. <Link href="/#hire">Hire the team</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
