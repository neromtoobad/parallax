'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, type AgentId, type JobEvent } from '@/lib/api';
import { AGENT_IDS, CAST, Studio, type AgentState, type Pose } from './Studio';

type Beat = { agent: Exclude<AgentId, 'system'>; text: string; kind: string };

const SCRIPT: Beat[] = [
  { agent: 'lead', kind: 'step', text: 'Work order: company brief on Linear, for a sales call next week.' },
  { agent: 'cfo', kind: 'money', text: 'Quoted $2. Hard cap: $0.30. Nobody spends past it.' },
  { agent: 'records', kind: 'tool', text: 'Database: founded 2019, 291 staff, CEO Karri Saarinen.' },
  { agent: 'field', kind: 'tool', text: 'Reading linear.app/about on my own. Founded 2019.' },
  { agent: 'arbiter', kind: 'resolve', text: '4 facts agree, 3 from one angle. Nothing to settle.' },
  { agent: 'verifier', kind: 'check', text: 'Quote is on the page and says the value. 7 of 7 verified.' },
  { agent: 'writer', kind: 'say', text: 'Brief written. Every line cites a verified fact.' },
  { agent: 'cfo', kind: 'money', text: 'Delivered. Cost $0.16, margin 92%.' },
];

const POSE_FOR: Record<string, Pose> = { conflict: 'talk', resolve: 'talk', money: 'talk', check: 'work', retry: 'work', recover: 'work', tool: 'work', step: 'talk', say: 'work' };

/** The observatory, replaying a real delivered job beat by beat (or a scripted one until a job exists). */
export function HeroReplay() {
  const [beats, setBeats] = useState<Beat[]>(SCRIPT);
  const [label, setLabel] = useState<{ id: string; brief: string } | null>(null);
  const [i, setI] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const jobs = await api<any[]>('/jobs');
        const pick = jobs.find((j) => j.status === 'delivered' && !j.tag?.startsWith('eval') && j.service === 'company-brief') ?? jobs.find((j) => j.status === 'delivered');
        if (!pick) return;
        const evs = await api<JobEvent[]>(`/jobs/${pick.id}/log`);
        const real = evs
          .filter((e) => e.agent !== 'system' && e.kind !== 'retry')
          .map((e) => ({ agent: e.agent as Beat['agent'], text: e.text, kind: e.kind }))
          .filter((b, k, xs) => k === 0 || b.text !== xs[k - 1].text);
        if (real.length >= 5) {
          setBeats(real.slice(0, 18));
          setLabel({ id: pick.id, brief: pick.brief.split('\n')[0] });
          setI(0);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % (beats.length + 2)), 2300);
    return () => clearInterval(t);
  }, [beats.length]);

  const states = useMemo(() => {
    const out: Partial<Record<(typeof AGENT_IDS)[number], AgentState>> = {};
    const done = i >= beats.length;
    const seen = new Set(beats.slice(0, i).map((b) => b.agent));
    for (const a of AGENT_IDS) out[a] = { pose: done ? 'done' : seen.has(a) ? 'idle' : 'idle' };
    const b = beats[i];
    if (b) out[b.agent] = { pose: POSE_FOR[b.kind] ?? 'work', on: true, bubble: clip(b.text, 110) };
    if (done) out.cfo = { pose: 'done', on: true, bubble: 'Delivered and verified. Next job?' };
    return out;
  }, [beats, i]);

  return (
    <div>
      <Studio states={states} />
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
        <span className="pill live" style={{ background: '#fff', border: '1px solid var(--line)' }}>
          <span className="dot" style={{ color: 'var(--agree)' }} />
          {label ? (
            <>
              Replaying a real job: <Link href={`/jobs/${label.id}`} style={{ textDecoration: 'underline' }}>{clip(label.brief.replace(/^Company /, ''), 48)}</Link>
            </>
          ) : (
            'How a job runs, beat by beat'
          )}
        </span>
      </div>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export { CAST };
