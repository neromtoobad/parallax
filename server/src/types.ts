export type ServiceId = 'company-brief' | 'lead-list';

export type AgentId = 'lead' | 'cfo' | 'records' | 'field' | 'arbiter' | 'verifier' | 'writer';

export type JobStatus =
  | 'quoted' // waiting for the client to accept the price
  | 'running'
  | 'paused' // stopped by the CFO (budget) and waiting for a decision
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface Quote {
  priceUsd: number;
  estCostUsd: number;
  /** Hard cap on spend. The CFO stops the job before it goes past this. */
  budgetUsd: number;
  /** How the estimate was made: past jobs of this kind, or a prior when there are none. */
  basis: string;
  sampleSize: number;
}

export interface Spend {
  llmUsd: number;
  credits: number;
  creditsUsd: number;
  totalUsd: number;
  llmCalls: number;
  toolCalls: number;
  byAgent: Partial<Record<AgentId, { usd: number; credits: number }>>;
}

export interface StepRecord {
  key: string;
  agent: AgentId;
  status: 'done' | 'failed';
  output?: unknown;
  error?: string;
  attempts: number;
  startedAt: number;
  endedAt: number;
  costUsd: number;
}

/** One fact as one angle saw it. */
export interface Claim {
  key: string;
  value: string | number | null;
  source: string; // 'crustdata' or a URL
  quote?: string; // exact text on the source page that supports the value
  asOf?: string;
}

export type Agreement = 'agree' | 'conflict' | 'records-only' | 'field-only' | 'neither';

export interface Resolved {
  key: string;
  label: string;
  value: string | number | null;
  agreement: Agreement;
  chosen: 'records' | 'field' | 'tiebreak' | 'both' | 'none';
  reason: string;
  records?: Claim;
  field?: Claim;
  tiebreak?: Claim;
  verified?: boolean;
  check?: string;
}

export interface Lead {
  company: { name: string; domain: string; description?: string; headcount?: number | null; country?: string | null };
  person?: { name: string; title: string; profileUrl?: string | null; since?: string | null };
  fit: string;
  checks: { name: string; ok: boolean; note: string }[];
  status: 'verified' | 'dropped';
  dropReason?: string;
}

export interface Job {
  id: string;
  service: ServiceId;
  brief: string;
  input: Record<string, any>;
  client?: { name?: string; email?: string };
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  quote?: Quote;
  plan?: unknown;
  steps: Record<string, StepRecord>;
  spend: Spend;
  result?: any;
  error?: string;
  /** neatlogs trace ids for each time the job ran (a resumed job has more than one). */
  traces: string[];
  runs: number;
  eventCount?: number;
  /** Set when started by the eval harness, so the books can tell test runs from client jobs. */
  tag?: string;
}

export interface JobEvent {
  seq: number;
  at: number;
  agent: AgentId | 'system';
  kind: 'step' | 'say' | 'tool' | 'retry' | 'recover' | 'conflict' | 'resolve' | 'check' | 'money' | 'status' | 'error';
  text: string;
  data?: unknown;
}

export function emptySpend(): Spend {
  return { llmUsd: 0, credits: 0, creditsUsd: 0, totalUsd: 0, llmCalls: 0, toolCalls: 0, byAgent: {} };
}
