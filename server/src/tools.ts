// What an agent can use while it works. Model and picture calls go through meter.buy, so every one is
// checked against the job's budget and allowlist and lands on the receipt, paid from the agent's balance
// at the bank. Chat answers and pictures come with NEAR AI Cloud's TEE signature (tee.ts).
// Map lookups (OpenStreetMap) and page reads are free and need no receipt.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, IMAGE_MODEL, MODEL } from './config.ts';
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
      // The TEE DeepSeek thinks first by default, and the thinking can use up max_tokens before any answer.
      ...(MODEL.startsWith('deepseek-ai/') ? { chat_template_kwargs: { thinking: false } } : {}),
    },
    // A rough ceiling from the list price, so a runaway call can't empty the budget.
    maxUsd: 0.02 + maxTokens * 2e-6, expectUsd: 0.002 + maxTokens * 6e-7,
    dryData: () => ({ choices: [{ message: { content: o.dry() } }] }),
    cost: (d) => chatCost(MODEL, d?.usage),
    tee: MODEL,
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
    tee: IMAGE_MODEL,
  });
  const d = data?.data?.[0];
  if (d?.b64_json) return `data:image/png;base64,${d.b64_json}`;
  if (d?.url) return d.url;
  throw new Error(`${agent}: no picture came back`);
}

// ---------------------------------------------------------------- free lookups

const UA = { 'user-agent': 'Parallax/1.0 (hackathon demo; github.com/neromtoobad)' };

export type Place = { name: string; kind: string; address: string; website?: string; phone?: string; email?: string; lat: number; lon: number; osm: string };

/** Businesses of a kind around a city's centre, from OpenStreetMap. `tags` are OSM key=value pairs (shop=bakery). */
export async function places(city: string, tags: string[], n = 25): Promise<Place[]> {
  // The same search within a week is read from disk: the map changes slowly and the public servers are busy.
  const key = createHash('sha256').update(`${city.toLowerCase().trim()}|${[...tags].sort().join(',')}`).digest('hex').slice(0, 16);
  const file = join(DATA_DIR, 'places', `${key}.json`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 7 * 86400_000) return (JSON.parse(readFileSync(file, 'utf8')) as Place[]).slice(0, n);
  const geo: any[] = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(city)}`, { headers: UA, signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  if (!geo.length) throw new Error(`couldn't find ${city} on the map`);
  const at = `${geo[0].lat},${geo[0].lon}`;
  const parts = tags.map((t) => { const [k, v] = t.split('='); return `nwr["${k}"${v ? `="${v}"` : ''}]["name"](around:5000,${at});`; }).join('');
  const d: any = await overpass(`[out:json][timeout:20];(${parts});out center 150;`).catch(() => null);
  const out: Place[] = d ? fromOverpass(d, tags) : await fromNominatim(city, tags);
  // Ones you can reach first, then ones with a website.
  const score = (p: Place) => (p.email ? 2 : 0) + (p.phone ? 1 : 0) + (p.website ? 1 : 0) + (p.address ? 0.5 : 0);
  const ranked = out.filter((p) => p.name).sort((a, b) => score(b) - score(a)).slice(0, 60);
  if (ranked.length) { mkdirSync(join(DATA_DIR, 'places'), { recursive: true }); writeFileSync(file, JSON.stringify(ranked)); }
  return ranked.slice(0, n);
}

const fromOverpass = (d: any, tags: string[]): Place[] =>
  (d.elements ?? []).map((x: any) => {
    const t = x.tags ?? {};
    return {
      name: t.name, kind: tags.map((g) => t[g.split('=')[0]]).find(Boolean) ?? '',
      address: [t['addr:housenumber'], t['addr:street'], t['addr:city'] ?? t['addr:suburb']].filter(Boolean).join(' '),
      website: t.website ?? t['contact:website'], phone: t.phone ?? t['contact:phone'], email: t.email ?? t['contact:email'],
      lat: x.lat ?? x.center?.lat, lon: x.lon ?? x.center?.lon, osm: `https://www.openstreetmap.org/${x.type}/${x.id}`,
    };
  });

/** When the Overpass servers are busy: OpenStreetMap's own search, one request per tag, a second apart. */
async function fromNominatim(city: string, tags: string[]): Promise<Place[]> {
  const out: Place[] = [];
  for (const t of tags) {
    const what = (t.split('=')[1] ?? t).replace(/_/g, ' ');
    const r: any[] = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=40&extratags=1&addressdetails=1&q=${encodeURIComponent(`${what} in ${city}`)}`, { headers: UA, signal: AbortSignal.timeout(20_000) }).then((x) => x.json()).catch(() => []);
    for (const x of r) {
      const e = x.extratags ?? {}, a = x.address ?? {};
      out.push({
        name: x.name || x.display_name.split(',')[0], kind: x.type, address: [a.house_number, a.road, a.city ?? a.town ?? a.suburb].filter(Boolean).join(' '),
        website: e.website ?? e['contact:website'], phone: e.phone ?? e['contact:phone'], email: e.email ?? e['contact:email'],
        lat: Number(x.lat), lon: Number(x.lon), osm: `https://www.openstreetmap.org/${x.osm_type}/${x.osm_id}`,
      });
    }
    await new Promise((res) => setTimeout(res, 1100));
  }
  return out;
}

// Public Overpass servers are busy at times: try the next one, then fall back to Nominatim (places()).
const OVERPASS = (process.env.OVERPASS_URLS ?? 'https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter').split(',');
async function overpass(q: string) {
  let last: unknown;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: UA, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(12_000) });
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
