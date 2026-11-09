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
import { NEAR, act, balanceOf, call, canSign, chainNow, events, fromUnits, has, isCrew, sha256, tg, toUnits, view } from './near/chain.ts';
import { crewSpec } from './crew.ts';
import { type Role } from './wallets.ts';
import { spendFor } from './cfo/treasury.ts';
import { findService } from './services/index.ts';
import type { Job } from './job.ts';
import type { ReceiptLine } from './meter.ts';
import { canHire, hire, receiptOf, researchQuotes } from './market.ts';
import { award as awardRule, bidFor, goodRecord, planLots as splitLots, quality, r6, GROUPS } from './auction.ts';
import { dropNotes, setNotes } from './notes.ts';
import { remember, think } from './pricer.ts';

/** Who won a lot: its role and the NEAR account that does (and pays for) the work. */
export type Winner = { role: Role; account: string };

export type LotRecord = {
  id: number; title: string; roles: Role[]; reserve: number;
  bids: { agent: string; role: Role; price: number; why?: string; by?: string }[]; winner?: string; winnerRole?: Role; bid?: number; pay?: number;
  status: 'bidding' | 'awarded' | 'passed' | 'void' | 'failed'; tx?: string; round?: number; error?: string;
  quotes?: { handle: string; price: number; quality: number; entered: boolean; why: string }[]; // from the Agent Market
  hire?: { handle: string; taskId: string; usd: number; receipt: string; textHash: string }; // an outside winner, hired
  slashed?: number; // the winner's bond, paid to the customer when its work failed (rule 36)
};

// Which roles' work a winner takes over in a job, by order id (job.ts reads it when a service creates the job).
const assigned = new Map<string, Partial<Record<Role, Winner>>>();
// Each agent's call to price its bid, by order id, until the job's receipt takes them (orders.ts).
const pricing = new Map<string, ReceiptLine[]>();
export function takePricing(orderId: string): ReceiptLine[] { const l = pricing.get(orderId) ?? []; pricing.delete(orderId); return l; }
export const assignmentFor = (orderId?: string) => (orderId ? assigned.get(orderId) : undefined) ?? {};

/** An agent's short name: writer-2 for writer-2.team.parallax.testnet. */
export const agentName = (account: string) => account.split('.')[0];

/** Rule 39 (RULES.md): what a signed delivery files, the same sha256 the bank's `bound_part` computes. */
export const boundPart = (lot: number, round: number, answers: string[], body: string) => sha256(`parallax-part:${lot}:${round}:${answers.join(',')}:${body}`);
// Demo mode's team: one agent per role, plus a second for the roles that have one on testnet.
const DEMO_SECONDS: Role[] = ['researcher', 'writer', 'illustrator', 'auditor'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What revealing a bid locks from the bidder's balance until its work passes (the bank's BOND_BPS). */
export const BOND_SHARE = 0.2;
const bondFor = (price: number) => r6(price * BOND_SHARE);
const say = (orderId: string, data: Record<string, unknown>) => publish({ type: 'lot', orderId, data });

/** The lots for a job, by the service's team and what each role has spent on its past jobs. */
const planLots = (service: string, priceUsd: number, minMarginBps: number) =>
  splitLots(findService(service)?.team ?? [], spendFor(service), priceUsd, minMarginBps)
    .map((p) => (service === 'factcheck' ? { ...p, title: 'Fact check' } : p)); // a sub-job's one lot, not Research

type Member = { account: string; role: Role; rep: number };
/** The hired, active agents (from the bank), each with its role and reputation: the team, and the enlisted crew the
 * operator signs for. Only ones we can sign for bid. */
async function members(): Promise<Member[]> {
  if (DRY) return (Object.keys(GROUPS.flatMap((g) => g.roles).reduce((m, r) => ({ ...m, [r]: 1 }), {})) as Role[])
    .flatMap((r) => [r, ...(DEMO_SECONDS.includes(r) ? [`${r}-2`] : [])].map((account) => ({ account, role: r, rep: 500 })));
  const list = await view<[string, { role: Role; active: boolean; rep: number }][]>(NEAR!.bank, 'list_agents');
  return list.filter(([a, x]) => x.active && canSign(a)).map(([account, x]) => ({ account, role: x.role, rep: x.rep }));
}

type Open = LotRecord & {
  cost: number; salts: Map<string, { price: number; salt: string; why?: string; by?: string; markup?: number }>; commitEnd: number; revealEnd: number;
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
  // 3–4. Each lot runs on its own clock: its reveals start when its commit window closes, whatever the other
  // lots are doing, so one slow transaction can't push a whole job's reveals past their window.
  const map: Partial<Record<Role, Winner>> = {};
  await Promise.all(lots.map(async (l) => {
    const quotes = l === research && brief ? outsideQuotes(orderId, l, findService(service)?.name ?? service) : undefined; // searched by service, not the brief
    await revealAndAward(orderId, l, commits(orderId, l, team), team, map);
    await quotes;
  }));

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
      await revealAndAward(orderId, l, commits(orderId, l, team), team, map);
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
  const enter = DRY || (canHire() && has('market'));
  l.quotes = [];
  for (const q of quotes) {
    const row = { handle: q.handle, price: q.priceUsd, quality: q.qualityBps, entered: false, why: '' };
    if (q.priceUsd > l.reserve) row.why = `asks ${q.priceUsd} USDC, above the ${l.reserve} reserve`;
    else if (!goodRecord(q.delivered, q.successPct)) row.why = `its record is ${q.successPct}% over ${q.delivered} tasks`;
    else if (!enter) row.why = has('market') ? 'hiring on the Agent Market is off' : 'this bank takes no Agent Market bids';
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
    // an enlisted agent prices with the markup its sponsor chose
    const spec = isCrew(who) ? crewSpec(who) : undefined;
    if (isCrew(who) && !spec) return; // its spec isn't on this server, so it can't do the work
    const own = spec && r6(Math.max(0.001, l.cost * (1 + spec.markup / 100)));
    const agent = agentName(who);
    // a team agent asks its own model what to ask (pricer.ts); an enlisted one uses its sponsor's markup
    const t = own ? undefined : await think({ account: who, name: agent, role, lot: l.id, title: l.title, cost: l.cost, reserve: l.reserve, rep, round: l.round, rivals: team.filter((m) => l.roles.includes(m.role)).length - 1 });
    if (t?.line) pricing.set(orderId, [...(pricing.get(orderId) ?? []), t.line]);
    const price = own ? (own <= l.reserve ? own : undefined) : t!.price;
    if (price === undefined) { say(orderId, { phase: 'pass', lot: l.id, agent, role, why: t?.by === 'model' ? `its price (${t.markup}% over cost) is above the reserve` : 'its cost is above the reserve' }); return; }
    // a winner pays its own model bill, and revealing locks a bond (rule 36), so an agent that can't cover both doesn't bid
    if (!DRY && (await balanceOf(who).catch(() => 0)) < l.cost + bondFor(price)) { say(orderId, { phase: 'pass', lot: l.id, agent, role, why: "can't cover the model bill and its bond yet" }); return; }
    const salt = randomBytes(8).toString('hex');
    try {
      if (!DRY) await act(who, 'commit', { lot: l.id, hash: sha256(`${l.id}:${who}:${toUnits(price)}:${salt}`) }, { tgas: 12 });
      l.salts.set(who, { price, salt, ...(t ? { why: t.why, by: t.by, markup: t.markup } : { why: `its sponsor's markup, ${spec!.markup}%`, by: 'sponsor' }) });
      say(orderId, { phase: 'commit', lot: l.id, agent, role });
    } catch (e: any) {
      say(orderId, { phase: 'pass', lot: l.id, agent, role, why: String(e?.message ?? e).slice(0, 80) });
    }
  }));
}

/**
 * A lot's reveals once its commit window has closed on chain, then the bank's award once its reveals close.
 * A commit still waiting on a slow node gets until shortly before the reveals close to land; one that
 * landed on time is revealed, and one that didn't has already been refused by the bank.
 */
async function revealAndAward(orderId: string, l: Open, committing: Promise<void>, team: Member[], map: Partial<Record<Role, Winner>>) {
  const byAccount = new Map(team.map((m) => [m.account, m]));
  await untilChain(l.commitEnd + 1);
  await Promise.race([committing, sleep(Math.max(0, (l.revealEnd - l.commitEnd - 15) * 1000))]);
  await Promise.all([...l.salts].map(async ([who, b]) => {
    const role = byAccount.get(who)!.role, agent = agentName(who);
    try {
      if (!DRY) await act(who, 'reveal', { lot: l.id, price: toUnits(b.price), salt: b.salt }, { tgas: 12 });
      l.bids.push({ agent: who, role, price: b.price, why: b.why, by: b.by });
      say(orderId, { phase: 'reveal', lot: l.id, agent, role, price: b.price, bond: bondFor(b.price), why: b.why, by: b.by, markup: b.markup });
    } catch (e: any) {
      say(orderId, { phase: 'pass', lot: l.id, agent, role, why: `reveal failed: ${String(e?.message ?? e).slice(0, 60)}` });
    }
  }));

  await untilChain(l.revealEnd + 1);
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
  // each revealed team bid is remembered with how it went, for that agent's next price
  for (const b of l.bids) if (byAccount.has(b.agent) && !isCrew(b.agent)) {
    try { remember(b.agent, { at: new Date().toISOString(), lot: l.title, cost: l.cost, reserve: l.reserve, price: b.price, won: b.agent === winner, pay: b.agent === winner ? pay : undefined, bidders: l.bids.length + l.outside.length }); } catch { /* memory is best effort */ }
  }
  if (!winner) { l.status = 'void'; say(orderId, { phase: 'void', lot: l.id, title: l.title }); return; }
  const won = byAccount.get(winner);
  Object.assign(l, { winner, winnerRole: won?.role, bid, pay, status: 'awarded' as const });
  if (won) for (const r of l.roles) map[r] = { role: won.role, account: won.account };
  say(orderId, { phase: 'award', lot: l.id, title: l.title, winner: won ? agentName(winner) : winner.replace('outside:', ''), role: won?.role ?? 'outside', bid, pay, bidders: l.bids.length + l.outside.length, tx: l.tx });
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
/**
 * `spare` names the parts that pass even though the job failed, with why: the check that caught the problem, or
 * a part that never got to run because an earlier one broke. Only the parts left fail inspection and lose their bonds.
 */
export async function closeLots(orderId: string, lots: LotRecord[], job: Job | any, jobPassed: boolean, spare: (l: LotRecord) => string | undefined = () => undefined): Promise<LotRecord[]> {
  for (const l of lots.filter((x) => x.status === 'awarded')) {
    const mine = (x: { agent: string; bid?: boolean }) => !x.bid && (l.roles.includes(x.agent as Role) || x.agent === l.winnerRole);
    const part = l.hire?.textHash ?? sha256(JSON.stringify({ steps: (job?.steps ?? []).filter(mine), receipt: (job?.receipt ?? []).filter(mine) }));
    const why = jobPassed ? undefined : spare(l);
    const pass = jobPassed || !!why;
    const note = jobPassed ? `${l.title}: delivered in a job the customer received` : why ? `${l.title}: ${why}` : `${l.title}: the job failed`;
    try {
      if (!DRY) {
        if (String(l.winner).startsWith('outside:')) await call(NEAR!.cfo, NEAR!.bank, 'deliver_outside', { lot: l.id, deliverable: part, receipt: l.hire?.receipt ?? '' });
        else {
          // the TEE signatures of the part's model calls, which the bank checks against its approved signers
          const tee = ((job?.receipt ?? []) as ReceiptLine[]).filter((r) => mine(r) && r.tee).slice(-12).map((r) => ({ text: r.tee!.text, signature: r.tee!.signature }));
          // rule 39: the filed hash binds the part to this lot, its round on chain and the exact answers signed
          const round = tee.length ? (await view<{ round: number }>(NEAR!.bank, 'get_lot', { id: l.id })).round : 0;
          const deliverable = tee.length ? boundPart(l.id, round, tee.map((t) => t.text.split(':').pop()!), part) : part;
          // A deliver burns ~3 Tgas with one signature (~0.5 more per extra one), but the signer must hold the whole
          // prepaid gas up front: on mainnet an agent keeps ~0.03 NEAR, so 24 + 5 per signature (34 Tgas with two)
          // was refused before it ran (job d86c1fd3a1). Mainnet prepays 8 + 1.5 per signature, at most 26.
          await act(l.winner!, 'deliver', { lot: l.id, deliverable, tee, ...(tee.length ? { body: part } : {}) }, { tgas: tg(Math.ceil(8 + 1.5 * tee.length), 24 + 5 * tee.length) });
        }
        const r = await call(NEAR!.cfo, NEAR!.bank, 'inspect', { lot: l.id, pass, note });
        l.tx = r.hash;
        const slash = events(r.logs, 'slash')[0]?.data;
        if (slash) l.slashed = fromUnits(slash.amount);
      }
      l.status = pass ? 'passed' : 'failed';
      say(orderId, { phase: pass ? 'pass-inspection' : 'fail-inspection', lot: l.id, title: l.title, winner: agentName(l.winner!.replace('outside:', '')), pay: l.pay, slashed: l.slashed, tx: l.tx });
    } catch (e: any) {
      // the lot stays awarded on chain; keep why, so the order can say it and finishOpenLots can retry
      l.error = String(e?.message ?? e).slice(0, 200);
      say(orderId, { phase: 'error', lot: l.id, why: l.error.slice(0, 120) });
    }
  }
  assigned.delete(orderId);
  dropNotes(orderId);
  return lots;
}
