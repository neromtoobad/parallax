'use client';

import { useEffect, useState } from 'react';
import { api, usd } from '@/lib/api';

const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** Three numbers, first eval run against the latest, plus one story. */
export function Proof() {
  const [evals, setEvals] = useState<any[]>([]);
  useEffect(() => {
    api<any[]>('/evals')
      .then((e) => setEvals(e.sort((a, b) => a.label.localeCompare(b.label))))
      .catch(() => {});
  }, []);
  const first = evals[0];
  const last = evals[evals.length - 1];
  const b = (rows: any[]) => rows.filter((r) => r.service === 'company-brief');
  const l = (rows: any[]) => rows.filter((r) => r.service === 'lead-list');

  const tiles =
    first && last && first !== last
      ? [
          { k: 'wrong facts on the test set', z: `${sum(b(last.rows), 'goldWrong')}`, a: `${sum(b(last.rows), 'goldRight')} of ${b(last.rows).length * 2} right` },
          { k: 'brief lines that guess', z: `${pct(sum(b(last.rows), 'hedgedPoints'), sum(b(last.rows), 'points'))}%`, a: `was ${pct(sum(b(first.rows), 'hedgedPoints'), sum(b(first.rows), 'points'))}%` },
          { k: 'per verified lead', z: usd(sum(l(last.rows), 'costUsd') / Math.max(1, sum(l(last.rows), 'verified'))), a: `was ${usd(sum(l(first.rows), 'costUsd') / Math.max(1, sum(l(first.rows), 'verified')))}` },
        ]
      : [];

  return (
    <div>
      <div className="stats">
        {tiles.map((t) => (
          <div key={t.k}>
            <div className="stat-z">{t.z}</div>
            <div className="stat-k">{t.k}</div>
            <div className="stat-a">{t.a}</div>
          </div>
        ))}
      </div>
      <p className="proof-story">
        A real job was mid-run when the server restarted on production. The new server picked it up from its last saved step, paid for nothing twice, and delivered. <span className="muted">Every step is a checkpoint.</span>
      </p>
    </div>
  );
}
