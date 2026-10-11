import OpenAI from 'openai';
import { wrapOpenAI } from 'neatlogs';
import { env, chaos } from './env.ts';
import { assertBudget, charge, say } from './context.ts';

const client = wrapOpenAI(new OpenAI({ apiKey: env.litellmKey || 'missing', baseURL: env.litellmBase, maxRetries: 2, timeout: 90_000 }));

/** USD per million tokens [input, output]. List prices for the gateway's models. */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku': [1, 5],
  'claude-sonnet-4.6': [3, 15],
  'claude-opus-4.6': [5, 25],
  'nova-micro': [0.035, 0.14],
  'nova-lite': [0.06, 0.24],
  'nova-pro': [0.8, 3.2],
  'nova-2-lite': [0.3, 2.5],
};

export function costOf(model: string, inTok: number, outTok: number) {
  const [i, o] = PRICES[model] ?? [3, 15];
  return (inTok * i + outTok * o) / 1e6;
}

export interface ChatOpts {
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export async function chat(o: ChatOpts): Promise<string> {
  assertBudget();
  const model = o.model ?? env.models.fast;
  const res = await client.chat.completions.create({
    model,
    max_tokens: o.maxTokens ?? 1500,
    temperature: o.temperature ?? 0.2,
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ],
  });
  const u = res.usage;
  charge({ usd: costOf(model, u?.prompt_tokens ?? 0, u?.completion_tokens ?? 0), llm: true });
  return res.choices[0]?.message?.content ?? '';
}

/**
 * Ask for JSON and check it. A reply that doesn't parse, or fails `check`, goes back to the model
 * with the exact problem, up to `repairs` times. Models drift; the shape must not.
 */
export async function json<T>(o: ChatOpts & { check?: (v: any) => string | null; repairs?: number }): Promise<T> {
  const repairs = o.repairs ?? 2;
  let user = o.user;
  let last = '';
  for (let attempt = 0; attempt <= repairs; attempt++) {
    let text = await chat({ ...o, user, system: o.system + '\n\nReply with one JSON value only. No prose, no code fences.' });
    if (chaos('llm-json') && attempt === 0) text = text.slice(0, Math.floor(text.length / 2)); // simulate a cut-off reply
    const parsed = parseLoose(text);
    const problem = parsed.ok ? (o.check?.(parsed.value) ?? null) : `not valid JSON (${parsed.error})`;
    if (!problem && parsed.ok) {
      if (attempt > 0) say(`repaired a bad model reply after ${attempt} ${attempt === 1 ? 'try' : 'tries'}`, 'recover');
      return parsed.value as T;
    }
    last = problem ?? '';
    say(`model reply rejected: ${problem}`, 'retry');
    user = `${o.user}\n\nYour previous reply was rejected: ${problem}.\nPrevious reply:\n${text.slice(0, 2000)}\n\nSend the corrected JSON only.`;
  }
  throw new Error(`model could not produce valid output: ${last}`);
}

function parseLoose(text: string): { ok: true; value: any } | { ok: false; error: string } {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.search(/[[{]/);
  if (start > 0) t = t.slice(start);
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    // A trailing sentence after the JSON is common; cut at the last closing bracket.
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (end > 0) {
      try {
        return { ok: true, value: JSON.parse(t.slice(0, end + 1)) };
      } catch {}
    }
    return { ok: false, error: (e as Error).message.slice(0, 80) };
  }
}
