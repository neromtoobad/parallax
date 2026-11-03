// NEAR AI Cloud: one OpenAI-compatible API for every model the team uses (Claude, GPT, Gemini, Qwen,
// FLUX). The key is the founder's (NEARAI_API_KEY, prepaid credits). Prices come from the public model
// list, so every call has a cost in USD that meter.ts books to the agent that made it.
export const NEARAI = process.env.NEARAI_URL ?? 'https://cloud-api.near.ai/v1';
export const NEARAI_HOST = new URL(NEARAI).host;
export const nearaiKey = () => process.env.NEARAI_API_KEY?.trim() || undefined;

type Price = { input: number; output: number; image: number }; // USD per token / per image
const prices = new Map<string, Price>();
let loadedAt = 0;

const usd = (c?: { amount: number; scale: number }) => (c ? c.amount / 10 ** c.scale : 0);

/** The public price list, refreshed hourly. */
export async function priceOf(model: string): Promise<Price | undefined> {
  if (Date.now() - loadedAt > 3600_000 || !prices.size) {
    try {
      const r = await fetch(`${NEARAI}/model/list`, { signal: AbortSignal.timeout(15_000) });
      const d: any = await r.json();
      for (const m of d.models ?? []) prices.set(m.modelId, { input: usd(m.inputCostPerToken), output: usd(m.outputCostPerToken), image: usd(m.costPerImage) });
      loadedAt = Date.now();
    } catch { /* keep the last list */ }
  }
  return prices.get(model);
}

/** What a chat completion cost, from the usage it reports. */
export async function chatCost(model: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): Promise<number | undefined> {
  const p = await priceOf(model);
  if (!p || !usage) return undefined;
  return (usage.prompt_tokens ?? 0) * p.input + (usage.completion_tokens ?? 0) * p.output;
}

export async function imageCost(model: string, n = 1): Promise<number | undefined> {
  const p = await priceOf(model);
  return p ? p.image * n : undefined;
}
