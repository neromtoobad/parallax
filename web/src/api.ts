// The server's API, its types, and the live event stream.
import { useEffect, useState } from 'react';

export type Field = { key: string; label: string; hint?: string; long?: boolean; optional?: boolean };
export type Service = { id: string; name: string; blurb: string; priceUsd: number; team: string[]; fields: Field[]; example: Record<string, string> };
export type Agent = { id: string; role: string; name: string; title: string; look: string; about: string; account: string; url: string | null; rep: number; active: boolean };
export type Lot = {
  id: number; title: string; roles: string[]; reserve: number; status: string; tx?: string; round?: number;
  bids: { agent: string; role: string; price: number }[]; winner?: string; winnerRole?: string; bid?: number; pay?: number;
  quotes?: { handle: string; price: number; quality: number; entered: boolean; why: string }[];
  hire?: { handle: string; taskId: string; usd: number };
};
export type Step = { at: string; agent: string; kind: string; text: string; account?: string };
export type Receipt = { at: string; agent: string; vendor: string; usd: number; reason: string; dry: boolean; account?: string; settledTx?: string };
export type Lead = { name: string; kind: string; address: string; website?: string; phone?: string; email?: string; osm: string; fit: number; why: string; opener: string; note?: string };
export type Order = {
  id: string; service: string; input?: Record<string, string>; brief?: string; priceUsd: number; customer: string;
  state: 'quoted' | 'funded' | 'bidding' | 'working' | 'delivered' | 'accepted' | 'failed';
  createdAt: string; txs: { what: string; hash: string; url: string }[]; lots: Lot[]; steps: Step[]; receipt: Receipt[];
  delivery?: {
    summary: string; check: { pass: boolean; notes: string[] };
    leads?: Lead[]; email?: { subject: string; body: string }; csv?: string;
    site?: { path: string }; flyers?: { name: string; svg: string; w: number; h: number }[];
  };
  error?: string;
};
export type Info = { mode: string; model: string; bank: string | null; explorer: string | null; usdc: string | null; search: boolean };
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
  quote: (service: string, input: Record<string, string>) => req<Order>('/api/orders', { service, input }),
  pay: (id: string) => req<Order>(`/api/orders/${id}/pay`, { wallet: 'demo' }),
  accept: (id: string) => req<Order>(`/api/orders/${id}/accept`, {}),
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
