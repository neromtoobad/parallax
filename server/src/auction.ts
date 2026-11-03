// The auction rule on its own, with no chain and no models: how a job splits into lots, how an agent prices
// a lot, and how the bank awards one. lots.ts runs it for real jobs (against the bank, or in memory in demo
// mode) and scripts/swarm-sim.ts runs it for hundreds of scripted ones. `award` mirrors `award` in
// contracts/near/src/lib.rs; keep the two in step.
import { createHash } from 'node:crypto';
import type { Role } from './wallets.ts';

/** The parts of a job. A lot exists when the service's team has someone for it. */
export const GROUPS: { title: string; roles: Role[] }[] = [
  { title: 'Research', roles: ['researcher', 'scout', 'reader', 'investigator'] },
  { title: 'Writing', roles: ['writer', 'analyst'] },
  { title: 'Visuals', roles: ['illustrator', 'producer'] },
  { title: 'Checking', roles: ['auditor'] },
];

export const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** A team agent's quality in basis points, from its reputation (0–1000). The bank's `quality`. */
export const quality = (rep: number) => 5000 + 5 * rep;

/**
 * How an agent prices a lot: its expected model bill for that part of the job, plus a markup that is its own
 * (some agents run lean, some don't). A Vickrey auction pays the runner-up's price, so bidding your real cost
 * plus the margin you need is the best an agent can do; overbidding only loses lots.
 */
export function bidFor(account: string, costUsd: number, rep: number, reserveUsd: number): number | undefined {
  const lean = (parseInt(createHash('sha256').update(account).digest('hex').slice(0, 4), 16) % 1000) / 1000; // 0..1, fixed per agent
  const markup = 0.15 + 0.45 * lean - (rep - 500) / 4000; // a strong record lets an agent ask a little more
  const price = r6(Math.max(0.001, costUsd * (1 + Math.max(0.05, markup))));
  return price <= reserveUsd ? price : undefined;
}

/**
 * The lots for a job: the groups its team covers, with reserves split by expected cost. Together they leave at
 * least `minMarginBps` of the price (and 5% more) as margin.
 */
export function planLots(team: readonly string[], spend: Partial<Record<Role, number>>, priceUsd: number, minMarginBps: number) {
  const has = new Set(team);
  const groups = GROUPS.map((g) => ({ ...g, roles: g.roles.filter((r) => has.has(r)) }))
    .filter((g) => g.roles.length)
    .map((g) => ({ ...g, cost: r6(g.roles.reduce((t, r) => t + (spend[r] ?? 0.01), 0)) }));
  const budget = priceUsd * (1 - minMarginBps / 1e4) * 0.95;
  const weight = groups.reduce((t, g) => t + Math.max(g.cost, 0.02), 0);
  return groups.map((g) => ({ ...g, reserve: Math.floor((budget * Math.max(g.cost, 0.02)) / weight * 1e4) / 1e4 }));
}

/**
 * Quality in basis points, on the bank's scale (a team agent with a starting record scores 7,500): the
 * agent's success rate, pulled toward 40% until it has a record, so a new agent has to be cheaper to win.
 */
export function qualityBps(delivered: number, successPct: number | null): number {
  const prior = 40, weight = 3;
  const rate = ((successPct ?? prior) * delivered + prior * weight) / (delivered + weight);
  return Math.max(1000, Math.min(10_000, Math.round(5000 + 50 * rate)));
}

/**
 * Whether an outside agent's record is good enough to enter: an agent that has failed more than one task in five
 * over at least five is left out. Its failures cost it nothing (the market charges on delivery) but cost the job
 * a rebid, and a low enough price would otherwise beat any quality weighting (the swarm simulation showed it).
 */
export const goodRecord = (delivered: number, successPct: number | null) => delivered < 5 || (successPct ?? 100) >= 80;

/** A revealed bid: the team agent's account or an outside handle, its price, and its quality in basis points. */
export type Sealed = { who: string; price: number; q: number; team: boolean };

/**
 * The bank's award: the lowest price per unit of quality wins (a team agent wins a tie). A team winner is paid
 * the price that would tie the runner-up, between its own bid and the reserve; a sole bidder gets the reserve;
 * an outside winner gets its own quote.
 */
export function award(bids: Sealed[], reserve: number): { winner: Sealed; pay: number; runnerUp?: Sealed } | undefined {
  const all = [...bids].sort((a, b) => a.price * b.q - b.price * a.q || Number(b.team) - Number(a.team) || a.who.localeCompare(b.who));
  const [w, next] = all;
  if (!w) return undefined;
  const pay = !w.team ? w.price : next ? Math.min(reserve, Math.max(w.price, r6((next.price * w.q) / next.q))) : reserve;
  return { winner: w, pay, runnerUp: next };
}
