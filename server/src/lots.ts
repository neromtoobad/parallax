// Lots: how the team bids for a paid job (RULES.md 14–22). Once a customer funds a job, the CFO splits it
// into lots (research, writing, visuals, checking), each with a reserve: the most it will pay. Every agent
// whose role fits a lot seals a bid from its own NEAR account (commit), reveals it when bidding closes, and
// the bank awards each lot by Vickrey: the cheapest bid per unit of quality wins and is paid the
// runner-up's price. The winner then does that part of the job: every model call the service makes for
// those roles is booked to the winner, who pays for it from its own account (settle.ts). When the job is
// delivered, each winner files its work, the CFO inspects it, and the winner is paid its lot when the
// customer accepts. Demo mode runs the same auction in memory, so the office shows it without a chain.
import { randomBytes } from 'node:crypto';
import { DRY } from './config.ts';
import { publish } from './bus.ts';
import { NEAR, balanceOf, call, chainNow, events, fromUnits, hasKey, sha256, toUnits, view } from './near/chain.ts';
import { type Role } from './wallets.ts';
import { spendFor } from './cfo/treasury.ts';
import { findService } from './services/index.ts';
import type { Job } from './job.ts';
import type { ReceiptLine } from './meter.ts';
import { canHire, hire, receiptOf, researchQuotes } from './market.ts';
import { award as awardRule, bidFor, goodRecord, planLots as splitLots, quality, r6, GROUPS } from './auction.ts';
import { dropNotes, setNotes } from './notes.ts';

/** Who won a lot: its role and the NEAR account that does (and pays for) the work. */
export type Winner = { role: Role; account: string };

export type LotRecord = {
  id: number; title: string; roles: Role[]; reserve: number;
  bids: { agent: string; role: Role; price: number }[]; winner?: string; winnerRole?: Role; bid?: number; pay?: number;
  status: 'bidding' | 'awarded' | 'passed' | 'void' | 'failed'; tx?: string; round?: number;
  quotes?: { handle: string; price: number; quality: number; entered: boolean; why: string }[]; // from the Agent Market
  hire?: { handle: string; taskId: string; usd: number; receipt: string; textHash: string }; // an outside winner, hired
};

// Which roles' work a winner takes over in a job, by order id (job.ts reads it when a service creates the job).
const assigned = new Map<string, Partial<Record<Role, Winner>>>();
export const assignmentFor = (orderId?: string) => (orderId ? assigned.get(orderId) : undefined) ?? {};

/** An agent's short name: writer-2 for writer-2.team.parallax.testnet. */
export const agentName = (account: string) => account.split('.')[0];
// Demo mode's team: one agent per role, plus a second for the roles that have one on testnet.
const DEMO_SECONDS: Role[] = ['researcher', 'writer', 'illustrator', 'auditor'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (orderId: string, data: Record<string, unknown>) => publish({ type: 'lot', orderId, data });

/** The lots for a job, by the service's team and what each role has spent on its past jobs. */
const planLots = (service: string, priceUsd: number, minMarginBps: number) =>
  splitLots(findService(service)?.team ?? [], spendFor(service), priceUsd, minMarginBps);

type Member = { account: string; role: Role; rep: number };
/** The hired, active agents (from the bank), each with its role and reputation. Only ones whose key we hold bid. */
async function members(): Promise<Member[]> {
  if (DRY) return (Object.keys(GROUPS.flatMap((g) => g.roles).reduce((m, r) => ({ ...m, [r]: 1 }), {})) as Role[])
    .flatMap((r) => [r, ...(DEMO_SECONDS.includes(r) ? [`${r}-2`] : [])].map((account) => ({ account, role: r, rep: 500 })));
  const list = await view<[string, { role: Role; active: boolean; rep: number }][]>(NEAR!.bank, 'list_agents');
  return list.filter(([a, x]) => x.active && hasKey(a)).map(([account, x]) => ({ account, role: x.role, rep: x.rep }));
}

type Open = LotRecord & {
  cost: number; salts: Map<string, { price: number; salt: string }>; commitEnd: number; revealEnd: number;
  outside: { handle: string; price: number; quality: number }[];
};

/**
 * Run the auction for a funded job. Returns the lots; fills in who does which part of the job. `brief` is
 * what an outside agent would be told; a private order passes none, so its lots stay inside the team.
 */
export async function auction(orderId: string, service: string, priceUsd: number, brief?: string): Promise<LotRecord[]> {
  const policy = DRY ? { min_margin_bps: 2000, commit_secs: 3, reveal_secs: 3 } : await view<{ min_margin_bps: number; commit_secs: number; reveal_secs: number }>(NEAR!.bank, 'get_policy');
  const plan = planLots(service, priceUsd, policy.min_margin_bps);
  if (!plan.length) return [];
  say(orderId, { phase: 'plan', lots: plan.map((p) => ({ title: p.title, roles: p.roles, reserve: p.reserve })), price: priceUsd });

  // 1. The CFO opens the lots.
  const lots: Open[] = [];
  for (const p of plan) {
    let id = lots.length, commitEnd = Date.now() / 1000 + policy.commit_secs, revealEnd = commitEnd + policy.reveal_secs, tx: string | undefined;
    if (!DRY) {
      const r = await call(NEAR!.cfo, NEAR!.bank, 'open_lot', { job: orderId, title: p.title, roles: p.roles, reserve: toUnits(p.reserve) });
      const ev = events(r.logs, 'lot')[0]?.data;
      id = Number(r.value);
      commitEnd = Number(BigInt(ev.commit_end) / 1_000_000_000n);
      revealEnd = Number(BigInt(ev.reveal_end) / 1_000_000_000n);
      tx = r.hash;
    }
    lots.push({ id, title: p.title, roles: p.roles, reserve: p.reserve, cost: p.cost, bids: [], status: 'bidding', tx, salts: new Map(), commitEnd, revealEnd, outside: [] });
    say(orderId, { phase: 'open', lot: id, title: p.title, roles: p.roles, reserve: p.reserve, tx });
  }

  // 2. Outside quotes from the Agent Market for the research, while the team seals its bids.
  const team = await members();
  const research = lots.find((l) => l.title === 'Research');
  await Promise.all([
    research && brief ? outsideQuotes(orderId, research, findService(service)?.name ?? service) : undefined, // searched by service, not the brief
    ...lots.map((l) => commits(orderId, l, team)),
  ]);

  // 3–4. Reveals and the award.
  const map: Partial<Record<Role, Winner>> = {};
  await revealAndAward(orderId, lots, team, map);

  // 5. An outside winner is hired. If it can't deliver, the lot fails and the team bids for it again.
  for (const l of lots.filter((x) => x.status === 'awarded' && x.winner?.startsWith('outside:'))) {
    const q = l.outside.find((o) => `outside:${o.handle}` === l.winner)!;
    say(orderId, { phase: 'hire', lot: l.id, title: l.title, winner: q.handle, pay: l.pay });
    try {
      const h = DRY
        ? { handle: q.handle, taskId: 'demo', state: 'demo', text: `(demo) ${q.handle} would research: ${brief}`, paid: null, at: new Date().toISOString() }
        : await hire(q.handle, researchTask(service, brief!), q.price, orderId);
      setNotes(orderId, { handle: q.handle, roles: l.roles, text: h.text });
      l.hire = { handle: h.handle, taskId: h.taskId, usd: h.paid?.usd ?? 0, receipt: DRY ? '' : receiptOf(h), textHash: sha256(h.text) };
      say(orderId, { phase: 'hired', lot: l.id, winner: q.handle, usd: l.hire.usd, task: h.taskId, chars: h.text.length });
    } catch (e: any) {
      const why = String(e?.message ?? e).slice(0, 160);
      say(orderId, { phase: 'hire-failed', lot: l.id, winner: q.handle, why });
      if (!DRY) {
        await call(NEAR!.cfo, NEAR!.bank, 'deliver_outside', { lot: l.id, deliverable: '', receipt: `not hired: ${why}` });
        await call(NEAR!.cfo, NEAR!.bank, 'inspect', { lot: l.id, pass: false, note: `${q.handle} could not be hired` });
        const lot = await view<{ commit_end: string; reveal_end: string }>(NEAR!.bank, 'get_lot', { id: l.id });
        l.commitEnd = Number(BigInt(lot.commit_end) / 1_000_000_000n);
        l.revealEnd = Number(BigInt(lot.reveal_end) / 1_000_000_000n);
      } else { l.commitEnd = Date.now() / 1000 + policy.commit_secs; l.revealEnd = l.commitEnd + policy.reveal_secs; }
      Object.assign(l, { bids: [], salts: new Map(), outside: [], winner: undefined, winnerRole: undefined, bid: undefined, pay: undefined, status: 'bidding' as const, round: (l.round ?? 1) + 1 });
      say(orderId, { phase: 'open', lot: l.id, title: l.title, roles: l.roles, reserve: l.reserve, round: l.round });
      await commits(orderId, l, team);
      await revealAndAward(orderId, [l], team, map);
    }
  }
  assigned.set(orderId, map);
  return lots.map(({ cost, salts, commitEnd, revealEnd, outside, ...rest }) => rest);
}

/** What an outside research agent is asked to do for an order. */
const researchTask = (service: string, brief: string) =>
  `Research for a small-business order (${findService(service)?.name ?? service}). The customer's brief:\n\n${brief.slice(0, 3000)}\n\n` +
  'Reply with a research brief of 300 to 600 words: the market, competitors with what they charge, who the customers are, and what to say to them. Cite every fact with a source URL.';

/** Market quotes for a lot. A quote is entered on the bank only if it is under the reserve and a win could be paid for. */
async function outsideQuotes(orderId: string, l: Open, topic: string) {
  const quotes = await researchQuotes(topic, 3).catch(() => []);
  // a demo can show an outside win, since nothing is paid in a demo
  const enter = DRY || canHire();
  l.quotes = [];
  for (const q of quotes) {
    const row = { handle: q.handle, price: q.priceUsd, quality: q.qualityBps, entered: false, why: '' };
    if (q.priceUsd > l.reserve) row.why = `asks ${q.priceUsd} USDC, above the ${l.reserve} reserve`;
    else if (!goodRecord(q.delivered, q.successPct)) row.why = `its record is ${q.successPct}% over ${q.delivered} tasks`;
    else if (!enter) row.why = 'hiring on the Agent Market is off';
    else {
      try {
        if (!DRY) await call(NEAR!.cfo, NEAR!.bank, 'add_outside', { lot: l.id, handle: q.handle, price: toUnits(q.priceUsd), quality_bps: q.qualityBps, quote_ref: q.ref });
        l.outside.push({ handle: q.handle, price: q.priceUsd, quality: q.qualityBps });
        row.entered = true;
      } catch (e: any) { row.why = String(e?.message ?? e).slice(0, 80); }
    }
    l.quotes.push(row);
    say(orderId, { phase: 'quote', lot: l.id, agent: q.handle, price: q.priceUsd, quality: q.qualityBps, delivered: q.delivered, success: q.successPct, entered: row.entered, why: row.why || undefined });
  }
}

/** Sealed bids: each agent whose role fits commits a hash of its price, from its own account. */
async function commits(orderId: string, l: Open, team: Member[]) {
  await Promise.all(team.filter((m) => l.roles.includes(m.role)).map(async ({ account: who, role, rep }) => {
    const price = bidFor(who, l.cost, rep, l.reserve);
    const agent = agentName(who);
    if (price === undefined) { say(orderId, { phase: 'pass', lot: l.id, agent, role, why: 'its cost is above the reserve' }); return; }
    // a winner pays its own model bill, so an agent that can't cover it doesn't bid
    if (!DRY && (await balanceOf(who).catch(() => 0)) < l.cost) { say(orderId, { phase: 'pass', lot: l.id, agent, role, why: "can't cover the model bill yet" }); return; }
    const salt = randomBytes(8).toString('hex');
    try {
      if (!DRY) await call(who, NEAR!.bank, 'commit', { lot: l.id, hash: sha256(`${l.id}:${who}:${toUnits(price)}:${salt}`) }, { tgas: 12 });
      l.salts.set(who, { price, salt });
      say(orderId, { phase: 'commit', lot: l.id, agent, role });
    } catch (e: any) {
      say(orderId, { phase: 'pass', lot: l.id, agent, role, why: String(e?.message ?? e).slice(0, 80) });
    }
  }));
}

/** Reveals once the commit window has closed on chain, then the bank's award once reveals close. */
async function revealAndAward(orderId: string, lots: Open[], team: Member[], map: Partial<Record<Role, Winner>>) {
  const byAccount = new Map(team.map((m) => [m.account, m]));
  await untilChain(Math.max(...lots.map((l) => l.commitEnd)) + 1);
  await Promise.all(lots.flatMap((l) => [...l.salts].map(async ([who, b]) => {
    const role = byAccount.get(who)!.role, agent = agentName(who);
    try {
      if (!DRY) await call(who, NEAR!.bank, 'reveal', { lot: l.id, price: toUnits(b.price), salt: b.salt }, { tgas: 12 });
      l.bids.push({ agent: who, role, price: b.price });
      say(orderId, { phase: 'reveal', lot: l.id, agent, role, price: b.price });
    } catch (e: any) {
      say(orderId, { phase: 'pass', lot: l.id, agent, role, why: `reveal failed: ${String(e?.message ?? e).slice(0, 60)}` });
    }
  })));

  await untilChain(Math.max(...lots.map((l) => l.revealEnd)) + 1);
  for (const l of lots) {
    let winner: string | undefined, bid = 0, pay = 0;
    if (DRY) [winner, bid, pay] = demoAward(l, byAccount);
    else {
      const r = await call(NEAR!.cfo, NEAR!.bank, 'award', { lot: l.id });
      const ev = events(r.logs, 'award')[0]?.data;
      l.tx = r.hash;
      if (ev) {
        const w = ev.winner;
        winner = w.Team ?? `outside:${w.Outside}`;
        bid = fromUnits(ev.bid); pay = fromUnits(ev.pay);
      }
    }
    if (!winner) { l.status = 'void'; say(orderId, { phase: 'void', lot: l.id, title: l.title }); continue; }
    const won = byAccount.get(winner);
    Object.assign(l, { winner, winnerRole: won?.role, bid, pay, status: 'awarded' as const });
    if (won) for (const r of l.roles) map[r] = { role: won.role, account: won.account };
    say(orderId, { phase: 'award', lot: l.id, title: l.title, winner: won ? agentName(winner) : winner.replace('outside:', ''), role: won?.role ?? 'outside', bid, pay, bidders: l.bids.length + l.outside.length, tx: l.tx });
  }
}

/** The bank's award, in memory (auction.ts). */
function demoAward(l: Open, byAccount: Map<string, Member>): [string | undefined, number, number] {
  const won = awardRule([
    ...l.bids.map((b) => ({ who: b.agent, price: b.price, q: quality(byAccount.get(b.agent)?.rep ?? 500), team: true })),
    ...l.outside.map((o) => ({ who: `outside:${o.handle}`, price: o.price, q: o.quality, team: false })),
  ], l.reserve);
  return won ? [won.winner.who, won.winner.price, won.pay] : [undefined, 0, 0];
}

async function untilChain(t: number) {
  for (;;) {
    const now = DRY ? Date.now() / 1000 : await chainNow().catch(() => Date.now() / 1000);
    if (now >= t) return;
    await sleep(Math.min(5000, Math.max(500, (t - now) * 1000)));
  }
}

/**
 * After delivery: each winner files the hash of its part (its steps and calls in the job), and the CFO
 * inspects it. The bank won't take the job's delivery while a lot is still open, so this runs first.
 */
export async function closeLots(orderId: string, lots: LotRecord[], job: Job | any, pass: boolean): Promise<LotRecord[]> {
  for (const l of lots.filter((x) => x.status === 'awarded')) {
    const mine = (x: { agent: string }) => l.roles.includes(x.agent as Role) || x.agent === l.winnerRole;
    const part = l.hire?.textHash ?? sha256(JSON.stringify({ steps: (job?.steps ?? []).filter(mine), receipt: (job?.receipt ?? []).filter(mine) }));
    const note = pass ? `${l.title}: delivered in a job the customer received` : `${l.title}: the job failed`;
    try {
      if (!DRY) {
        if (String(l.winner).startsWith('outside:')) await call(NEAR!.cfo, NEAR!.bank, 'deliver_outside', { lot: l.id, deliverable: part, receipt: l.hire?.receipt ?? '' });
        else {
          // the TEE signatures of the part's model calls, which the bank checks against its approved signers
          const tee = ((job?.receipt ?? []) as ReceiptLine[]).filter((r) => mine(r) && r.tee).slice(-12).map((r) => ({ text: r.tee!.text, signature: r.tee!.signature }));
          await call(l.winner!, NEAR!.bank, 'deliver', { lot: l.id, deliverable: part, tee }, { tgas: 20 + 4 * tee.length });
        }
        l.tx = (await call(NEAR!.cfo, NEAR!.bank, 'inspect', { lot: l.id, pass, note })).hash;
      }
      l.status = pass ? 'passed' : 'failed';
      say(orderId, { phase: pass ? 'pass-inspection' : 'fail-inspection', lot: l.id, title: l.title, winner: agentName(l.winner!.replace('outside:', '')), pay: l.pay, tx: l.tx });
    } catch (e: any) {
      say(orderId, { phase: 'error', lot: l.id, why: String(e?.message ?? e).slice(0, 120) });
    }
  }
  assigned.delete(orderId);
  dropNotes(orderId);
  return lots;
}
