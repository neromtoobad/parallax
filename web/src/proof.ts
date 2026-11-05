// The proof page's checks. The bank's state comes from a NEAR RPC node and every transaction it took part in
// from FastNEAR's transaction index. Each auction is rebuilt from the revealed bids and the bidders' records
// (themselves replayed from the bank's history), then compared with what the contract recorded, and each job's
// payouts with the USDC transfers and balances it made. Each TEE signature on delivered work is recovered here
// again, and each approved signer's attestation report is matched to the hash the bank holds; the report file
// is the one thing read from the Parallax server, and its hash on chain is what makes that safe. The same holds
// for enlisted agents: each spec is fetched by the hash the bank holds, and each review's exact request and answer
// are hashed against the TEE-signed text the CFO filed with its verdict. Plain
// TypeScript, so it runs in the browser and under node (web/scripts/verify.ts).
import { nameOf } from './team.ts';
import { keccak256, hexToBytes, signerOf, toHex } from './ecrecover.ts';

export const NET = {
  bank: 'bank.parallax.testnet',
  usdc: 'usdc.parallax.testnet',
  rpc: 'https://rpc.testnet.fastnear.com',
  index: 'https://tx.test.fastnear.com',
  explorer: 'https://testnet.nearblocks.io',
  reports: 'https://useparallax.xyz/api/attestation',
  crew: 'https://useparallax.xyz/api/crew',
  board: 'https://useparallax.xyz/api/board',
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
  // an enlisted agent's call (crew_commit and the rest) reads as the agent's own, with the operator in `via`
  tx: string; block: number; signer: string; via?: string; method: string; args: any; ok: boolean; events: Ev[];
  transfers: { from: string; to: string; amount: bigint }[];
};
export type SignerRec = { model: string; report: string; by: string; active: boolean };
export type Raw = {
  calls: Call[]; lots: ChainLot[]; jobs: ChainJob[]; agents: [string, { rep: number }][];
  signers: [string, SignerRec][]; reports: Record<string, string | null>; policy: { compute?: string; daily_model_cap?: string };
  specs?: Record<string, string | null>; reviews?: Record<string, any | null>;
  briefs?: Record<string, string | null>; screens?: Record<string, any | null>;
};

export type Check = { ok: boolean; what: string; detail: string; tx?: string };
export type Bid = {
  seller: string; outside: boolean; price: bigint; rep?: number; newcomer?: boolean; q: bigint; salt?: string; hash?: string;
  revealTx?: string; win?: boolean;
};
export type Round = { lot: ChainLot; n: number; bids: Bid[]; pay: bigint; payNote: string; checks: Check[]; awardTx?: string };
export type JobProof = { job: ChainJob; outcome: string; rounds: Round[]; checks: Check[] };
export type Proof = { jobs: JobProof[]; checks: Check[]; total: number; passed: number; txs: number };

const post = async (url: string, body: unknown): Promise<any> => {
  // Free public nodes rate-limit; wait and ask again. A limited answer often comes without CORS headers, so the
  // browser reports it as a failed fetch rather than a 429: retry those too.
  for (let tries = 1; ; tries++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch((e: Error) => e);
    if (!(r instanceof Error) && r.ok) return r.json();
    const why = r instanceof Error ? r.message : `answered ${r.status}`;
    if ((!(r instanceof Error) && r.status !== 429 && r.status < 500) || tries === 8) throw new Error(`${new URL(url).host} ${why}`);
    await new Promise((f) => setTimeout(f, 1000 * tries));
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
    const args = fc ? json(fc.args) : {}, method: string = fc?.method_name ?? Object.keys(t.transaction.actions[0] ?? {})[0] ?? '';
    const crew = method.startsWith('crew_') && method !== 'crew_cash_out' && typeof args.agent === 'string';
    return {
      tx: t.transaction.hash, block: t.execution_outcome.block_height, signer: crew ? args.agent : t.transaction.signer_id,
      ...(crew ? { via: t.transaction.signer_id } : {}), method: crew ? method.slice(5) : method, args, ok, events, transfers,
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
  const policy = await view<Raw['policy']>('get_policy', {});
  // Banks deployed before 4 Nov have no TEE signers.
  const signers = await view<Raw['signers']>('list_signers', {}).catch(() => [] as Raw['signers']);
  const reports: Raw['reports'] = {};
  if (signers.length) say('Fetching the attestation reports behind the approved TEE signers');
  for (const [a, sg] of signers) reports[a] = await fetch(`${NET.reports}/${sg.report}`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  // The open crew: each enlisted agent's spec by its hash, and each review's exact request and answer.
  const specs: Raw['specs'] = {}, reviews: Raw['reviews'] = {};
  const enlisted = eventsOf(calls, 'enlist'), reviewed = eventsOf(calls, 'review');
  if (enlisted.length) say('Fetching the enlisted agents\' specs and reviews');
  for (const e of enlisted) specs[e.data.spec] = await fetch(`${NET.crew}/spec/${e.data.spec}`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  for (const e of reviewed) reviews[e.data.agent] = await fetch(`${NET.crew}/review/${e.data.agent}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // The board: each posted brief by its hash, and each screen's exact request and answer.
  const briefs: Raw['briefs'] = {}, screens: Raw['screens'] = {};
  const posts = eventsOf(calls, 'posted'), screened = [...eventsOf(calls, 'taken'), ...eventsOf(calls, 'declined')];
  if (posts.length) say('Fetching the board\'s briefs and screens');
  for (const e of posts) briefs[e.data.spec] = await fetch(`${NET.board}/brief/${e.data.spec}`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  for (const e of screened) if (e.data.tee?.length) screens[e.data.job] = await fetch(`${NET.board}/screen/${e.data.job}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return { calls, lots, jobs, agents, signers, reports, policy, specs, reviews, briefs, screens };
}

/** The attestation report checks for one approved signer: the bank's hash, the key it names, and the TDX quote's binding. */
async function reportChecks(address: string, sg: SignerRec, raw: string | null): Promise<Check[]> {
  const who = `TEE signer ${address.slice(0, 10)}…`;
  if (!raw) return [{ ok: false, what: who, detail: `no attestation report could be fetched from ${NET.reports}` }];
  const h = await sha256(raw);
  const out: Check[] = [{ ok: h === sg.report, what: `${who} report`, detail: `sha256 of the report is ${h.slice(0, 16)}…, ${h === sg.report ? 'the same as' : 'not'} the ${sg.report.slice(0, 16)}… the bank approved it with` }];
  let m: any;
  try { m = (JSON.parse(raw).model_attestations ?? []).find((x: any) => String(x.signing_address).toLowerCase() === address); } catch { /* not JSON */ }
  const fromKey = m ? `0x${toHex(keccak256(hexToBytes(m.signing_public_key)).slice(12))}` : '';
  out.push({ ok: !!m && m.model_name === sg.model && fromKey === address, what: `${who} key`, detail: m ? `the report's ${m.model_name} key hashes to ${fromKey}; the bank approved ${address} for ${sg.model}` : `the report names no key ${address}` });
  // In a v4 TDX quote, report_data is bytes 568–632: here the signing address, zero padding, then the request's nonce.
  const rd = m ? toHex(hexToBytes(m.intel_quote).slice(568, 632)) : '';
  const bound = !!m && rd === address.slice(2) + '0'.repeat(24) + String(m.request_nonce);
  out.push({ ok: bound, what: `${who} TDX quote`, detail: bound ? `the Intel TDX quote's report_data is this address and the nonce ${String(m.request_nonce).slice(0, 12)}…, so the key was made inside that enclave` : `the quote's report_data (${rd.slice(0, 24)}…) doesn't name this key` });
  return out;
}

const sellerOf = (s: Seller | null | undefined) => (!s ? '' : 'Team' in s ? s.Team : `outside:${s.Outside}`);
const quality = (rep: number) => 5000n + 5n * BigInt(rep);
const setOf = (m: Map<number, Set<string>>, k: number) => m.get(k) ?? m.set(k, new Set()).get(k)!;

/**
 * Every agent's record replayed from the bank's history the way the contract keeps it: 500 when hired, +10 for a
 * passed inspection (at most 1000), -50 for a failed one, -20 for a sealed bid never revealed. Also what each
 * award's bidders were weighed by when it was scored, and the contributors' share in force at each acceptance.
 * From the bank's `rules` event on (rule 32), an enlisted agent with fewer passed parts than it says and no failed
 * inspection is weighed as if its record were at least 500.
 */
function replay(calls: Call[]) {
  const rep = new Map<string, number>(), at: Record<string, number> = {}, fresh: Record<string, boolean> = {}, bps: Record<string, number> = {};
  const sealed = new Map<number, Set<string>>(), shown = new Map<number, Set<string>>();
  const add = (a: string, d: number) => rep.has(a) && rep.set(a, Math.min(1000, Math.max(0, rep.get(a)! + d)));
  const crew = new Set<string>(), wins = new Map<string, number>(), fails = new Map<string, number>();
  const bump = (m: Map<string, number>, a: string) => m.set(a, (m.get(a) ?? 0) + 1);
  let share = 0, newcomerWins = 0;
  const weighed = (a: string) => {
    const r = rep.get(a) ?? 0;
    return crew.has(a) && (wins.get(a) ?? 0) < newcomerWins && !fails.get(a) ? Math.max(r, 500) : r;
  };
  for (const c of calls) {
    if (c.method === 'new' || c.method === 'set_policy') share = c.args.policy.contributors_bps;
    if (c.method === 'hire' && !rep.has(c.args.agent)) rep.set(c.args.agent, 500);
    for (const e of c.events) {
      if (e.event === 'enlist') { rep.set(e.data.agent, 300); crew.add(e.data.agent); } // enlisted agents start below a hire
      if (e.event === 'rules' && e.data.newcomer_wins !== undefined) newcomerWins = Number(e.data.newcomer_wins);
      const lot = Number(e.data.lot);
      if (e.event === 'commit') setOf(sealed, lot).add(e.data.agent);
      if (e.event === 'reveal') setOf(shown, lot).add(e.data.agent);
      if (e.event === 'award' || e.event === 'void') {
        for (const a of setOf(sealed, lot)) if (!setOf(shown, lot).has(a)) add(a, -20);
        for (const a of setOf(shown, lot)) { at[`${e.block}:${a}`] = weighed(a); fresh[`${e.block}:${a}`] = weighed(a) !== (rep.get(a) ?? 0); }
        sealed.delete(lot); shown.delete(lot);
      }
      if (e.event === 'pass' && 'Team' in e.data.winner) { add(e.data.winner.Team, 10); bump(wins, e.data.winner.Team); }
      if (e.event === 'fail' && 'Team' in e.data.seller) { add(e.data.seller.Team, -50); bump(fails, e.data.seller.Team); }
      if (e.event === 'accepted') bps[c.tx] = share;
    }
  }
  return { rep, at, fresh, bps };
}

/**
 * Rebuild every auction and settlement from the raw chain data. `tamper` changes the first revealed bid by one
 * unit ($0.000001) before checking, to show a check failing.
 */
export async function verify(raw: Raw, tamper = false): Promise<Proof> {
  const calls = raw.calls.filter((c) => c.ok);
  const { rep: reps, at: repAt, fresh, bps: shares } = replay(calls);
  // Signers as approved on chain at any time (a later revoke doesn't undo work it took while active).
  const approved = new Map<string, SignerRec>();
  for (const e of eventsOf(calls, 'signer')) approved.set(e.data.address, { model: e.data.model, report: e.data.report, by: e.data.by, active: true });
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
          bids.push({ seller: rv.signer, outside: false, price, rep, newcomer: fresh[`${award.block}:${rv.signer}`], q: quality(rep), salt: rv.args.salt, hash: commit?.args.hash, revealTx: rv.tx });
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
      // The work filed for this round: each TEE signature recovered again, against the signers the bank approved.
      const end = r.fail?.block ?? Infinity;
      for (const d of calls.filter((c) => c.method === 'deliver' && c.args.lot === lot.id && c.block > award.block && c.block <= end)) {
        const sigs: { text: string; signature: string }[] = d.args.tee ?? [];
        if (!sigs.length) continue;
        const bad = sigs.map((t) => ({ t, who: signerOf(t.text, t.signature) })).filter(({ t, who }) => {
          const sg = who ? approved.get(who) : undefined;
          return !sg || !t.text.startsWith(`${sg.model}:`);
        });
        checks.push({
          ok: !bad.length, what: 'TEE-signed work',
          detail: bad.length ? `${bad.length} of ${sigs.length} signatures don't recover to an approved signer for their model`
            : `${sigs.length} model ${sigs.length === 1 ? 'answer' : 'answers'} signed inside NEAR AI Cloud's TEE by ${[...new Set(sigs.map((t) => signerOf(t.text, t.signature)!.slice(0, 10)))].join(', ')}…, each over sha256 of the exact request and answer`,
          tx: d.tx,
        });
      }
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
    const funded = of('funded')[0], posted = of('posted')[0];
    if (posted) jp.checks.push({ ok: BigInt(posted.data.amount) === amount, what: 'Escrow', detail: `${posted.data.customer} put ${posted.data.amount} into escrow when it posted the job on the board, and the job is priced at ${job.amount}`, tx: posted.call.tx });
    if (funded) jp.checks.push({ ok: BigInt(funded.data.amount) === amount, what: 'Escrow', detail: `${funded.data.payer} paid ${funded.data.amount} into escrow for a job priced at ${job.amount}`, tx: funded.call.tx });
    const sub = of('sub')[0];
    if (sub) { // an agent hired this job for its own part, paid from its balance (rule 38)
      const part = raw.lots.find((l) => l.id === Number(sub.data.lot));
      jp.checks.push({
        ok: BigInt(sub.data.amount) === amount && job.customer === sub.data.by && !!part?.winner && sellerOf(part.winner) === sub.data.by && part.job === sub.data.parent,
        what: 'Escrow', detail: `${sub.data.by} paid ${sub.data.amount} from its own balance into escrow for a job priced at ${job.amount}, hired for lot ${sub.data.lot} of job ${sub.data.parent}, ${part?.winner ? `a part the bank awarded to ${sellerOf(part.winner)}` : 'a part with no winner'}`,
        tx: sub.call.tx,
      });
    }
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
      // Before 4 Nov a team winner was sent its pay; since then it's credited to its balance at the bank.
      const credits = acc.call.events.filter((e) => e.event === 'credit' && e.data.what === 'lot');
      for (const l of passed.filter((l) => l.winner && 'Team' in l.winner)) {
        const to = sellerOf(l.winner), at = sent.findIndex((t) => t.to === to && t.amount === BigInt(l.pay));
        const cr = at < 0 ? credits.findIndex((e) => e.data.agent === to && BigInt(e.data.amount) === BigInt(l.pay)) : -1;
        jp.checks.push({ ok: at >= 0 || cr >= 0, what: `${l.title} paid`, detail: at >= 0 ? `${l.pay} USDC units went to ${to}` : cr >= 0 ? `${l.pay} USDC units were credited to ${to}'s balance at the bank` : `no transfer or credit of ${l.pay} to ${to}`, tx: acc.call.tx });
        if (at >= 0) sent.splice(at, 1);
        if (cr >= 0) credits.splice(cr, 1);
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
  // 5. Model bills: each went from an agent's balance only to the compute account, inside the daily cap.
  const bills = calls.filter((c) => c.method === 'pay_bill' && c.events.some((e) => e.event === 'bill'));
  if (bills.length) {
    const wrong = bills.filter((c) => {
      const e = c.events.find((x) => x.event === 'bill')!.data;
      const t = c.transfers.filter((x) => x.from === NET.bank);
      return e.to !== raw.policy.compute || BigInt(e.day_model_spend) > BigInt(raw.policy.daily_model_cap ?? 0)
        || (t.length && !(t.length === 1 && t[0].to === e.to && t[0].amount === BigInt(e.amount)));
    });
    checks.push({
      ok: !wrong.length, what: 'Model bills',
      detail: wrong.length ? `${wrong.length} of ${bills.length} bills went elsewhere or past the daily cap`
        : `all ${bills.length} model bills went from an agent's balance to ${raw.policy.compute}, and no day's total passed the ${units(raw.policy.daily_model_cap ?? 0)} cap`,
      tx: wrong[0]?.tx,
    });
  }
  // 6. Every approved TEE signer's attestation report.
  for (const [a, sg] of raw.signers) checks.push(...(await reportChecks(a, sg, raw.reports[a])));
  // 7. The open crew: specs, and reviews whose signed request and answer we can read.
  checks.push(...(await crewChecks(calls, raw, approved)));
  // 8. The board: briefs, and screens whose signed request and answer we can read.
  checks.push(...(await boardChecks(calls, raw, approved)));
  // 9. Bonds: each revealed bid locks its share, and each bond comes back or pays the customer.
  checks.push(...bondChecks(calls, raw));
  const all = [...checks, ...jobs.flatMap((j) => [...j.rounds.flatMap((r) => r.checks), ...j.checks])];
  return { jobs, checks, total: all.length, passed: all.filter((c) => c.ok).length, txs: raw.calls.length };
}

/**
 * For each enlisted agent: the spec the server serves hashes to what the bank holds and names the same agent;
 * a review the model passed or failed carries a TEE signature from an approved signer over the exact request
 * and answer the server publishes, the request has the whole spec in it, and the answer says what the verdict
 * says; a rejected agent's stake went back to its sponsor in the same transaction.
 */
async function crewChecks(calls: Call[], raw: Raw, approved: Map<string, SignerRec>): Promise<Check[]> {
  const out: Check[] = [];
  const enlisted = new Map(eventsOf(calls, 'enlist').map((e) => [e.data.agent as string, e]));
  for (const [agent, e] of enlisted) {
    const who = `Crew ${agent.split('.')[0]}`, specRaw = raw.specs?.[e.data.spec];
    if (!specRaw) { out.push({ ok: false, what: `${who} spec`, detail: `no spec ${e.data.spec.slice(0, 12)}… could be fetched from ${NET.crew}`, tx: e.call.tx }); continue; }
    const h = await sha256(specRaw);
    let sp: any = {};
    try { sp = JSON.parse(specRaw); } catch { /* not JSON */ }
    const same = h === e.data.spec && `${sp.slug}.${agent.split('.').slice(1).join('.')}` === agent && sp.name === e.data.name && sp.role === e.data.role;
    out.push({ ok: same, what: `${who} spec`, detail: `sha256 of the served spec is ${h.slice(0, 16)}…, ${h === e.data.spec ? 'the same as' : 'not'} the hash enlisted; it is ${sp.name ?? '?'}, a ${sp.role ?? '?'} named ${sp.slug ?? '?'}, staked ${units(e.data.stake)} by ${e.data.sponsor}`, tx: e.call.tx });
  }
  for (const r of eventsOf(calls, 'review')) {
    const agent: string = r.data.agent, who = `Crew ${agent.split('.')[0]}`, sigs: { text: string; signature: string }[] = r.call.args.tee ?? [];
    const rec = raw.reviews?.[agent], specRaw = raw.specs?.[enlisted.get(agent)?.data.spec];
    if (sigs.length) {
      const t = sigs[0], signer = signerOf(t.text, t.signature), sg = signer ? approved.get(signer) : undefined;
      const [, reqH, ansH] = t.text.slice((sg?.model.length ?? 0)).split(':');
      out.push({ ok: !!sg && t.text.startsWith(`${sg.model}:`), what: `${who} review signed`, detail: sg ? `the verdict's model answer was signed inside NEAR AI Cloud's TEE by ${signer}, approved for ${sg.model}` : 'the review signature does not recover to an approved signer', tx: r.call.tx });
      if (!rec?.request || !rec?.answer) { out.push({ ok: false, what: `${who} review bytes`, detail: `no review record at ${NET.crew}/review/${agent}`, tx: r.call.tx }); continue; }
      const [rq, an] = [await sha256(rec.request), await sha256(rec.answer)];
      let read = false, said: boolean | undefined;
      try { read = !!specRaw && JSON.parse(rec.request).messages.some((m: any) => String(m.content).includes(specRaw)); } catch { /* bad bytes */ }
      try { said = JSON.parse(String(JSON.parse(rec.answer).choices[0].message.content).match(/\{[\s\S]*\}/)![0]).pass === true; } catch { /* bad bytes */ }
      out.push({ ok: rq === reqH && an === ansH, what: `${who} review bytes`, detail: `sha256 of the published request is ${rq.slice(0, 12)}… and of the answer ${an.slice(0, 12)}…; the signed text has ${reqH?.slice(0, 12)}… and ${ansH?.slice(0, 12)}…`, tx: r.call.tx });
      out.push({ ok: read && said === r.data.pass, what: `${who} verdict`, detail: `the request ${read ? 'holds the whole spec' : 'does not hold the spec'}, and the model answered ${said === undefined ? 'nothing readable' : said ? 'pass' : 'fail'}; the CFO filed ${r.data.pass ? 'pass' : 'fail'}: "${r.data.note}"`, tx: r.call.tx });
    } else out.push({ ok: r.data.pass === false, what: `${who} review`, detail: r.data.pass ? 'passed with no TEE-signed model answer' : `rejected before any model call: "${r.data.note}"`, tx: r.call.tx });
    if (!r.data.pass) {
      const sponsor = enlisted.get(agent)?.data.sponsor, back = r.call.events.find((e) => e.event === 'cash_out' && e.data.to === sponsor);
      const moved = back && (r.call.transfers.some((t) => t.to === sponsor && t.amount === BigInt(back.data.amount)) || r.call.events.some((e) => e.event === 'credit' && e.data.agent === sponsor && e.data.amount === back.data.amount));
      out.push({ ok: !!moved, what: `${who} stake back`, detail: moved ? `${units(back!.data.amount)} went back to its sponsor ${sponsor}` : `no stake went back to ${sponsor}`, tx: r.call.tx });
    }
  }
  return out;
}

/**
 * For each job on the board: the brief the server serves hashes to what the bank holds. For each screen the CFO
 * filed: the model answer behind it was signed by an approved TEE signer, the published request and answer hash to
 * what was signed, the request holds the whole brief, and the answer's pass is what the CFO did (take or decline).
 * A declined job's money went back to its customer.
 */
async function boardChecks(calls: Call[], raw: Raw, approved: Map<string, SignerRec>): Promise<Check[]> {
  const out: Check[] = [];
  const posts = new Map(eventsOf(calls, 'posted').map((e) => [e.data.job as string, e]));
  for (const [id, e] of posts) {
    const who = `Board ${id}`, text = raw.briefs?.[e.data.spec];
    if (text == null) { out.push({ ok: false, what: `${who} brief`, detail: `no brief ${e.data.spec.slice(0, 12)}… could be fetched from ${NET.board}`, tx: e.call.tx }); continue; }
    const h = await sha256(text);
    out.push({ ok: h === e.data.spec, what: `${who} brief`, detail: `sha256 of the served brief is ${h.slice(0, 16)}…, ${h === e.data.spec ? 'the same as' : 'not'} the hash posted with ${units(e.data.amount)} by ${e.data.customer}`, tx: e.call.tx });
  }
  const screened = [...eventsOf(calls, 'taken').map((e) => [e, true] as const), ...eventsOf(calls, 'declined').map((e) => [e, false] as const)];
  for (const [e, took] of screened) {
    const id: string = e.data.job, who = `Board ${id}`, post = posts.get(id), sigs: { text: string; signature: string }[] = e.call.args.tee ?? [];
    if (!took && e.data.by === post?.data.customer) out.push({ ok: true, what: `${who} withdrawn`, detail: `nobody took it within a day, so ${e.data.by} took it back`, tx: e.call.tx });
    else if (sigs.length) {
      const t = sigs[0], signer = signerOf(t.text, t.signature), sg = signer ? approved.get(signer) : undefined;
      const [, reqH, ansH] = t.text.slice((sg?.model.length ?? 0)).split(':');
      out.push({ ok: !!sg && t.text.startsWith(`${sg.model}:`), what: `${who} screen signed`, detail: sg ? `the screen's model answer was signed inside NEAR AI Cloud's TEE by ${signer}, approved for ${sg.model}` : 'the screen signature does not recover to an approved signer', tx: e.call.tx });
      const rec = raw.screens?.[id], text = post && raw.briefs?.[post.data.spec];
      if (!rec?.request || !rec?.answer) { out.push({ ok: false, what: `${who} screen bytes`, detail: `no screen record at ${NET.board}/screen/${id}`, tx: e.call.tx }); continue; }
      const [rq, an] = [await sha256(rec.request), await sha256(rec.answer)];
      let read = false, said: boolean | undefined;
      try { read = !!text && JSON.parse(rec.request).messages.some((m: any) => String(m.content).includes(text)); } catch { /* bad bytes */ }
      try { said = JSON.parse(String(JSON.parse(rec.answer).choices[0].message.content).match(/\{[\s\S]*\}/)![0]).pass === true; } catch { /* bad bytes */ }
      out.push({ ok: rq === reqH && an === ansH, what: `${who} screen bytes`, detail: `sha256 of the published request is ${rq.slice(0, 12)}… and of the answer ${an.slice(0, 12)}…; the signed text has ${reqH?.slice(0, 12)}… and ${ansH?.slice(0, 12)}…`, tx: e.call.tx });
      out.push({ ok: read && said === took, what: `${who} verdict`, detail: `the request ${read ? 'holds the whole brief' : 'does not hold the brief'}, and the model answered ${said === undefined ? 'nothing readable' : said ? 'pass' : 'fail'}; the CFO ${took ? 'took' : 'declined'} it: "${e.data.note}"`, tx: e.call.tx });
    } else out.push({ ok: !took, what: `${who} screen`, detail: took ? 'taken with no TEE-signed model answer' : `declined before any model call: "${e.data.note}"`, tx: e.call.tx });
    if (!took) {
      const to = post?.data.customer, amt = String(e.data.refund);
      const moved = !!to && (e.call.transfers.some((t) => t.to === to && t.amount === BigInt(amt)) || e.call.events.some((x) => x.event === 'credit' && x.data.agent === to && x.data.amount === amt));
      out.push({ ok: moved, what: `${who} money back`, detail: moved ? `${units(amt)} went back to ${to}` : `no refund to ${to} in that transaction`, tx: e.call.tx });
    }
  }
  return out;
}

/**
 * From the block where the bank starts taking bonds (its `rules` event with bond_bps): every revealed bid locked
 * bond_bps of its price in the same transaction; a loser's bond came back at the award and the winner's when its
 * work passed, each exactly once and for the amount locked; failed work paid the bond to the job's customer in the
 * same transaction; and an enlisted agent the bank struck off had failed the number of times the rule says, with
 * what it held sent to its sponsor.
 */
function bondChecks(calls: Call[], raw: Raw): Check[] {
  const out: Check[] = [];
  let bps: bigint | undefined, maxFails = 0, reveals = 0, settled = 0, badLock: Call | undefined, badBack: Call | undefined;
  const open = new Map<string, bigint>(), winner = new Map<number, string>(), fails = new Map<string, number>();
  const sponsor = new Map(eventsOf(calls, 'enlist').map((e) => [e.data.agent as string, e.data.sponsor as string]));
  const customer = (lot: number) => raw.jobs.find((j) => j.id === raw.lots.find((l) => l.id === lot)?.job)?.customer;
  const paid = (c: Call, to: string, amt: string) => c.transfers.some((t) => t.to === to && t.amount === BigInt(amt)) || c.events.some((x) => x.event === 'credit' && x.data.agent === to && x.data.amount === amt);
  for (const c of calls) for (const e of c.events) {
    if (e.event === 'rules' && e.data.bond_bps !== undefined) { bps = BigInt(e.data.bond_bps); maxFails = Number(e.data.crew_max_fails); }
    if (e.event === 'fail' && 'Team' in e.data.seller) fails.set(e.data.seller.Team, (fails.get(e.data.seller.Team) ?? 0) + 1);
    if (bps === undefined) continue;
    const lot = Number(e.data.lot), key = `${lot}:${e.data.agent}`;
    if (e.event === 'reveal') {
      reveals++;
      const want = (BigInt(e.data.price) * bps) / 10_000n, b = c.events.find((x) => x.event === 'bond' && x.data.agent === e.data.agent && Number(x.data.lot) === lot);
      if (want > 0n ? !b || BigInt(b.data.amount) !== want : !!b) badLock ??= c;
    }
    if (e.event === 'bond') open.set(key, BigInt(e.data.amount));
    if (e.event === 'award') winner.set(lot, sellerOf(e.data.winner));
    if (e.event === 'bond_back') {
      const when = e.data.why === 'lost' ? winner.get(lot) !== e.data.agent && c.events.some((x) => x.event === 'award' && Number(x.data.lot) === lot)
        : e.data.why === 'passed' && c.events.some((x) => x.event === 'pass' && Number(x.data.lot) === lot && sellerOf(x.data.winner) === e.data.agent);
      if (open.get(key) !== BigInt(e.data.amount) || !when) badBack ??= c;
      open.delete(key); settled++;
    }
    if (e.event === 'slash') {
      const to = customer(lot), had = open.get(key);
      const ok = had === BigInt(e.data.amount) && e.data.to === to && c.events.some((x) => x.event === 'fail' && Number(x.data.lot) === lot) && paid(c, to!, String(e.data.amount));
      out.push({ ok, what: `Lot ${lot} bond slashed`, detail: ok ? `${e.data.agent}'s work failed inspection, so its ${units(e.data.amount)} bond went to the customer ${to}` : `the ${units(e.data.amount)} bond taken from ${e.data.agent} does not match what it locked, or did not reach the customer ${to}`, tx: c.tx });
      open.delete(key); settled++;
    }
    if (e.event === 'retire' && e.data.fails !== undefined) {
      const n = fails.get(e.data.agent) ?? 0, back = c.events.find((x) => x.event === 'cash_out' && x.data.agent === e.data.agent);
      const ok = n >= maxFails && Number(e.data.fails) === n && (!back || paid(c, sponsor.get(e.data.agent)!, String(back.data.amount)));
      out.push({ ok, what: `Crew ${String(e.data.agent).split('.')[0]} struck off`, detail: `its work had failed inspection ${n} times (the rule is ${maxFails}); ${back ? `the ${units(back.data.amount)} it held went to its sponsor ${sponsor.get(e.data.agent)}` : 'it held nothing'}`, tx: c.tx });
    }
  }
  if (bps === undefined) return out;
  out.unshift(
    { ok: !badLock, what: 'Bonds locked', detail: badLock ? 'a revealed bid locked the wrong bond, or none' : `each of ${reveals} bids revealed since bonds began locked ${Number(bps) / 100}% of its price from the bidder's balance`, tx: badLock?.tx },
    { ok: !badBack, what: 'Bonds returned', detail: badBack ? 'a bond came back at the wrong time or for the wrong amount' : `${settled} bonds settled, each once: losers' at the award, winners' when their work passed, failed work's to the customer; ${open.size} still on work in progress`, tx: badBack?.tx },
  );
  return out;
}

/** $0.004896 for 4896 units of 6-decimal USDC. */
export const units = (u: bigint | string | number) => {
  const n = Number(u) / 1e6;
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
};
