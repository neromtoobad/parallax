'use client';

import { useEffect, useState } from 'react';
import { api, usd } from '@/lib/api';
import { sprite } from '@/lib/cast';

const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** Eval results across versions of the team, straight from the eval files. */
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

  const tiles = first && last && first !== last
    ? [
        { k: 'Facts seen from both angles', a: `${pct(sum(b(first.rows), 'twoAngle'), sum(b(first.rows), 'facts'))}%`, z: `${pct(sum(b(last.rows), 'twoAngle'), sum(b(last.rows), 'facts'))}%` },
        { k: 'Brief lines that guessed', a: `${pct(sum(b(first.rows), 'hedgedPoints'), sum(b(first.rows), 'points'))}%`, z: `${pct(sum(b(last.rows), 'hedgedPoints'), sum(b(last.rows), 'points'))}%` },
        { k: 'Cost per verified lead', a: usd(sum(l(first.rows), 'costUsd') / Math.max(1, sum(l(first.rows), 'verified'))), z: usd(sum(l(last.rows), 'costUsd') / Math.max(1, sum(l(last.rows), 'verified'))) },
        { k: 'Wrong facts on the test set', a: `${sum(b(first.rows), 'goldWrong')}`, z: `${sum(b(last.rows), 'goldWrong')}` },
      ]
    : [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 18, marginTop: 30 }} className="proof-grid">
      <div className="card pad">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>Evals: same jobs, every version</h3>
          {first && last && (
            <span className="mono muted">
              {first.label} → {last.label}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          {tiles.map((t) => (
            <div key={t.k} style={{ background: 'var(--bg)', borderRadius: 14, padding: 16 }}>
              <div className="muted" style={{ fontSize: 13 }}>
                {t.k}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
                <span className="mono muted" style={{ fontSize: 16, textDecoration: 'line-through' }}>
                  {t.a}
                </span>
                <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 32, letterSpacing: '-0.02em' }}>{t.z}</span>
              </div>
            </div>
          ))}
          {!tiles.length && <div className="muted">Loading eval runs…</div>}
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
          7 company briefs with known right answers (founding year, CEO) and 2 lead lists, run on each version. Every job is traced in neatlogs; the full tables and trace IDs are in the repo.
        </p>
      </div>
      <div className="card pad" style={{ position: 'relative', overflow: 'hidden' }}>
        <h3>It survived a crash on production</h3>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', paddingRight: 90 }}>
          A real job was running when new code went out and the server restarted mid-job. The new server found it, resumed from its last saved step (6 steps kept, nothing paid twice), rode out a wall of rate limits, and delivered: 7 of 7 facts verified.
        </p>
        <div className="mono muted" style={{ fontSize: 12, paddingRight: 90 }}>
          Every unit of work is a checkpoint. A job never starts over, and never pays twice.
        </div>
        <img src={sprite('verifier', 'done')} alt="" style={{ position: 'absolute', right: 10, bottom: 0, height: 150, width: 'auto' }} />
      </div>
    </div>
  );
}
