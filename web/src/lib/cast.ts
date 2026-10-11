import type { AgentId } from './api';

export type Pose = 'idle' | 'work' | 'talk' | 'done';

export interface AgentState {
  pose: Pose;
  bubble?: string;
  on?: boolean;
  dim?: boolean;
}

/** Where each agent stands in the observatory, as % of the scene (x = feet centre, y = floor line). */
export const STATIONS: Record<Exclude<AgentId, 'system'>, { x: number; y: number; room: string }> = {
  verifier: { x: 32.2, y: 62.4, room: 'Inspection desk' },
  cfo: { x: 61.9, y: 62.4, room: 'The vault' },
  lead: { x: 71.9, y: 62.4, room: 'Planning board' },
  writer: { x: 91.1, y: 62.4, room: 'Writing nook' },
  records: { x: 14.7, y: 93.0, room: 'Records archive' },
  arbiter: { x: 63.1, y: 93.0, room: "Arbiter's bench" },
  field: { x: 79.4, y: 93.0, room: 'Field room' },
};

export const CAST: Record<Exclude<AgentId, 'system'>, { name: string; role: string; color: string }> = {
  lead: { name: 'Lead', role: 'Turns your brief into a plan', color: 'var(--lead)' },
  cfo: { name: 'CFO', role: 'Prices the job, holds the budget', color: 'var(--cfo)' },
  records: { name: 'Records', role: 'Reads the company databases', color: 'var(--records)' },
  field: { name: 'Field', role: 'Reads the open web, on its own', color: 'var(--field)' },
  arbiter: { name: 'Arbiter', role: 'Settles every disagreement', color: 'var(--arbiter)' },
  verifier: { name: 'Verifier', role: 'Checks each claim at its source', color: 'var(--verifier)' },
  writer: { name: 'Writer', role: 'Writes from verified facts only', color: 'var(--writer)' },
};

export const AGENT_IDS = Object.keys(STATIONS) as (keyof typeof STATIONS)[];

export function sprite(agent: string, pose: Pose) {
  return `/agents/${agent}-${pose}.webp`;
}

