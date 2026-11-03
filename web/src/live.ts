// One job as it happens: the saved order, plus what the event stream says about its lots, steps and calls
// before the order is saved again.
import { useEffect, useState } from 'react';
import { api, useEvents, type Event, type Order, type Receipt, type Step } from './api.ts';
import type { LiveLot } from './parts.tsx';

/** The lots as the event stream tells it, phase by phase. */
export function applyLot(lots: LiveLot[], d: any): LiveLot[] {
  if (d.phase === 'plan') return d.lots.map((p: any, i: number) => ({ id: -1 - i, title: p.title, roles: p.roles, reserve: p.reserve, status: 'bidding', bids: [], sealed: [], quotes: [] }));
  const at = lots.findIndex((l) => l.id === d.lot) >= 0 ? lots.findIndex((l) => l.id === d.lot) : lots.findIndex((l) => l.title === d.title && l.id < 0);
  if (at < 0) return lots;
  const l = { ...lots[at] }, next = [...lots];
  next[at] = l;
  switch (d.phase) {
    case 'open': Object.assign(l, { id: d.lot, status: 'bidding', ...(d.round > 1 ? { round: d.round, bids: [], sealed: [], quotes: [], winner: undefined, pay: undefined } : {}) }); break;
    case 'commit': l.sealed = [...(l.sealed ?? []), d.agent]; break;
    case 'quote': l.quotes = [...(l.quotes ?? []), { handle: d.agent, price: d.price, quality: d.quality, entered: d.entered, why: d.why ?? '' }]; break;
    case 'reveal': l.bids = [...l.bids, { agent: d.agent, role: d.role, price: d.price }]; break;
    case 'award': Object.assign(l, { status: 'awarded', winner: d.role === 'outside' ? `outside:${d.winner}` : d.winner, bid: d.bid, pay: d.pay, tx: d.tx }); break;
    case 'void': l.status = 'void'; break;
    case 'pass-inspection': l.status = 'passed'; break;
    case 'fail-inspection': l.status = 'failed'; break;
  }
  return next;
}

export type LiveJob = { o?: Order; lots: LiveLot[]; steps: Step[]; receipt: Receipt[]; missing: boolean; setO: (o: Order) => void };

/** Follow one job: load it, then keep it current from the event stream. */
export function useJob(id?: string): LiveJob {
  const [o, setO] = useState<Order>();
  const [lots, setLots] = useState<LiveLot[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [receipt, setReceipt] = useState<Receipt[]>([]);
  const [missing, setMissing] = useState(false);
  const load = () => id && api.order(id).then((x) => { setO(x); if (x.lots.length && x.state !== 'bidding') setLots([]); }).catch(() => setMissing(true));
  useEffect(() => { setO(undefined); setLots([]); setSteps([]); setReceipt([]); void load(); }, [id]);
  useEvents(id, (e: Event) => {
    if (!id) return;
    if (e.type === 'lot') setLots((l) => applyLot(l, e.data));
    if (e.type === 'step') setSteps((s) => (s.some((x) => x.at === e.data.at && x.text === e.data.text) ? s : [...s, e.data]));
    if (e.type === 'receipt') setReceipt((r) => [...r, { at: new Date(e.at).toISOString(), ...e.data }]);
    if (e.type === 'order' || e.type === 'bill') void load();
  });
  return { o, lots, steps, receipt, missing, setO };
}

/** What to draw: the saved order once it has caught up, the live stream before that. */
export function shown(j: LiveJob) {
  const o = j.o!;
  const lots: LiveLot[] = j.lots.length && (o.state === 'bidding' || o.state === 'working' || !o.lots.length) ? j.lots : o.lots;
  const steps = o.steps.length >= j.steps.length ? o.steps : j.steps;
  const receipt = o.receipt.length >= j.receipt.length ? o.receipt : j.receipt;
  return { lots, steps, receipt };
}
