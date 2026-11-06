// The CFO's treasury round, run every few minutes on NEAR. It keeps each agent's balance at the bank
// stocked with enough USDC for its model bills, and the house wallet's with enough to pay for one demo
// job, all inside the bank's rules: a week's allowances can't add up to more than the epoch tool budget,
// a single move can't be more than max_move, and a top-up only moves TOOLS into a hired account's balance.
// The money itself never leaves the bank except as a model bill to the compute account (pay_bill).
//
// The money goes round: the house wallet pays a demo job into escrow, acceptance pays the winners and
// leaves the margin in OPERATING, and the CFO moves what the week needs from OPERATING into TOOLS.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, DRY } from '../config.ts';
import { publish } from '../bus.ts';
import { NEAR, balanceOf, call, fromUnits, sha256, toUnits, view } from '../near/chain.ts';
import { ROSTER, accountOf } from '../wallets.ts';
import { SERVICES } from '../services/index.ts';
import { refundLate } from '../orders.ts';

const WEEK_MS = 7 * 86400_000;
const EVERY_MS = Number(process.env.PARALLAX_CFO_EVERY_S ?? 300) * 1000;
/** What each agent keeps on hand for model bills, and the point at which the CFO tops it back up. */
const AGENT_FLOAT = Number(process.env.PARALLAX_AGENT_FLOAT ?? 0.1);
/** The house wallet's share of the week's tool budget: enough for the dearest job on mainnet's lean budget. */
const HOUSE_SHARE = Number(process.env.PARALLAX_HOUSE_SHARE ?? 0.75);

type Overview = { buckets: string[]; epoch: string; epoch_allocated: string; killed: boolean; next_epoch_at?: string };
type Policy = { epoch_tool_budget: string; max_move: string; reserve_floor: string };
type AgentRec = { role: string; active: boolean; allowance_epoch: string; allowance: string; topped_up: string };
type State = { epoch: number; openedAt: number };

const file = () => join(DATA_DIR, 'cfo.json');
const load = (): State => (existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : { epoch: 0, openedAt: 0 });
const keep = (s: State) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(file(), JSON.stringify(s)); };
const say = (text: string, data: Record<string, unknown> = {}) => publish({ type: 'cfo', data: { text, ...data } });

/** The house wallet: pays for demo jobs, hired by the bank so the CFO can top it up. */
export const houseAccount = () => NEAR?.house;

/** One round. Returns what it did, for the log and the tests. */
export async function treasuryRound(): Promise<string[]> {
  if (DRY || !NEAR) return [];
  const did: string[] = [];
  const [ov, policy, list] = await Promise.all([
    view<Overview>(NEAR.bank, 'overview'), view<Policy>(NEAR.bank, 'get_policy'), view<[string, AgentRec][]>(NEAR.bank, 'list_agents'),
  ]);
  if (ov.killed) return ['the bank is stopped'];
  did.push(...(await refundLate().catch((e) => [`late refunds failed: ${String(e?.message ?? e).slice(0, 80)}`])));
  const agents = new Map(list);
  const house = houseAccount();
  const team = ROSTER.filter((a) => a.role !== 'messenger').map((a) => accountOf(a.id)).filter((a) => agents.get(a)?.active);
  const budget = fromUnits(policy.epoch_tool_budget), maxMove = fromUnits(policy.max_move);

  // A new week. A bank with the week lock says when the next one may open, so every server agrees;
  // an older bank (the testnet one) leaves it to this server's own record.
  const s = load();
  let epoch = Number(ov.epoch);
  const plan = { house: house ? budget * HOUSE_SHARE : 0, each: (budget * (house ? 1 - HOUSE_SHARE : 1)) / Math.max(1, team.length) };
  const due = ov.next_epoch_at !== undefined
    ? Date.now() * 1e6 >= Number(ov.next_epoch_at)
    : epoch === 0 || s.epoch !== epoch || Date.now() - s.openedAt > WEEK_MS;
  if (due) {
    await call(NEAR.cfo, NEAR.bank, 'open_epoch', { plan_hash: sha256(JSON.stringify(plan)) });
    epoch += 1;
    keep({ epoch, openedAt: Date.now() });
    did.push(`opened week ${epoch}: ${plan.each.toFixed(4)} USDC for each agent${house ? `, ${plan.house.toFixed(2)} for the house wallet` : ''}`);
  }
  // This week's allowances, for anyone without one yet (a new week, a new hire, or a round cut short).
  const share = (a: string) => (a === house ? plan.house : plan.each);
  for (const a of [...team, ...(house && agents.get(house)?.active ? [house] : [])]) {
    if (Number(agents.get(a)?.allowance_epoch ?? 0) === epoch) continue;
    await call(NEAR.cfo, NEAR.bank, 'set_allowance', { agent: a, amount: toUnits(Math.floor(share(a) * 1e6) / 1e6) });
  }

  // Who needs topping up, and by how much (never past what's left of their allowance).
  const fresh = new Map(await view<[string, AgentRec][]>(NEAR.bank, 'list_agents'));
  const left = (a: string) => { const r = fresh.get(a); return r && Number(r.allowance_epoch) === epoch ? fromUnits(r.allowance) - fromUnits(r.topped_up) : 0; };
  const needs: { account: string; usd: number; why: string }[] = [];
  for (const a of team) {
    const have = await balanceOf(a);
    if (have < AGENT_FLOAT / 2) needs.push({ account: a, usd: Math.min(AGENT_FLOAT - have, left(a)), why: 'model bills' });
  }
  if (house && fresh.get(house)?.active) {
    const want = Math.max(...SERVICES.map((x) => x.priceUsd));
    const have = await balanceOf(house);
    if (have < want) needs.push({ account: house, usd: Math.min(want - have, left(house)), why: 'demo jobs' });
  }
  const total = needs.reduce((t, n) => t + Math.max(0, n.usd), 0);
  if (total <= 0) return did;

  // TOOLS pays the top-ups; refill it from OPERATING in moves no bigger than max_move.
  const fresh2 = await view<Overview>(NEAR.bank, 'overview');
  let tools = fromUnits(fresh2.buckets[1]), operating = fromUnits(fresh2.buckets[0]);
  while (tools < total && operating > 0) {
    const amt = Math.min(maxMove, total - tools, operating);
    await call(NEAR.cfo, NEAR.bank, 'move_funds', { from: 'Operating', to: 'Tools', amount: toUnits(Math.floor(amt * 1e6) / 1e6), reason: 'top-ups this week' });
    tools += amt; operating -= amt;
    did.push(`moved ${amt.toFixed(4)} USDC from OPERATING to TOOLS`);
  }
  for (const n of needs) {
    const usd = Math.floor(Math.min(n.usd, tools) * 1e6) / 1e6;
    if (usd <= 0) continue;
    try {
      await call(NEAR.cfo, NEAR.bank, 'top_up', { agent: n.account, amount: toUnits(usd), reason: n.why }, { tgas: 15 });
      tools -= usd;
      did.push(`topped up ${n.account} with ${usd} USDC for ${n.why}`);
    } catch (e: any) {
      did.push(`could not top up ${n.account}: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  return did;
}

let running = false;
/** Run a round now and then every few minutes; each thing it does goes on the event stream. */
export function startTreasury() {
  if (DRY || !NEAR) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { for (const d of await treasuryRound()) { console.log('cfo:', d); say(d); } }
    catch (e: any) { console.log('cfo round failed:', String(e?.message ?? e).slice(0, 160)); }
    finally { running = false; }
  };
  void tick();
  setInterval(tick, EVERY_MS).unref();
}
