// The proof page's checks. Nothing here talks to the Parallax server: the bank's state comes from a NEAR RPC node
// and every transaction it took part in from FastNEAR's transaction index. Each auction is rebuilt from the
// revealed bids and the bidders' records (themselves replayed from the bank's history), then compared with what
// the contract recorded, and each job's payouts with the USDC transfers it made. Plain TypeScript, so it runs
// in the browser and under node (web/scripts/verify.ts).
import { nameOf } from './team.ts';

export const NET = {
  bank: 'bank.parallax.testnet',
  usdc: 'usdc.parallax.testnet',
  rpc: 'https://rpc.testnet.fastnear.com',
  index: 'https://tx.test.fastnear.com',
  explorer: 'https://testnet.nearblocks.io',
};

type Seller = { Team: string } | { Outside: string };
export type ChainLot = {
  id: number; job: string; title: string; reserve: string; round: number; status: string;
  commits: { agent: string; hash: string }[]; reveals: { agent: string; price: string }[];
  outside: { handle: string; price: string; quality_bps: number }[]; winner: Seller | null; bid: string; pay: string;
};
type ChainJob = { id: string; customer: string; amount: string; state: string; lots: number[] };
export type Ev = { event: string; data: any; block: number };
/** One transaction that touched the bank: its first call, and what the bank logged and the token moved. */
export type Call = {
  tx: string; block: number; signer: string; method: string; args: any; ok: boolean; events: Ev[];
  transfers: { from: string; to: string; amount: bigint }[];
};
export type Raw = { calls: Call[]; lots: ChainLot[]; jobs: ChainJob[]; agents: [string, { rep: number }][] };

export type Check = { ok: boolean; what: string; detail: string; tx?: string };
export type Bid = {
  seller: string; outside: boolean; price: bigint; rep?: number; q: bigint; salt?: string; hash?: string;
  revealTx?: string; win?: boolean;
};
export type Round = { lot: ChainLot; n: number; bids: Bid[]; pay: bigint; payNote: string; checks: Check[]; awardTx?: string };
export type JobProof = { job: ChainJob; outcome: string; rounds: Round[]; checks: Check[] };
export type Proof = { jobs: JobProof[]; checks: Check[]; total: number; passed: number; txs: number };

const post = async (url: string, body: unknown): Promise<any> => {
  // Free public nodes rate-limit; wait and ask again.
  for (let tries = 1; ; tries++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    if (r.status !== 429 || tries === 6) throw new Error(`${new URL(url).host} answered ${r.status}`);
    await new Promise((f) => setTimeout(f, 800 * tries));
  }
};
const text = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const json = (b64: string) => { try { return JSON.parse(text(b64)); } catch { return {}; } };

/** A view call on the bank at the latest final block. */
async function view<T>(method: string, args: object): Promise<T> {
  const r = await post(NET.rpc, {
    jsonrpc: '2.0', id: 1, method: 'query',
    params: { request_type: 'call_function', account_id: NET.bank, method_name: method, args_base64: btoa(JSON.stringify(args)), finality: 'final' },
  });
  if (r.error) throw new Error(`${method}: ${r.error.cause?.name ?? r.error.message}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result.result)));
}

export async function sha256(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every transaction the index has for the bank, oldest first. */
async function history(say: (s: string) => void): Promise<Call[]> {
  const hashes: string[] = [];
  let resume: string | undefined;
  do {
    const r = await post(`${NET.index}/v0/account`, { account_id: NET.bank, ...(resume ? { resume_token: resume } : {}) });
    hashes.push(...r.account_txs.map((t: any) => t.transaction_hash));
    resume = r.resume_token;
  } while (resume);
  const txs: any[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    say(`Reading transactions ${i + 1}–${Math.min(i + 20, hashes.length)} of ${hashes.length}`);
    txs.push(...(await post(`${NET.index}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) })).transactions);
  }
  const calls = txs.map((t): Call => {
    const fc = t.transaction.actions.find((a: any) => a.FunctionCall)?.FunctionCall;
    const events: Ev[] = [], transfers: Call['transfers'] = [];
    let ok = !t.execution_outcome.outcome.status.Failure;
    for (const r of t.receipts) {
      const o = r.execution_outcome.outcome;
      if (o.executor_id === NET.bank && o.status.Failure) ok = false;
      for (const l of o.logs as string[]) {
        if (!l.startsWith('EVENT_JSON:')) continue;
        const e = JSON.parse(l.slice(11));
        if (o.executor_id === NET.bank && e.standard === 'parallax') events.push({ event: e.event, data: e.data[0], block: r.execution_outcome.block_height });
        if (o.executor_id === NET.usdc && e.event === 'ft_transfer') for (const d of e.data) transfers.push({ from: d.old_owner_id, to: d.new_owner_id, amount: BigInt(d.amount) });
      }
    }
    return {
      tx: t.transaction.hash, block: t.execution_outcome.block_height, signer: t.transaction.signer_id,
      method: fc?.method_name ?? Object.keys(t.transaction.actions[0] ?? {})[0] ?? '', args: fc ? json(fc.args) : {}, ok, events, transfers,
    };
  });
  return calls.sort((a, b) => a.block - b.block);
}

const eventsOf = (calls: Call[], name: string) => calls.flatMap((c) => c.events.filter((e) => e.event === name).map((e) => ({ ...e, call: c })));

/** Fetch everything the checks need. The slow part; verify() is pure and instant. */
export async function load(say: (s: string) => void = () => {}): Promise<Raw> {
  say('Asking the index for every bank transaction');
  const calls = await history(say);
  say('Reading the lots and jobs from the contract');
  const lots: ChainLot[] = [];
  for (let from = 0; ; from += 50) {
    const page = await view<ChainLot[]>('list_lots', { from, limit: 50 });
    lots.push(...page);
    if (page.length < 50) break;
  }
  const jobs = await Promise.all([...new Set(lots.map((l) => l.job))].map((id) => view<ChainJob>('get_job', { id })));
  const agents = await view<Raw['agents']>('list_agents', {});
  return { calls, lots, jobs, agents };
}

const sellerOf = (s: Seller | null | undefined) => (!s ? '' : 'Team' in s ? s.Team : `outside:${s.Outside}`);
const quality = (rep: number) => 5000n + 5n * BigInt(rep);
const setOf = (m: Map<number, Set<string>>, k: number) => m.get(k) ?? m.set(k, new Set()).get(k)!;

/**
 * Every agent's record replayed from the bank's history the way the contract keeps it: 500 when hired, +10 for a
 * passed inspection (at most 1000), -50 for a failed one, -20 for a sealed bid never revealed. Also what each
 * award's bidders stood at when it was scored, and the contributors' share in force at each acceptance.
 */
function replay(calls: Call[]) {
  const rep = new Map<string, number>(), at: Record<string, number> = {}, bps: Record<string, number> = {};
  const sealed = new Map<number, Set<string>>(), shown = new Map<number, Set<string>>();
  const add = (a: string, d: number) => rep.has(a) && rep.set(a, Math.min(1000, Math.max(0, rep.get(a)! + d)));
  let share = 0;
  for (const c of calls) {
    if (c.method === 'new' || c.method === 'set_policy') share = c.args.policy.contributors_bps;
    if (c.method === 'hire' && !rep.has(c.args.agent)) rep.set(c.args.agent, 500);
    for (const e of c.events) {
      const lot = Number(e.data.lot);
      if (e.event === 'commit') setOf(sealed, lot).add(e.data.agent);
      if (e.event === 'reveal') setOf(shown, lot).add(e.data.agent);
      if (e.event === 'award' || e.event === 'void') {
        for (const a of setOf(sealed, lot)) if (!setOf(shown, lot).has(a)) add(a, -20);
        for (const a of setOf(shown, lot)) at[`${e.block}:${a}`] = rep.get(a) ?? 0;
        sealed.delete(lot); shown.delete(lot);
      }
      if (e.event === 'pass' && 'Team' in e.data.winner) add(e.data.winner.Team, 10);
      if (e.event === 'fail' && 'Team' in e.data.seller) add(e.data.seller.Team, -50);
      if (e.event === 'accepted') bps[c.tx] = share;
    }
  }
  return { rep, at, bps };
}

/**
 * Rebuild every auction and settlement from the raw chain data. `tamper` changes the first revealed bid by one
 * unit ($0.000001) before checking, to show a check failing.
 */
export async function verify(raw: Raw, tamper = false): Promise<Proof> {
  const calls = raw.calls.filter((c) => c.ok);
  const { rep: reps, at: repAt, bps: shares } = replay(calls);
  let tampered = !tamper;
  // `fail` is the failed inspection after this round's award, if any: the contract put the lot back up for bids.
  type Laid = Round & { award: Ev & { call: Call }; fail?: Ev & { call: Call } };
  const jobs: (JobProof & { rounds: Laid[] })[] = [];
  const opened = calls.filter((c) => c.method === 'open_job').map((c) => c.args.id as string);
  const order = [...raw.jobs].sort((a, b) => opened.indexOf(b.id) - opened.indexOf(a.id));

  for (const job of order) {
    const rounds: Laid[] = [];
    for (const lot of raw.lots.filter((l) => l.job === job.id)) {
      const mine = (name: string) => eventsOf(calls, name).filter((e) => Number(e.data.lot) === lot.id);
      const restarts = [...mine('fail'), ...mine('reopen')].map((e) => e.block);
      const awards = mine('award');
      awards.forEach((award, n) => {
        const since = Math.max(0, ...restarts.filter((b) => b < award.block));
        const inRound = (c: Call) => c.args.lot === lot.id && c.block > since && c.block < award.block;
        const checks: Check[] = [];
        const bids: Bid[] = [];
        for (const rv of calls.filter((c) => c.method === 'reveal' && inRound(c))) {
          const price = BigInt(rv.args.price) + (tampered ? 0n : 1n);
          tampered = true;
          const commit = calls.filter((c) => c.method === 'commit' && c.signer === rv.signer && inRound(c) && c.block <= rv.block).pop();
          const rep = repAt[`${award.block}:${rv.signer}`] ?? 0;
          bids.push({ seller: rv.signer, outside: false, price, rep, q: quality(rep), salt: rv.args.salt, hash: commit?.args.hash, revealTx: rv.tx });
        }
        for (const ob of calls.filter((c) => c.method === 'add_outside' && inRound(c))) {
          const seller = `outside:${ob.args.handle}`;
          const at = bids.findIndex((b) => b.seller === seller);
          const bid = { seller, outside: true, price: BigInt(ob.args.price), q: BigInt(ob.args.quality_bps), revealTx: ob.tx };
          if (at >= 0) bids[at] = bid; else bids.push(bid);
        }
        const fail = mine('fail').find((e) => e.block > award.block && !awards.some((x) => x.block > award.block && x.block < e.block));
        rounds.push({ lot, n: n + 1, bids, pay: 0n, payNote: '', checks, awardTx: award.call.tx, award, fail });
      });
    }
    jobs.push({ job, outcome: '', rounds, checks: [] });
  }

  for (const jp of jobs) {
    for (const r of jp.rounds) {
      const { lot, bids, checks, award } = r;
      // 1. Every revealed bid is the one sealed earlier.
      for (const b of bids.filter((b) => !b.outside)) {
        const pre = `${lot.id}:${b.seller}:${b.price}:${b.salt}`;
        const h = await sha256(pre);
        checks.push({
          ok: h === b.hash, what: `${nameOf(b.seller)}'s sealed bid`,
          detail: `sha256("${pre}") = ${h.slice(0, 16)}…, ${h === b.hash ? 'the same as' : 'not'} the commit ${b.hash?.slice(0, 16) ?? '(none)'}… it sent before bidding closed`,
          tx: b.revealTx,
        });
      }
      // 2. The award, rebuilt the contract's way: score = price / quality, the team before outside agents on a tie.
      const ranked = [...bids].sort((a, b) => {
        const x = a.price * b.q, y = b.price * a.q;
        return x < y ? -1 : x > y ? 1 : Number(a.outside) - Number(b.outside) || (a.seller < b.seller ? -1 : a.seller > b.seller ? 1 : 0);
      });
      r.bids = ranked;
      const [w, second] = ranked;
      const reserve = BigInt(lot.reserve);
      if (w) {
        w.win = true;
        if (w.outside) { r.pay = w.price; r.payNote = 'an outside agent is paid its own quoted price'; }
        else if (second) {
          const raw2 = (second.price * w.q) / second.q;
          r.pay = raw2 < w.price ? w.price : raw2 > reserve ? reserve : raw2;
          r.payNote = `second-best price, adjusted for quality: ${second.price} × ${w.q} / ${second.q} = ${raw2}${raw2 !== r.pay ? `, kept between the winning bid and the reserve: ${r.pay}` : ''}`;
        } else { r.pay = reserve; r.payNote = 'the only bidder is paid the reserve'; }
      }
      const ev = award.data;
      checks.push({ ok: sellerOf(ev.winner) === (w?.seller ?? ''), what: 'Winner', detail: `rebuilt: ${w?.seller ?? 'nobody'}; the contract awarded ${sellerOf(ev.winner)}`, tx: award.call.tx });
      checks.push({ ok: BigInt(ev.pay) === r.pay, what: 'Pay', detail: `rebuilt: ${r.pay} (${r.payNote}); the contract set ${ev.pay}`, tx: award.call.tx });
      if (r === (jp.rounds.filter((x) => x.lot.id === lot.id).pop())) {
        if (r.fail) checks.push({
          ok: lot.round === Number(r.fail.data.round) && !lot.winner && lot.status !== 'Passed',
          what: 'Stored lot', detail: `lot ${lot.id} failed inspection, so the contract put it back up for round ${r.fail.data.round}; on the contract today: round ${lot.round}, ${lot.status}, no winner`,
          tx: r.fail.call.tx,
        });
        else checks.push({
          ok: sellerOf(lot.winner) === sellerOf(ev.winner) && lot.pay === ev.pay && lot.bid === ev.bid,
          what: 'Stored lot', detail: `lot ${lot.id} on the contract today: won by ${sellerOf(lot.winner)}, bid ${lot.bid}, pay ${lot.pay}, ${lot.status}`,
        });
      }
    }

    // 3. Settlement: what the job paid out against what the lots say.
    const { job } = jp;
    const amount = BigInt(job.amount);
    const of = (name: string) => eventsOf(calls, name).filter((e) => e.data.job === job.id);
    const funded = of('funded')[0];
    if (funded) jp.checks.push({ ok: BigInt(funded.data.amount) === amount, what: 'Escrow', detail: `${funded.data.payer} paid ${funded.data.amount} into escrow for a job priced at ${job.amount}`, tx: funded.call.tx });
    const acc = of('accepted')[0], ref = of('refund')[0];
    if (acc) {
      jp.outcome = 'Accepted, paid out';
      const passed = raw.lots.filter((l) => l.job === job.id && l.status === 'Passed');
      const cost = passed.reduce((t, l) => t + BigInt(l.pay), 0n);
      const margin = amount - cost;
      const bps = shares[acc.call.tx];
      const contributors = (margin * BigInt(bps)) / 10000n;
      const d = acc.data;
      jp.checks.push({ ok: BigInt(d.cost) === cost, what: 'Cost', detail: `the passed lots' pay adds up to ${passed.map((l) => l.pay).join(' + ')} = ${cost}; the contract booked ${d.cost}`, tx: acc.call.tx });
      jp.checks.push({ ok: BigInt(d.margin) === margin && BigInt(d.contributors) === contributors, what: 'Margin', detail: `${amount} − ${cost} = ${margin}, and ${bps / 100}% of it to contributors is ${contributors}; the contract booked ${d.margin} and ${d.contributors}`, tx: acc.call.tx });
      const sent = acc.call.transfers.filter((t) => t.from === NET.bank);
      for (const l of passed.filter((l) => l.winner && 'Team' in l.winner)) {
        const to = sellerOf(l.winner), at = sent.findIndex((t) => t.to === to && t.amount === BigInt(l.pay));
        jp.checks.push({ ok: at >= 0, what: `${l.title} paid`, detail: at >= 0 ? `${l.pay} USDC units went to ${to}` : `no transfer of ${l.pay} to ${to}`, tx: acc.call.tx });
        if (at >= 0) sent.splice(at, 1);
      }
      if (contributors > 0n) {
        const at = sent.findIndex((t) => t.amount === contributors);
        jp.checks.push({ ok: at >= 0, what: 'Contributors paid', detail: at >= 0 ? `${contributors} went to ${sent[at].to}` : `no transfer of ${contributors}`, tx: acc.call.tx });
        if (at >= 0) sent.splice(at, 1);
      }
      jp.checks.push({ ok: sent.length === 0, what: 'Nothing else left', detail: sent.length ? `unexplained transfers: ${sent.map((t) => `${t.amount} to ${t.to}`).join(', ')}` : 'the bank sent no other USDC in that transaction', tx: acc.call.tx });
    } else if (ref) {
      jp.outcome = `Refunded (${ref.data.why})`;
      const back = ref.call.transfers.filter((t) => t.from === NET.bank);
      jp.checks.push({ ok: BigInt(ref.data.refund) === amount && back.length === 1 && back[0].to === job.customer && back[0].amount === amount, what: 'Refund', detail: `the customer ${job.customer} got ${back.map((t) => t.amount).join(' + ') || 'nothing'} back of ${job.amount}, and no lot was paid`, tx: ref.call.tx });
    } else jp.outcome = job.state;
  }

  // 4. The records the awards were scored with, replayed to today, are the ones the contract holds.
  const off = raw.agents.filter(([a, ag]) => reps.get(a) !== ag.rep);
  const checks: Check[] = [{
    ok: off.length === 0 && reps.size === raw.agents.length, what: 'Agent records',
    detail: off.length ? `replayed records differ for ${off.map(([a, ag]) => `${a} (${reps.get(a)} vs ${ag.rep})`).join(', ')}`
      : `all ${raw.agents.length} agents' records, replayed from ${calls.length} transactions, match the contract today: ${raw.agents.map(([a, ag]) => `${a.split('.')[0]} ${ag.rep}`).join(', ')}`,
  }];
  const all = [...checks, ...jobs.flatMap((j) => [...j.rounds.flatMap((r) => r.checks), ...j.checks])];
  return { jobs, checks, total: all.length, passed: all.filter((c) => c.ok).length, txs: raw.calls.length };
}

/** $0.004896 for 4896 units of 6-decimal USDC. */
export const units = (u: bigint | string | number) => {
  const n = Number(u) / 1e6;
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
};
