'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DEPTS, SERVICES, type Dept } from '@/lib/catalog';
import { sprite } from '@/lib/cast';

/** One department at a time: a few roomy cards instead of a wall of them. */
export function ServicesGrid() {
  const [dept, setDept] = useState<Dept>('sales');
  const [live, setLive] = useState<Set<string> | null>(null);
  useEffect(() => {
    api<{ id: string }[]>('/services')
      .then((s) => setLive(new Set(s.map((x) => x.id))))
      .catch(() => setLive(new Set()));
  }, []);
  const list = SERVICES.filter((s) => s.dept === dept);

  return (
    <div>
      <div className="tabs" role="tablist">
        {(Object.keys(DEPTS) as Dept[]).map((d) => (
          <button key={d} role="tab" aria-selected={d === dept} className={d === dept ? 'tab on' : 'tab'} onClick={() => setDept(d)} style={{ ['--c' as any]: DEPTS[d].color }}>
            {DEPTS[d].name}
          </button>
        ))}
      </div>
      <p className="muted" style={{ textAlign: 'center', margin: '18px 0 34px', fontSize: 16 }}>
        {DEPTS[dept].line}
      </p>
      <div className="svc-grid" key={dept}>
        {list.map((s) => {
          const ready = !live || live.has(s.id);
          const body = (
            <>
              <div className="svc-art" style={{ ['--c' as any]: DEPTS[dept].color }}>
                <img src={sprite(s.face, 'idle')} alt="" />
              </div>
              <div style={{ padding: '22px 24px 24px' }}>
                <h3 className="svc-name">{s.name}</h3>
                <p className="svc-blurb">{s.blurb}</p>
                <span className="svc-cta">{ready ? 'Get a quote →' : 'Coming soon'}</span>
              </div>
            </>
          );
          return ready ? (
            <Link key={s.id} href={`/hire/${s.id}`} className="card svc fade-in">
              {body}
            </Link>
          ) : (
            <div key={s.id} className="card svc fade-in" style={{ opacity: 0.55 }}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
