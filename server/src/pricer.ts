// How a team agent prices its sealed bid. Each agent asks its own model, inside NEAR AI Cloud's TEE, what to
// ask for the lot: it is told its cost (its expected model bill), the reserve, its record, its temperament, and
// how its last bids went (won or lost, at what price, what it was paid). It answers with a markup and a reason.
// The agent pays for that thinking from its own balance at the bank, win or lose (the call lands on the job's
// receipt and settle.ts bills it), and the answer is TEE-signed like any other model call.
//
// The answer is held to bounds the agent can't argue past: a markup of 5% to 80% over cost, and never above the
// reserve. Without a model key (demo mode) or when the call fails, the agent falls back to its fixed formula
// (auction.ts bidFor) and says so. The price stays sealed until reveal: the reason is only shown then.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANNED, DATA_DIR, DRY, MODEL } from './config.ts';
import { NEARAI, chatCost, nearaiKey } from './nearai.ts';
import { bidFor, r6 } from './auction.ts';
import { owe, type ReceiptLine } from './meter.ts';
import { teeSignature } from './tee.ts';
import type { Role } from './wallets.ts';

export const MARKUP_MIN = 5, MARKUP_MAX = 80; // percent over cost

export type Thought = { price?: number; markup: number; why: string; by: 'model' | 'formula'; line?: ReceiptLine };
type Past = { at: string; lot: string; cost: number; reserve: number; price: number; won: boolean; pay?: number; bidders?: number };

const TEMPER = [
  'cautious: you would rather earn a safe margin than gamble on a thin one, and you keep your bond small',
  'steady: you price for a fair margin and adjust slowly to how your recent bids went',
  'hungry: you want the work and its record more than the margin, and you will price close to cost to win',
] as const;
/** Fixed per agent, from its account name, so the same agent keeps the same character. */
export const temperOf = (account: string) => TEMPER[parseInt(createHash('sha256').update(`temper:${account}`).digest('hex').slice(0, 4), 16) % TEMPER.length];

const dir = () => join(DATA_DIR, 'bids');
const fileOf = (account: string) => join(dir(), `${account.replace(/[^a-z0-9._-]/g, '_')}.json`);
export function pastBids(account: string): Past[] {
  try { return existsSync(fileOf(account)) ? JSON.parse(readFileSync(fileOf(account), 'utf8')) : []; } catch { return []; }
}
/** The outcome of a revealed bid, kept so the agent's next price can learn from it. */
export function remember(account: string, p: Past) {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(fileOf(account), JSON.stringify([...pastBids(account), p].slice(-12), null, 1));
}

/** Clamp the model's markup to the bounds, then to the reserve. */
export function bounded(cost: number, reserve: number, markupPct: number): { price?: number; markup: number } {
  const markup = Math.min(MARKUP_MAX, Math.max(MARKUP_MIN, Math.round(Number.isFinite(markupPct) ? markupPct : MARKUP_MIN)));
  const price = r6(Math.max(0.001, cost * (1 + markup / 100)));
  return { price: price <= reserve ? price : undefined, markup };
}

/** Ask the agent's model for its price. */
export async function think(o: { account: string; name: string; role: Role; lot: number; title: string; cost: number; reserve: number; rep: number; round?: number; rivals: number }): Promise<Thought> {
  const fallback = (why: string): Thought => {
    const price = bidFor(o.account, o.cost, o.rep, o.reserve);
    return { price, markup: price ? Math.round((price / o.cost - 1) * 100) : 0, why, by: 'formula' };
  };
  if (DRY || CANNED || !nearaiKey()) return fallback('priced by its fixed formula (no model key on this server)');
  const past = pastBids(o.account).slice(-6);
  const history = past.length
    ? past.map((p) => `- ${p.lot}: cost ${p.cost}, reserve ${p.reserve}, you bid ${p.price}, ${p.won ? `WON, paid ${p.pay}` : 'lost'}${p.bidders ? ` (${p.bidders} bidders)` : ''}`).join('\n')
    : '- none yet: this is your first bid';
  const system =
    `You are ${o.name}, the ${o.role} agent at Parallax, an AI company on NEAR. Every part of a job is a lot won by sealed bid. ` +
    'The rules: the cheapest bid per unit of quality wins and is paid the runner-up\'s quality-adjusted price, never less than its own bid and never more than the reserve. ' +
    'If you win you pay your own model bill (the cost) from your balance, and revealing a bid locks a bond of 20% of your price, lost if your work fails inspection. ' +
    `Your temperament: ${temperOf(o.account)}. Answer with JSON only: {"markup_pct": <integer ${MARKUP_MIN}-${MARKUP_MAX}>, "why": "<one short sentence, first person>"}.`;
  const prompt =
    `Lot ${o.lot}: "${o.title}"${o.round && o.round > 1 ? `, round ${o.round} (the last winner failed)` : ''}. Your expected cost: ${o.cost} USDC. Reserve: ${o.reserve} USDC. ` +
    `Your record (reputation, 500 is a new agent): ${o.rep}. Other team agents who can bid on it: ${o.rivals}.\nYour recent bids:\n${history}\nWhat markup over your cost do you ask?`;
  const body = JSON.stringify({
    model: MODEL, max_tokens: 160, temperature: 0.6,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    ...(MODEL.startsWith('deepseek-ai/') ? { chat_template_kwargs: { thinking: false } } : {}),
  });
  try {
    const res = await fetch(`${NEARAI}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${nearaiKey()}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20_000),
    });
    const raw = await res.text();
    if (!res.ok) return fallback(`its model was busy (${res.status}), so it priced by its fixed formula`);
    const data = JSON.parse(raw);
    const text = String(data?.choices?.[0]?.message?.content ?? '');
    const m = text.match(/\{[\s\S]*\}/);
    const ans = m ? JSON.parse(m[0]) : {};
    const usd = Math.min(0.005, (await chatCost(MODEL, data?.usage)) ?? 0.0003);
    owe(o.account, usd);
    const tee = await teeSignature(String(data?.id ?? ''), MODEL, body, raw).catch(() => undefined);
    const line: ReceiptLine = {
      at: new Date().toISOString(), agent: o.role, vendor: 'NEAR AI Cloud', url: `${NEARAI}/chat/completions`,
      amount: String(Math.round(usd * 1e6)), usd, transaction: String(data?.id ?? 'call'),
      reason: `price its sealed bid for lot ${o.lot} (${o.title})`, status: res.status, dry: false, account: o.account, bid: true,
      ...(tee ? { tee } : {}),
    };
    const want = Number(ans.markup_pct);
    if (!Number.isFinite(want)) return { ...fallback('its model gave no markup, so it priced by its fixed formula'), line };
    const b = bounded(o.cost, o.reserve, want);
    const why = String(ans.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'no reason given';
    return { ...b, why: b.markup !== Math.round(want) ? `${why} (asked ${Math.round(want)}%, held to ${b.markup}%)` : why, by: 'model', line };
  } catch (e: any) {
    return fallback(`its model call failed (${String(e?.message ?? e).slice(0, 40)}), so it priced by its fixed formula`);
  }
}
