import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export const env = {
  root,
  dataDir: process.env.PARALLAX_DATA ?? join(root, 'data'),
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 8787),

  litellmKey: process.env.LITELLM_API_KEY ?? '',
  litellmBase: process.env.LITELLM_BASE_URL ?? 'https://litellm.vision.aivar.app/v1',
  neatlogsKey: process.env.NEATLOGS_API_KEY ?? '',
  crustKey: process.env.CRUSTDATA_API_KEY ?? '',

  /** Dollar value of one Crustdata credit, for the books. Self-serve list price is about a cent. */
  usdPerCredit: Number(process.env.CRUSTDATA_USD_PER_CREDIT ?? 0.01),

  /** Models by job: cheap and fast for extraction, stronger for judgement. */
  models: {
    fast: process.env.MODEL_FAST ?? 'claude-haiku',
    smart: process.env.MODEL_SMART ?? 'claude-sonnet-4.6',
  },

  /** Fault injection for recovery demos: "crust:0.3,llm-json:0.2" fails that share of calls. */
  chaos: parseChaos(process.env.PARALLAX_CHAOS ?? ''),
};

function parseChaos(spec: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split(':');
    out[k] = Math.max(0, Math.min(1, Number(v ?? 1)));
  }
  return out;
}

export function chaos(kind: string): boolean {
  const p = env.chaos[kind];
  return p ? Math.random() < p : false;
}
