// What an agent can use while it works. Model and picture calls go through meter.buy, so every one is
// checked against the job's budget and allowlist and lands on the receipt, paid from the agent's account.
// Map lookups (OpenStreetMap) and page reads are free and need no receipt.
import { DRY, IMAGE_MODEL, MODEL } from './config.ts';
import type { Job } from './job.ts';
import { buy } from './meter.ts';
import { NEARAI, chatCost, imageCost } from './nearai.ts';
import { notesFor } from './notes.ts';
import type { Role } from './wallets.ts';

export type SearchHit = { title: string; link: string; snippet: string };
type Search = (job: Job, agent: Role, q: string, reason: string, n: number) => Promise<SearchHit[]>;

let searcher: Search | undefined;
/** Plug in a web search (market.ts registers one that hires an Agent Market agent per query). */
export const useSearch = (s: Search) => void (searcher = s);
export const canSearch = () => !!searcher;
export async function search(job: Job, agent: Role, q: string, reason: string, n = 6): Promise<SearchHit[]> {
  if (!searcher) return [];
  job.log(agent, 'search', q);
  return searcher(job, agent, q, reason, n).catch((e) => (job.log(agent, 'note', `search failed: ${String(e?.message ?? e).slice(0, 80)}`), []));
}

/** Ask the model. `dry` is the canned answer in demo mode. */
export async function llm(job: Job, agent: Role, o: { system: string; prompt: string; reason: string; dry: () => string; maxTokens?: number; json?: boolean }): Promise<string> {
  const notes = notesFor(job.orderId);
  const system = notes && notes.roles.includes(job.who(agent))
    ? `${o.system}\n\nResearch notes bought for this job from ${notes.handle} on the NEAR Agent Market (use what is useful, verify what you rely on):\n${notes.text.slice(0, 6000)}`
    : o.system;
  const maxTokens = o.maxTokens ?? 1200;
  const data = await buy<any>(job, {
    agent, vendor: 'NEAR AI Cloud', url: `${NEARAI}/chat/completions`, reason: o.reason,
    body: {
      model: MODEL, max_tokens: maxTokens, temperature: 0.7,
      messages: [{ role: 'system', content: system }, { role: 'user', content: o.prompt }],
      ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    },
    // A rough ceiling from the list price, so a runaway call can't empty the budget.
    maxUsd: 0.02 + maxTokens * 2e-6, expectUsd: 0.002 + maxTokens * 6e-7,
    dryData: () => ({ choices: [{ message: { content: o.dry() } }] }),
    cost: (d) => chatCost(MODEL, d?.usage),
  });
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

/** The model's answer as JSON (it is asked for an object; fences and chatter around it are dropped). */
export async function llmJson<T>(job: Job, agent: Role, o: Parameters<typeof llm>[2]): Promise<T> {
  const text = await llm(job, agent, { ...o, json: true });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${agent}: the model returned no JSON`);
  return JSON.parse(m[0]) as T;
}

/** One picture, as a PNG data URL. `dry` is an SVG placeholder in demo mode. */
export async function picture(job: Job, agent: Role, o: { prompt: string; reason: string; size?: string; dry: () => string }): Promise<string> {
  const data = await buy<any>(job, {
    agent, vendor: 'NEAR AI Cloud', url: `${NEARAI}/images/generations`, reason: o.reason,
    body: { model: IMAGE_MODEL, prompt: o.prompt, n: 1, size: o.size ?? '1024x1024', response_format: 'b64_json' },
    maxUsd: 0.05, expectUsd: 0.012,
    dryData: () => ({ data: [{ url: o.dry() }] }),
    cost: () => imageCost(IMAGE_MODEL, 1),
  });
  const d = data?.data?.[0];
  if (d?.b64_json) return `data:image/png;base64,${d.b64_json}`;
  if (d?.url) return d.url;
  throw new Error(`${agent}: no picture came back`);
}

// ---------------------------------------------------------------- free lookups

const UA = { 'user-agent': 'Parallax/1.0 (hackathon demo; github.com/neromtoobad)' };

export type Place = { name: string; kind: string; address: string; website?: string; phone?: string; email?: string; lat: number; lon: number; osm: string };

/** Businesses of a kind around a city, from OpenStreetMap. `tags` are OSM key=value pairs (shop=bakery). */
export async function places(city: string, tags: string[], n = 25, fixture?: () => Place[]): Promise<Place[]> {
  if (DRY && fixture) return fixture();
  const geo: any[] = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(city)}`, { headers: UA, signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  if (!geo.length) throw new Error(`couldn't find ${city} on the map`);
  const [s, nn, w, e] = geo[0].boundingbox.map(Number); // south, north, west, east
  const bbox = `${s},${w},${nn},${e}`;
  const parts = tags.map((t) => { const [k, v] = t.split('='); return `nwr["${k}"${v ? `="${v}"` : ''}]["name"](${bbox});`; }).join('');
  const q = `[out:json][timeout:25];(${parts});out center ${Math.max(n * 3, 60)};`;
  const d: any = await overpass(q);
  const out: Place[] = (d.elements ?? []).map((x: any) => {
    const t = x.tags ?? {};
    return {
      name: t.name, kind: tags.map((g) => t[g.split('=')[0]]).find(Boolean) ?? '',
      address: [t['addr:housenumber'], t['addr:street'], t['addr:city'] ?? t['addr:suburb']].filter(Boolean).join(' '),
      website: t.website ?? t['contact:website'], phone: t.phone ?? t['contact:phone'], email: t.email ?? t['contact:email'],
      lat: x.lat ?? x.center?.lat, lon: x.lon ?? x.center?.lon, osm: `https://www.openstreetmap.org/${x.type}/${x.id}`,
    };
  });
  // Ones you can reach first, then ones with a website.
  const score = (p: Place) => (p.email ? 2 : 0) + (p.phone ? 1 : 0) + (p.website ? 1 : 0) + (p.address ? 0.5 : 0);
  return out.filter((p) => p.name).sort((a, b) => score(b) - score(a)).slice(0, n);
}

// Public Overpass servers are busy at times; try the next one.
const OVERPASS = (process.env.OVERPASS_URLS ?? 'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter').split(',');
async function overpass(q: string) {
  let last: unknown;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: UA, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(40_000) });
      if (r.ok) return await r.json();
      last = new Error(`map server ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}

/** A page's readable text (scripts, styles and tags dropped), cut to `max` characters. */
export async function readPage(url: string, max = 8000): Promise<string> {
  const html = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15_000) }).then((r) => r.text());
  return html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, max);
}
