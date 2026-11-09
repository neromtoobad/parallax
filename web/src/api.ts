// The server's API, its types, and the live event stream.
import { useEffect, useState } from 'react';

export type Field = { key: string; label: string; hint?: string; long?: boolean; optional?: boolean };
export type Service = { id: string; name: string; blurb: string; priceUsd: number; team: string[]; fields: Field[]; example: Record<string, string> };
export type AgentProfile = {
  account: string; name: string; role: string; title?: string; about?: string; look?: string; active: boolean;
  crew?: { sponsor: string; state: string; note: string; joined: number };
  rep: number; wins: number; fails: number; earned: number; balance: number; bonded: number;
  lots: { id: number; job: string; title: string; round: number; status: string; won: boolean; failed: boolean; bid?: number; pay?: number; bond?: number }[];
  hired?: { id: string; parent: string; amount: number; state: string; winner?: string }[];
};
export type Agent = { id: string; role: string; name: string; title: string; look: string; about: string; account: string; url: string | null; rep: number; active: boolean };
export type Lot = {
  id: number; title: string; roles: string[]; reserve: number; status: string; tx?: string; round?: number;
  bids: { agent: string; role: string; price: number; why?: string; by?: string }[]; winner?: string; winnerRole?: string; bid?: number; pay?: number;
  quotes?: { handle: string; price: number; quality: number; entered: boolean; why: string }[];
  hire?: { handle: string; taskId: string; usd: number };
};
export type Step = { at: string; agent: string; kind: string; text: string; account?: string };
export type Receipt = { at: string; agent: string; vendor: string; usd: number; reason: string; dry: boolean; account?: string; settledTx?: string };
export type Lead = { name: string; kind: string; address: string; website?: string; phone?: string; email?: string; osm: string; fit: number; why: string; opener: string; note?: string };
export type PayAsset = { assetId: string; chain: string; symbol: string; decimals: number; price: number };
export type Order = {
  id: string; service: string; input?: Record<string, string>; brief?: string; priceUsd: number; customer: string;
  state: 'quoted' | 'funded' | 'bidding' | 'working' | 'delivered' | 'accepted' | 'rejected' | 'failed';
  createdAt: string; txs: { what: string; hash: string; url: string }[]; lots: Lot[]; steps: Step[]; receipt: Receipt[];
  delivery?: {
    summary: string; check: { pass: boolean; notes: string[] };
    leads?: Lead[]; email?: { subject: string; body: string }; csv?: string;
    site?: { path: string }; flyers?: { name: string; svg: string; w: number; h: number }[]; doc?: { title: string; markdown: string };
    factcheck?: { issues: { claim: string; problem: string; fix: string }[]; verdict: string };
  };
  error?: string;
  parent?: { id: string; lot: number; by: string };
  subs?: { id: string; title: string; by: string; amount: number; tx: string }[];
  intents?: { assetId: string; chain: string; symbol: string; address: string; memo?: string; amountIn: string; amountInUsd: number; refundTo: string; deadline: string; status: string; txs?: { chain: string; hash: string }[] };
};
export type Info = {
  mode: string; model: string; bank: string | null; explorer: string | null; usdc: string | null; search: boolean;
  canned: boolean; house: string | null; faucet: boolean; crew: string | null; board?: boolean;
  /** The bank's optional parts; the lean mainnet bank has none. Missing (an older server) means all. */
  features?: string[];
};
/** Whether this deployment's bank has an optional part (the crew, the board). */
export const has = (info: Info | undefined, f: 'crew' | 'board') => !info?.features || info.features.includes(f);
export type BoardJob = {
  id: string; title: string; brief: string; hash: string; days: number; budgetUsd: number; at: string; parent?: string; by?: string;
  state: string; customer?: string; order?: string; screen?: { pass: boolean; note: string; tx: string; signer?: string };
};
export type BoardLimits = { minUsd: number; maxUsd: number; minDays: number; maxDays: number; title: number; brief: number };
export type CrewSpec = { slug: string; name: string; role: string; playbook: string; knowledge: string; markup: number; search: boolean; style: string };
export type CrewMember = {
  agent: string; slug: string; name: string; sponsor: string; state: 'Review' | 'Active' | 'Rejected' | 'Retired'; note: string; joined: number;
  specHash: string; spec?: CrewSpec; role?: string; rep?: number; wins: number; fails: number; earned: number; balance: number;
  review?: { pass: boolean; note: string; flags: string[]; signer?: string; bill?: string; tx?: string; at: string };
};
export type WalletCall = { receiverId: string; method: string; deposit: string; args: Record<string, unknown> };
export type Event = { type: string; orderId?: string; data: any; at: number };

async function req<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? r.statusText);
  return d as T;
}
export const api = {
  info: () => req<Info>('/api/info'),
  services: () => req<Service[]>('/api/services'),
  team: () => req<Agent[]>('/api/team'),
  orders: () => req<{ id: string; service: string; state: string; priceUsd: number; createdAt: string }[]>('/api/orders'),
  order: (id: string) => req<Order>(`/api/orders/${id}`),
  quote: (service: string, input: Record<string, string>, customer?: string) => req<Order>('/api/orders', { service, input, customer }),
  pay: (id: string, wallet: 'demo' | 'own' = 'demo') => req<Order>(`/api/orders/${id}/pay`, { wallet }),
  payAssets: () => req<PayAsset[]>('/api/pay/assets'),
  payFromChain: (id: string, assetId: string, refundTo: string) => req<Order>(`/api/orders/${id}/intents`, { assetId, refundTo }),
  sentDeposit: (id: string, txHash: string) => req<Order>(`/api/orders/${id}/intents`, { txHash }),
  accept: (id: string, tx?: string) => req<Order>(`/api/orders/${id}/accept`, { tx }),
  reject: (id: string, tx?: string) => req<Order>(`/api/orders/${id}/reject`, { tx }),
  board: () => req<{ houseMax: number; limits: BoardLimits; jobs: BoardJob[] }>('/api/board'),
  draftPost: (p: { title: string; brief: string; budget: number; days: number }) => req<{ id: string; hash: string; flags: string[]; wallet: WalletCall; budget: number }>('/api/board/draft', p),
  housePost: (id: string) => req<{ tx: string; id: string }>('/api/board/post', { id }),
  agent: (account: string) => req<AgentProfile>(`/api/agent/${account}`),
  crew: () => req<{ operator: string | null; houseStake: number; minStake: number; crew: CrewMember[] }>('/api/crew'),
  saveSpec: (spec: Partial<CrewSpec>, stake: number) => req<{ hash: string; agent: string; flags: string[]; wallet: WalletCall; stake: number }>(`/api/crew/spec?stake=${stake}`, spec),
  enlist: (hash: string) => req<{ tx: string; agent: string }>('/api/crew/enlist', { hash }),
};

/** Load once. */
export function useLoad<T>(f: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [v, set] = useState<T>();
  useEffect(() => { let live = true; f().then((x) => live && set(x)).catch(() => {}); return () => { live = false; }; }, deps);
  return v;
}

/** Follow the event stream (one order's, or everything). */
export function useEvents(order: string | undefined, on: (e: Event) => void) {
  useEffect(() => {
    const es = new EventSource(`/api/events${order ? `?order=${order}` : ''}`);
    es.onmessage = (m) => { try { on(JSON.parse(m.data)); } catch { /* ping */ } };
    return () => es.close();
  }, [order]);
}

export const usd = (n?: number, d = 4) => (n === undefined ? '—' : n.toFixed(n >= 1 ? 2 : d));
