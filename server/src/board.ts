// The board: anyone puts a job on chain. The customer writes a brief, the server stores its exact text under
// its sha256, and the customer sends the budget to the bank with `post:{id, spec, days}` (or the house wallet
// posts it for a visitor with no wallet, from its balance). The bank holds the money in escrow under the
// customer's name.
//
// Every 30 seconds the CFO screens what is waiting: fixed checks on the brief, then a model in NEAR AI Cloud's TEE
// reads it and says whether the swarm can do it for that budget. A pass is filed with `take_job` and that answer's
// TEE signature, and the job goes to auction like any other (orders.ts). A fail is filed with `decline_job`, which
// sends the money back. Each screen's exact request and answer are kept, so /proof can check the signature.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR, DRY } from './config.ts';
import { Job } from './job.ts';
import { NEARAI_HOST } from './nearai.ts';
import { NEAR, ROOM_MIN, bankRoom, call, canSign, fromUnits, sha256, tg, toUnits, view } from './near/chain.ts';
import { getOrder, startBoardJob } from './orders.ts';
import { briefOf } from './services/check.ts';
import { fields } from './services/board.ts';
import { settleBills } from './settle.ts';
import { llmJson } from './tools.ts';

/** What the house wallet puts up for a visitor's post, at most, and the bank's own limits. */
export const HOUSE_MAX = 3;
export const LIMITS = { minUsd: 1, maxUsd: 25, minDays: 1, maxDays: 14, title: 100, brief: 2000 };

export type Post = { id: string; hash: string; title: string; brief: string; days: number; budgetUsd: number; at: string; parent?: string; by?: string };
export type Screen = {
  job: string; pass: boolean; note: string; flags: string[]; model?: string; request?: string; answer?: string;
  tee?: { text: string; signature: string; signer?: string }; bill?: string; tx: string; at: string;
};
type Posted = { id: string; customer: string; amount: string; spec_hash: string; fund_by: string; deliver_by: string };

const dir = (...p: string[]) => join(DATA_DIR, 'board', ...p);
const repo = (...p: string[]) => join(new URL('../../deployments/board', import.meta.url).pathname, ...p);
const read = (...p: string[]) => [dir(...p), repo(...p)].find(existsSync);

/** The brief's exact bytes, by the hash the bank holds (the board's copy first, then the repository's). */
export function briefFile(hash: string): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
  const f = read(`${hash}.txt`);
  return f ? readFileSync(f, 'utf8') : undefined;
}
export function postOf(id: string): Post | undefined {
  if (!/^[a-z0-9]{8,16}$/.test(id)) return undefined;
  const f = read('posts', `${id}.json`);
  return f ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
}
export function screenOf(id: string): Screen | undefined {
  if (!/^[a-z0-9]{8,16}$/.test(id)) return undefined;
  const f = read('screens', `${id}.json`);
  return f ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
}

/** Fixed checks before a model reads a brief. Links and the customer's own contact details are fine in a brief. */
export function briefFlags(text: string): string[] {
  const rules: [RegExp, string][] = [
    [/\b(ignore|disregard|forget|override)\b.{0,30}\b(instructions?|rules?|task|prompt|above|previous|system)\b/i, 'tries to override the agents\' instructions'],
    [/\b(system prompt|developer message|jailbreak|DAN mode)\b/i, 'talks about the model\'s own instructions'],
    [/\b(private key|seed phrase|mnemonic|api[ _-]?key|password|secret key|access key)\b/i, 'asks about keys or passwords'],
    [/<\s*script|javascript:|on(load|error|click)\s*=/i, 'carries script'],
  ];
  return rules.filter(([re]) => re.test(text)).map(([, why]) => why);
}

/** Check and store a brief; returns the post and the wallet call that puts it on the bank. */
export function draft(b: any): { post?: Post; problems: string[]; flags: string[]; wallet?: unknown } {
  const title = String(b?.title ?? '').replace(/\s+/g, ' ').trim(), brief = String(b?.brief ?? '').replace(/\r/g, '').trim();
  const budgetUsd = Math.round(Number(b?.budget) * 100) / 100, days = Math.round(Number(b?.days ?? 3));
  const problems: string[] = [];
  if (title.length < 4 || title.length > LIMITS.title) problems.push(`title: 4 to ${LIMITS.title} characters`);
  if (brief.length < 40 || brief.length > LIMITS.brief) problems.push(`brief: 40 to ${LIMITS.brief.toLocaleString('en')} characters`);
  if (!(budgetUsd >= LIMITS.minUsd && budgetUsd <= LIMITS.maxUsd)) problems.push(`budget: ${LIMITS.minUsd} to ${LIMITS.maxUsd} USDC`);
  if (!(days >= LIMITS.minDays && days <= LIMITS.maxDays)) problems.push(`days: ${LIMITS.minDays} to ${LIMITS.maxDays}`);
  if (problems.length) return { problems, flags: [] };
  const text = briefOf(fields, { title, brief }), hash = sha256(text);
  const post: Post = { id: randomBytes(5).toString('hex'), hash, title, brief, days, budgetUsd, at: new Date().toISOString() };
  mkdirSync(dir('posts'), { recursive: true });
  writeFileSync(dir(`${hash}.txt`), text);
  writeFileSync(dir('posts', `${post.id}.json`), JSON.stringify(post, null, 2));
  const wallet = NEAR && {
    receiverId: NEAR.usdc, method: 'ft_transfer_call', deposit: '1',
    args: { receiver_id: NEAR.bank, amount: toUnits(budgetUsd), msg: `post:${JSON.stringify({ id: post.id, spec: hash, days })}` },
  };
  return { post, problems, flags: briefFlags(text), wallet };
}

/** A sub-job an agent posts (subjobs.ts) goes on the board too, with its exact text under its hash. */
export function savePost(post: Post, text: string) {
  mkdirSync(dir('posts'), { recursive: true });
  writeFileSync(dir(`${post.hash}.txt`), text);
  writeFileSync(dir('posts', `${post.id}.json`), JSON.stringify(post, null, 2));
}

/** No wallet: the house wallet puts a visitor's post on the bank from its balance (small budgets only). */
export async function postForVisitor(id: string): Promise<string> {
  const p = postOf(id);
  if (!p) throw new Error('write the brief first');
  if (p.budgetUsd > HOUSE_MAX) throw new Error(`The house wallet posts jobs of up to ${HOUSE_MAX} USDC. Post a bigger one from your own wallet.`);
  const r = await call(NEAR!.house!, NEAR!.bank, 'post_job', { id: p.id, spec: p.hash, days: p.days, amount: toUnits(p.budgetUsd) }, { tgas: 30 });
  return r.hash;
}

/** What the board shows: each post the server knows, with where it stands on the bank and its screen. */
export async function boardView() {
  const ids = existsSync(dir('posts')) ? readdirSync(dir('posts')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  const posts = ids.map(postOf).filter(Boolean) as Post[];
  const rows = await Promise.all(posts.map(async (p) => {
    const j = DRY ? undefined : await view<Posted & { state: string }>(NEAR!.bank, 'get_job', { id: p.id }).catch(() => undefined);
    const o = getOrder(p.id), s = screenOf(p.id);
    return {
      id: p.id, title: p.title, brief: p.brief, hash: p.hash, days: p.days, budgetUsd: p.budgetUsd, at: p.at, parent: p.parent, by: p.by,
      onChain: !!j, state: j?.state ?? 'Draft', customer: j?.customer, order: o?.state,
      screen: s && { pass: s.pass, note: s.note, tx: s.tx, signer: s.tee?.signer },
    };
  }));
  return rows.filter((r) => r.onChain).sort((a, b) => b.at.localeCompare(a.at));
}

const SYSTEM = `You screen jobs that people post on the board at Parallax, a company of AI agents. A posted job is a
brief and a budget in USDC held in escrow. If you pass it, the agents bid for its parts and do it: research from what
they know (and a web search when they have one), then a written document in Markdown, such as a report, a plan, a
market scan, a guide, copy, an outline or a summary, checked against the brief.

They cannot run code, log in anywhere, contact or message anyone, buy things, make pictures for board jobs, or act in
the world. Fail a brief that needs any of that, and fail one that is illegal or harmful, harasses someone, asks for
personal information about private people, is for deception (fake reviews, spam, phishing, impersonation), is sexual,
or is plainly too big for its budget (a page of research and writing is fine at 1 USDC; a 30-page report is not).
Pass everything else, including odd or very small jobs: the customer decides what is worth their money.

Reply with JSON {"pass": boolean, "note": "one sentence to the customer", "reasons": ["short", "..."]}.`;

/** The CFO's round on the board: screen every post waiting on the bank, and take or decline it. */
export async function screenPosted() {
  if (DRY || !NEAR?.house || !canSign(NEAR.cfo)) return;
  const waiting = await view<Posted[]>(NEAR.bank, 'list_posted').catch(() => []);
  for (const j of waiting) {
    if (screenOf(j.id)?.tx || Date.now() * 1e6 > Number(j.fund_by)) continue;
    try { await screen(j); } catch (e: any) { console.log(`board: screen of ${j.id} waits:`, String(e?.message ?? e).slice(0, 140)); }
  }
}

async function screen(j: Posted) {
  // with no room left on chain a taken job would fail at its auction; it waits as Posted, money untouched
  if ((await bankRoom()) < ROOM_MIN) return console.warn(`board: ${j.id} waits: the bank is out of storage room`);
  const text = briefFile(j.spec_hash), p = postOf(j.id);
  let pass = false, note = '', flags: string[] = [], request: string | undefined, answer: string | undefined, bill: string | undefined;
  let tee: Screen['tee'];
  if (!text || !p) note = 'The brief behind this post is not on this server, so nobody can read what it asks for.';
  else if ((flags = briefFlags(text)).length) note = `The brief failed the fixed checks: ${flags.join('; ')}.`;
  else {
    // the house wallet pays for screening, out of the company's float
    const job = new Job(`board-${j.id}`, 'board screen', { budgetUsd: 0.05, allowHosts: [NEARAI_HOST] }, { auditor: { role: 'auditor', account: NEAR!.house! } });
    const v = await llmJson<{ pass: boolean; note: string; reasons?: string[] }>(job, 'auditor', {
      system: SYSTEM,
      prompt: `Budget: ${fromUnits(j.amount)} USDC. Days to deliver: ${p.days}.\nThe brief, exactly as the customer wrote it:\n${text}`,
      reason: `screen board job ${j.id}`, maxTokens: 300, dry: () => '{"pass":true,"note":"demo"}',
      keep: (req, ans) => { request = req; answer = ans; },
    });
    pass = v.pass === true;
    note = String(v.note ?? '').slice(0, 280) || (pass ? 'Taken.' : 'Declined.');
    flags = (v.reasons ?? []).map(String).slice(0, 5);
    tee = job.receipt.find((r) => r.tee)?.tee;
    bill = (await settleBills(job))[0]?.tx;
  }
  const sigs = tee ? [{ text: tee.text, signature: tee.signature }] : [];
  const r = pass
    ? await call(NEAR!.cfo, NEAR!.bank, 'take_job', { id: j.id, note, tee: sigs }, { tgas: tg(30, 60) })
    : await call(NEAR!.cfo, NEAR!.bank, 'decline_job', { id: j.id, note, tee: sigs }, { tgas: tg(30, 60) });
  const rec: Screen = { job: j.id, pass, note, flags, model: tee?.text.split(':')[0], request, answer, tee, bill, tx: r.hash, at: new Date().toISOString() };
  mkdirSync(dir('screens'), { recursive: true });
  writeFileSync(dir('screens', `${j.id}.json`), JSON.stringify(rec, null, 2));
  console.log(`board: ${j.id} ${pass ? 'taken' : 'declined'}: ${note}`);
  if (pass && p && text) startBoardJob({ id: j.id, title: p.title, brief: p.brief, text, budgetUsd: Number(fromUnits(j.amount)), customer: j.customer, takeTx: r.hash });
}
