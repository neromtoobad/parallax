export type AgentId = 'lead' | 'cfo' | 'records' | 'field' | 'arbiter' | 'verifier' | 'writer' | 'system';

export interface JobEvent {
  seq: number;
  at: number;
  agent: AgentId;
  kind: string;
  text: string;
  data?: any;
}

export interface Quote {
  priceUsd: number;
  estCostUsd: number;
  budgetUsd: number;
  basis: string;
  sampleSize: number;
}

export interface JobView {
  id: string;
  service: 'company-brief' | 'lead-list';
  brief: string;
  input: Record<string, any>;
  status: 'quoted' | 'running' | 'paused' | 'delivered' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  quote?: Quote;
  spend: { llmUsd: number; credits: number; creditsUsd: number; totalUsd: number; llmCalls: number; toolCalls: number; byAgent: Record<string, { usd: number; credits: number }> };
  result?: any;
  error?: string;
  traces: string[];
  runs: number;
  tag?: string;
  steps: { key: string; agent: AgentId; status: string; attempts: number; startedAt: number; endedAt: number; costUsd: number; error?: string }[];
  live: {
    intake?: any;
    company?: { name: string; domain: string };
    records?: Claim[];
    field?: Claim[];
    sources?: { id: string; url: string; title: string }[];
    facts?: Fact[];
    leads?: any[];
  };
}

export interface Claim {
  key: string;
  value: string | number | null;
  source: string;
  quote?: string;
}

export interface Fact {
  key: string;
  label: string;
  value: string | number | null;
  agreement: 'agree' | 'conflict' | 'records-only' | 'field-only' | 'neither';
  chosen: string;
  reason: string;
  records?: Claim;
  field?: Claim;
  tiebreak?: Claim;
  verified?: boolean;
  check?: string;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const usd = (n: number | undefined | null, dp = 2) => (n == null ? '–' : `$${n.toFixed(dp)}`);
export const cents = (n: number | undefined | null) => (n == null ? '–' : n < 1 ? `${(n * 100).toFixed(1)}¢` : `$${n.toFixed(2)}`);

export const AGENTS: Record<AgentId, { name: string; role: string; color: string }> = {
  lead: { name: 'Lead', role: 'Turns the brief into a plan', color: 'var(--ink)' },
  cfo: { name: 'CFO', role: 'Prices the job, holds the budget', color: '#2f8a4c' },
  records: { name: 'Records', role: 'Reads the company database', color: 'var(--records)' },
  field: { name: 'Field', role: 'Reads the open web', color: 'var(--field)' },
  arbiter: { name: 'Arbiter', role: 'Settles disagreements', color: '#7a4fc2' },
  verifier: { name: 'Verifier', role: 'Checks every claim at its source', color: '#0f7c80' },
  writer: { name: 'Writer', role: 'Writes from verified facts only', color: '#5b6270' },
  system: { name: 'System', role: '', color: 'var(--ink-3)' },
};

export function fmtValue(key: string, v: unknown) {
  if (v == null || v === '') return '–';
  if (key === 'funding_total' && typeof v === 'number') return v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${v.toLocaleString()}`;
  if (key === 'headcount' && typeof v === 'number') return v.toLocaleString();
  if (key === 'last_round') return String(v).replace(/_/g, ' ');
  return String(v);
}

export function host(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url === 'crustdata' ? 'Crustdata database' : url;
  }
}
