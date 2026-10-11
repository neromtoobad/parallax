'use client';

import { useState } from 'react';
import { AGENT_IDS, CAST, sprite } from '@/lib/cast';

const LINES: Record<string, string> = {
  lead: 'Reads your brief and turns it into a work order.',
  cfo: 'Quotes from real past costs, and stops the job before it goes over budget.',
  records: 'Company and people databases: who they are, how big, who holds which role.',
  field: 'The open web, on its own. Never sees what Records found.',
  arbiter: 'When the two angles disagree, finds a tiebreaker and writes down why.',
  verifier: 'A claim only counts if its quote is really on the page and really says it.',
  writer: 'Writes from verified facts only. A line that guesses gets sent back.',
};

const ORDER = ['lead', 'cfo', 'records', 'field', 'arbiter', 'verifier', 'writer'] as const;

/** The cast in a single row. Pick one to hear what they do. */
export function TeamRow() {
  const [pick, setPick] = useState<(typeof ORDER)[number]>('field');
  return (
    <div>
      <div className="team-row">
        {ORDER.filter((a) => AGENT_IDS.includes(a)).map((a) => (
          <button key={a} className={`team-member ${pick === a ? 'on' : ''}`} onClick={() => setPick(a)} onMouseEnter={() => setPick(a)} style={{ ['--c' as any]: CAST[a].color }}>
            <img src={sprite(a, pick === a ? 'talk' : 'idle')} alt={CAST[a].name} />
            <span>{CAST[a].name}</span>
          </button>
        ))}
      </div>
      <p className="team-line fade-in" key={pick}>
        <b style={{ color: CAST[pick].color }}>{CAST[pick].name}.</b> {LINES[pick]}
      </p>
    </div>
  );
}
