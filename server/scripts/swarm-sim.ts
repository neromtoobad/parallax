// Swarm simulation: runs hundreds of jobs through the same auction the bank runs, with scripted agents and no
// chain or model calls. Each agent has its own real cost, reliability and habits; Agent Market agents quote on
// research and build (or lose) a delivery record as they go. It checks the rules hold on every lot and that no
// agent ever does better by bidding anything other than its true price.
//
//   npm run swarm:sim                       200 jobs, seed 7
//   npm run swarm:sim -- --jobs 1000 --seed 3
//   npm run swarm:sim -- --no-record-check  without the outside record check
//
// Writes the full run to data/swarm-sim.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { award, bidFor, goodRecord, planLots, quality, qualityBps, r6, type Sealed } from '../src/auction.ts';
import { SPEND } from '../src/cfo/spend.ts';
import type { Role } from '../src/wallets.ts';

const arg = (name: string, d: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const JOBS = arg('jobs', 200), SEED = arg('seed', 7);
const NO_RECORD_CHECK = process.argv.includes('--no-record-check'); // enter every outside quote, to see why the check is there

// The bank's policy and limits (contracts/near/src/lib.rs), as deployed on testnet.
const POLICY = { minMarginBps: 2000, contributorsBps: 1000, dailyLotCap: 50 };
const REP = { start: 500, max: 1000, pass: 10, fail: 50, noReveal: 20, minBid: 200 };
const ROUNDS = 3; // a lot that fails inspection this many times is left void
const JOBS_PER_DAY = 20, PRIVATE_SHARE = 0.15;

// The live services, as in services/index.ts: price and team. Their lots and reserves come from SPEND.
const SERVICES: { id: string; price: number; team: Role[]; weight: number }[] = [
  { id: 'find-customers', price: 2, weight: 4, team: ['researcher', 'analyst', 'scout', 'reader', 'investigator', 'writer', 'auditor'] },
  { id: 'website', price: 3, weight: 3, team: ['researcher', 'scout', 'reader', 'analyst', 'illustrator', 'auditor'] },
  { id: 'content-pack', price: 4, weight: 2, team: ['researcher', 'reader', 'scout', 'analyst', 'writer', 'illustrator', 'auditor'] },
  { id: 'flyers', price: 1, weight: 3, team: ['writer', 'illustrator', 'auditor'] },
  { id: 'product-photos', price: 3, weight: 2, team: ['analyst', 'illustrator', 'auditor'] },
  { id: 'motion-ad', price: 3, weight: 1, team: ['researcher', 'reader', 'producer', 'auditor'] },
  { id: 'research-brief', price: 2, weight: 2, team: ['researcher', 'scout', 'reader', 'auditor', 'writer'] },
];

// A seeded generator, so a run can be repeated exactly.
let s = SEED >>> 0;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (a: number, b: number) => a + (b - a) * rand();

// The team. Each agent's cost is what its model bill really comes to against the CFO's estimate; `pass` is how
// often its work passes inspection; `reveal` how often it shows up to reveal a bid it sealed.
type Agent = { account: string; role: Role; rep: number; cost: number; pass: number; reveal: number; won: number; failed: number; earned: number; spent: number; noReveals: number; probationAt?: number };
const team: Agent[] = [];
const hire = (name: string, role: Role, o: Partial<Pick<Agent, 'cost' | 'pass' | 'reveal'>> = {}) =>
  team.push({ account: `${name}.team.parallax.testnet`, role, rep: REP.start, cost: o.cost ?? r6(between(0.8, 1.2)), pass: o.pass ?? between(0.93, 0.99), reveal: o.reveal ?? 1, won: 0, failed: 0, earned: 0, spent: 0, noReveals: 0 });
for (const role of ['researcher', 'scout', 'reader', 'investigator', 'writer', 'analyst', 'illustrator', 'producer', 'auditor'] as Role[]) hire(role, role);
for (const role of ['researcher', 'writer', 'illustrator', 'auditor'] as Role[]) hire(`${role}-2`, role);
hire('writer-3', 'writer', { cost: 0.7, pass: 0.62 });      // cheap and careless: wins on price, then fails inspection
hire('scout-2', 'scout', { reveal: 0.75 });                  // seals bids and sometimes doesn't reveal them
hire('illustrator-3', 'illustrator', { cost: 1.45, pass: 0.99 }); // careful but expensive

// Agent Market research agents: a posted price, a hidden delivery rate, and a public record that grows.
type Outside = { handle: string; price: number; deliver: number; delivered: number; ok: number; won: number; failed: number; earned: number };
const market: Outside[] = [
  { handle: 'research-brief-agent', price: 0.08, deliver: 0.97, delivered: 0, ok: 0, won: 0, failed: 0, earned: 0 },
  { handle: 'local-shop-product-finder', price: 0.1, deliver: 0.9, delivered: 3, ok: 3, won: 0, failed: 0, earned: 0 },
  { handle: 'cited-web-research-brief', price: 0.15, deliver: 0.99, delivered: 12, ok: 12, won: 0, failed: 0, earned: 0 },
  { handle: 'cheap-scraper-bot', price: 0.03, deliver: 0.55, delivered: 0, ok: 0, won: 0, failed: 0, earned: 0 },
];
const successPct = (o: Outside) => (o.delivered ? (100 * o.ok) / o.delivered : null);

const totals = { jobs: 0, private: 0, accepted: 0, rejected: 0, lots: 0, voidLots: 0, rebids: 0, bids: 0, outsideQuotes: 0, outsideWins: 0, outsideFails: 0, noReveals: 0, probationSkips: 0, capWaits: 0, revenue: 0, refunded: 0, teamPaid: 0, outsidePaid: 0, contributors: 0, kept: 0, reserveTotal: 0, payTotal: 0 };
const broken: string[] = []; // any rule that didn't hold, with where
const truth = { checked: 0, betterOff: 0 };
const log: unknown[] = [];
let day = 0, daySpend = 0;
const byAccount = new Map(team.map((a) => [a.account, a]));
const check = (ok: boolean, what: string) => { if (!ok) broken.push(what); };

/** What an agent gets from a lot at a bid, with every other bid fixed: pay minus its true price if it wins. */
function payoff(bids: Sealed[], who: string, bid: number, value: number, reserve: number) {
  const r = award(bids.map((b) => (b.who === who ? { ...b, price: bid } : b)), reserve);
  return r?.winner.who === who ? r.pay - value : 0;
}

/** One lot, from sealed bids to inspection. Returns what it cost the bank (team pay is owed until acceptance). */
function runLot(job: number, title: string, roles: Role[], cost: number, reserve: number, outsideOk: boolean) {
  const excluded = new Set<string>();
  for (let round = 1; round <= ROUNDS; round++) {
    if (round > 1) totals.rebids++;
    // Sealed bids from every agent whose role fits, off probation and not already failed on this lot.
    const bids: Sealed[] = [];
    for (const a of team.filter((x) => roles.includes(x.role) && !excluded.has(x.account))) {
      if (a.rep < REP.minBid) { totals.probationSkips++; continue; }
      const price = bidFor(a.account, cost * a.cost, a.rep, reserve);
      if (price === undefined) continue;
      if (rand() > a.reveal) { a.rep = Math.max(0, a.rep - REP.noReveal); a.noReveals++; totals.noReveals++; continue; } // sealed, never revealed
      bids.push({ who: a.account, price, q: quality(a.rep), team: true });
    }
    // Outside quotes on research, at or under the reserve, on orders that aren't private.
    if (outsideOk && title === 'Research') for (const o of market.filter((x) => !excluded.has(`outside:${x.handle}`) && x.price <= reserve && (NO_RECORD_CHECK || goodRecord(x.delivered, successPct(x))))) {
      bids.push({ who: `outside:${o.handle}`, price: o.price, q: qualityBps(o.delivered, successPct(o)), team: false });
      totals.outsideQuotes++;
    }
    totals.bids += bids.length;
    const r = award(bids, reserve);
    if (!r) { totals.voidLots++; return { status: 'void' as const, pay: 0, outside: false }; }
    const { winner: w, pay } = r;

    // The rules, on every award.
    check(pay >= w.price - 1e-9, `job ${job} ${title}: paid ${pay} under its bid ${w.price}`);
    check(!w.team || pay <= reserve + 1e-9, `job ${job} ${title}: paid ${pay} over the reserve ${reserve}`);
    check(w.team || pay === w.price, `job ${job} ${title}: outside winner not paid its quote`);
    check(!w.team || byAccount.get(w.who)!.rep >= REP.minBid, `job ${job} ${title}: an agent on probation won`);
    // Truthful bidding: no team bidder does better by shading its price up or down, everyone else fixed.
    for (const b of bids.filter((x) => x.team)) {
      const honest = payoff(bids, b.who, b.price, b.price, reserve);
      for (const k of [0.6, 0.8, 0.9, 1.1, 1.25, 1.5]) {
        truth.checked++;
        if (payoff(bids, b.who, r6(b.price * k), b.price, reserve) > honest + 1e-6) truth.betterOff++;
      }
    }
    // The bank's daily cap on lot pay: the award waits for tomorrow.
    if (daySpend + pay > POLICY.dailyLotCap) { totals.capWaits++; day++; daySpend = 0; }
    daySpend += pay;

    if (!w.team) {
      const o = market.find((x) => `outside:${x.handle}` === w.who)!;
      const delivered = rand() < o.deliver;
      o.delivered++;
      if (!delivered) { o.failed++; totals.outsideFails++; excluded.add(w.who); daySpend -= pay; continue; } // the market only charges on delivery
      o.ok++; o.won++; o.earned += pay; totals.outsideWins++; totals.outsidePaid += pay;
      return { status: 'passed' as const, pay, outside: true, winner: o.handle };
    }
    const a = byAccount.get(w.who)!;
    a.spent += cost * a.cost; // the winner pays its own model bill, pass or fail
    if (rand() < a.pass) { a.rep = Math.min(REP.max, a.rep + REP.pass); a.won++; return { status: 'passed' as const, pay, outside: false, winner: a.account }; }
    a.rep = Math.max(0, a.rep - REP.fail); a.failed++;
    if (a.rep < REP.minBid && a.probationAt === undefined) a.probationAt = job;
    excluded.add(a.account); daySpend -= pay;
  }
  totals.voidLots++;
  return { status: 'void' as const, pay: 0, outside: false };
}

const weightSum = SERVICES.reduce((t, x) => t + x.weight, 0);
for (let job = 1; job <= JOBS; job++) {
  if ((job - 1) % JOBS_PER_DAY === 0 && job > 1) { day++; daySpend = 0; }
  let pick = rand() * weightSum;
  const svc = SERVICES.find((x) => (pick -= x.weight) < 0) ?? SERVICES[0];
  const priv = rand() < PRIVATE_SHARE;
  const lots = planLots(svc.team, SPEND[svc.id] ?? {}, svc.price, POLICY.minMarginBps);
  const reserves = lots.reduce((t, l) => t + l.reserve, 0);
  check(reserves <= svc.price * (1 - POLICY.minMarginBps / 1e4) + 1e-9, `job ${job}: reserves ${reserves} eat into the margin`);
  totals.jobs++; totals.private += Number(priv); totals.lots += lots.length; totals.reserveTotal += reserves;

  const results = lots.map((l) => ({ title: l.title, reserve: l.reserve, ...runLot(job, l.title, l.roles, l.cost, l.reserve, !priv) }));
  const anyVoid = results.some((x) => x.status === 'void');
  const accepted = rand() < (anyVoid ? 0.6 : 0.95);
  const outside = results.filter((x) => x.outside).reduce((t, x) => t + x.pay, 0);
  const teamPay = results.filter((x) => !x.outside && x.status === 'passed').reduce((t, x) => t + x.pay, 0);
  if (accepted) {
    // Team winners are paid; an outside winner's pay refills TOOLS (already paid on the market); the margin splits.
    for (const x of results) if (!x.outside && x.status === 'passed') byAccount.get(x.winner!)!.earned += x.pay;
    const margin = svc.price - teamPay - outside;
    const contributors = (Math.max(0, margin) * POLICY.contributorsBps) / 1e4;
    totals.accepted++; totals.revenue += svc.price; totals.teamPaid += teamPay; totals.contributors += contributors; totals.kept += margin - contributors; totals.payTotal += teamPay + outside;
  } else { totals.rejected++; totals.refunded += svc.price; totals.kept -= outside; } // a refund; the team's work was at its own risk
  log.push({ job, day, service: svc.id, price: svc.price, private: priv, accepted, lots: results });
}

// The report.
const $ = (x: number) => x.toFixed(4);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
console.log(`\nParallax swarm simulation: ${totals.jobs} jobs over ${day + 1} days, seed ${SEED}\n`);
console.log(`Jobs        ${totals.accepted} accepted, ${totals.rejected} rejected and refunded, ${totals.private} private (team only)`);
console.log(`Lots        ${totals.lots} opened, ${totals.voidLots} left void, ${totals.rebids} rebid after a failed inspection or hire`);
console.log(`Bids        ${(totals.bids / (totals.lots + totals.rebids)).toFixed(1)} per round; ${totals.noReveals} sealed and never revealed; ${totals.probationSkips} skipped (probation)`);
console.log(`Market      ${totals.outsideQuotes} outside quotes, ${totals.outsideWins} hires delivered, ${totals.outsideFails} failed to deliver (not charged)`);
console.log(`Daily cap   ${totals.capWaits} awards waited for the next day`);
console.log(`Money       revenue ${$(totals.revenue)}, team paid ${$(totals.teamPaid)}, market paid ${$(totals.outsidePaid)}, contributors ${$(totals.contributors)}, bank kept ${$(totals.kept)}, refunded ${$(totals.refunded)}`);
console.log(`            lots cost ${pct(totals.payTotal, totals.revenue)} of revenue (reserves allowed up to ${pct(totals.reserveTotal, totals.revenue + totals.refunded)})`);
console.log(`\nTeam (sorted by earnings)`);
console.log('  agent              role          rep    won  failed  no-reveal  earned    model bill  profit');
for (const a of [...team].sort((x, y) => y.earned - x.earned))
  console.log(`  ${a.account.split('.')[0].padEnd(18)} ${a.role.padEnd(12)} ${String(a.rep).padStart(4)}  ${String(a.won).padStart(5)}  ${String(a.failed).padStart(6)}  ${String(a.noReveals).padStart(9)}  ${$(a.earned)}  ${$(a.spent).padStart(10)}  ${$(a.earned - a.spent)}${a.probationAt ? `  on probation from job ${a.probationAt}` : ''}`);
console.log(`\nAgent Market`);
console.log('  agent                       quote   delivered  failed  record   quality  earned');
for (const o of market)
  console.log(`  ${o.handle.padEnd(26)}  ${o.price.toFixed(2)}   ${String(o.won).padStart(9)}  ${String(o.failed).padStart(6)}  ${(successPct(o) ?? 0).toFixed(0).padStart(5)}%  ${String(qualityBps(o.delivered, successPct(o))).padStart(7)}  ${$(o.earned)}`);
console.log(`\nRules: ${broken.length ? `${broken.length} BROKEN\n  ${broken.slice(0, 10).join('\n  ')}` : 'every award held (pay ≥ bid, team pay ≤ reserve, outside paid its quote, no winner on probation, reserves inside the margin)'}`);
console.log(`Truthful bidding: ${truth.checked} what-ifs where a bidder shaded its price; ${truth.betterOff} paid off\n`);

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/swarm-sim.json', import.meta.url), JSON.stringify({ seed: SEED, policy: POLICY, totals, truth, broken, team, market, jobs: log }, null, 2));
if (broken.length || truth.betterOff) process.exit(1);
