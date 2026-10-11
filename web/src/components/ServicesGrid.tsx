'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DEPTS, SERVICES, type Dept } from '@/lib/catalog';
import { CAST, sprite } from '@/lib/cast';

/** The menu, grouped by department. Services the API doesn't offer yet show as coming soon. */
export function ServicesGrid() {
  const [live, setLive] = useState<Set<string> | null>(null);
  useEffect(() => {
    api<{ id: string }[]>('/services')
      .then((s) => setLive(new Set(s.map((x) => x.id))))
      .catch(() => setLive(new Set()));
  }, []);

  return (
    <div style={{ display: 'grid', gap: 28, marginTop: 36 }}>
      {(Object.keys(DEPTS) as Dept[]).map((d) => (
        <div key={d}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 22, color: DEPTS[d].color }}>{DEPTS[d].name}</span>
            <span className="muted" style={{ fontSize: 14.5 }}>
              {DEPTS[d].line}
            </span>
          </div>
          <div className="grid3">
            {SERVICES.filter((s) => s.dept === d).map((s) => {
              const ready = !live || live.has(s.id);
              return (
                <div key={s.id} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', opacity: ready ? 1 : 0.6 }}>
                  <div style={{ display: 'flex', gap: 14 }}>
                    <div style={{ flex: 1 }}>
                      <div className="mono" style={{ color: DEPTS[d].color, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {s.tagline}
                      </div>
                      <h3 style={{ fontSize: 20, marginTop: 6, fontFamily: 'var(--display)' }}>{s.name}</h3>
                      <p style={{ fontSize: 14, color: 'var(--ink-2)', margin: '6px 0 0' }}>{s.blurb}</p>
                    </div>
                    <div style={{ width: 70, flex: 'none', display: 'flex', alignItems: 'flex-end' }}>
                      <img src={sprite(s.face, 'idle')} alt={CAST[s.face].name} style={{ height: 118, width: 'auto' }} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, margin: '16px 0 14px', fontSize: 12.5 }}>
                    <div style={{ background: 'var(--records-soft)', borderRadius: 10, padding: '8px 10px' }}>
                      <div style={{ color: 'var(--records)', fontWeight: 700 }}>Records</div>
                      <div style={{ color: 'var(--ink-2)' }}>{s.angles[0]}</div>
                    </div>
                    <div style={{ background: 'var(--field-soft)', borderRadius: 10, padding: '8px 10px' }}>
                      <div style={{ color: 'var(--field)', fontWeight: 700 }}>Field</div>
                      <div style={{ color: 'var(--ink-2)' }}>{s.angles[1]}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 16 }}>
                    <b>You get:</b> {s.deliverable}
                  </div>
                  <div style={{ marginTop: 'auto' }}>
                    {ready ? (
                      <Link className="btn sm" href={`/hire/${s.id}`}>
                        Get a quote
                      </Link>
                    ) : (
                      <span className="pill">Coming soon</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
