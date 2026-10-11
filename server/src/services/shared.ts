import { resolve4, resolve6 } from 'node:dns/promises';
import { BudgetExceeded, say } from '../context.ts';
import { companiesByDomain, companyEnrich, companySearch, COMPANY_FIELDS, FUNDING_FIELDS, webSearch, type WebResult } from '../crust.ts';
import { json } from '../llm.ts';

/** Helpers shared by the services: company lookups, screening, people on the web, writer audits. */

export function clean(d: unknown): string | null {
  if (!d || typeof d !== 'string') return null;
  return d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim() || null;
}

/** "linear.app" or "https://linear.app/x" is a domain; "Linear" is a name. */
export const looksLikeDomain = (s: string) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(s.trim()) && !/\s/.test(s.trim());

export function pick(o: any, path: string) {
  return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o) ?? null;
}

export function place(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return [v.city, v.state, v.country].filter(Boolean).join(', ') || v.raw || null;
}

export function personOf(p: any) {
  const cur = p.experience?.employment_details?.current?.[0] ?? {};
  return {
    name: p.basic_profile?.name ?? '',
    title: cur.title ?? p.basic_profile?.headline ?? '',
    company: cur.name ?? cur.company_name ?? '',
    since: cur.start_date ?? null,
    seniority: cur.seniority_level ?? null,
    profileUrl: p.social_handles?.professional_network_identifier?.profile_url ?? null,
  };
}

/** One spelling per page: no scheme differences, no www, no trailing slash, no tracking params. */
export function canon(url: string) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^ref$|^src$/.test(k)) u.searchParams.delete(k);
    return `https://${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url;
  }
}

export function dedupe(results: WebResult[]) {
  const seen = new Set<string>();
  return results.filter((r) => r?.url && !seen.has(r.url) && seen.add(r.url));
}

export const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the domain resolve at all? Dead companies' domains often don't. */
export async function resolves(domain: string) {
  const t = new Promise<boolean>((r) => setTimeout(() => r(true), 4000)); // slow DNS: give it the benefit of the doubt
  const look = Promise.any([resolve4(domain), resolve4(`www.${domain}`), resolve6(domain)]).then(
    () => true,
    () => false,
  );
  return Promise.race([look, t]);
}

/** A strict DNS answer for trust checks: a timeout is "unknown", not a pass. */
export async function dnsState(domain: string): Promise<'ok' | 'none' | 'unknown'> {
  const t = new Promise<'unknown'>((r) => setTimeout(() => r('unknown'), 5000));
  const look = Promise.any([resolve4(domain), resolve4(`www.${domain}`), resolve6(domain)]).then(
    () => 'ok' as const,
    () => 'none' as const,
  );
  return Promise.race([look, t]);
}

const FILLER = new Set(['of', 'and', 'the', '&', 'for', 'at']);
export const toks = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w));

/** Position of the first wanted title whose every word is a whole word in this title ("CTO" no longer matches "Director"). */
export function rank(title: string, order: string[]) {
  const t = new Set(toks(title));
  const i = order.findIndex((o) => {
    const w = toks(o);
    return w.length > 0 && w.every((x) => t.has(x) || (x === 'founder' && t.has('cofounder')));
  });
  return i < 0 ? 99 : i;
}

/** 0 = C-level/founder, 1 = VP/head, 2 = director, 3 = manager/lead, 4 = everyone else. */
export function seniority(title: string, level?: string | null) {
  const t = title.toLowerCase();
  if (/\b(chief|ceo|cto|cfo|coo|cio|cmo|cpo|chro|cro|ciso|founder|co-?founder|president|managing director|owner|partner)\b/.test(t) || level === 'CXO' || level === 'Owner / Partner') return 0;
  if (/\b(vp|vice president|head|svp|evp|gm|general manager)\b/.test(t) || level === 'Vice President') return 1;
  if (/\bdirector\b/.test(t) || level === 'Director') return 2;
  if (/\b(manager|lead|principal)\b/.test(t) || level === 'Experienced Manager') return 3;
  return 4;
}

export const SENIOR_LEVELS = ['CXO', 'Vice President', 'Director', 'Owner / Partner'];
export const FUNCTIONS = ['Engineering', 'Sales', 'Consulting', 'Marketing', 'Operations', 'Finance', 'Research', 'Customer Success and Support', 'Arts and Design', 'Human Resources', 'Legal', 'Product Management'];

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]) {
  return [header, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

// ---- Companies --------------------------------------------------------------------------------

export interface CompanyRow {
  name: string;
  domain: string;
  description: string;
  headcount: number | null;
  country: string | null;
  founded: number | null;
  hq: string | null;
  fundingUsd: number | null;
  lastRound: string | null;
}

export const RICH_FIELDS = [...COMPANY_FIELDS, ...FUNDING_FIELDS];

/** A company-search hit in the shape the services use. */
export function companyRow(c: any): CompanyRow {
  const round = pick(c, 'funding.last_round_type');
  const date = pick(c, 'funding.last_fundraise_date');
  return {
    name: pick(c, 'basic_info.name') ?? '',
    domain: clean(pick(c, 'basic_info.primary_domain')) ?? clean(pick(c, 'basic_info.website')) ?? '',
    description: pick(c, 'basic_info.description') ?? '',
    headcount: pick(c, 'headcount.total') ?? pick(c, 'headcount.latest_count'),
    country: pick(c, 'locations.country'),
    founded: pick(c, 'basic_info.year_founded'),
    hq: place(pick(c, 'locations.headquarters') ?? pick(c, 'locations.hq_location')),
    fundingUsd: pick(c, 'funding.total_investment_usd'),
    lastRound: round ? [String(round).replace(/_/g, ' '), date ? String(date).slice(0, 10) : null].filter(Boolean).join(', ') : null,
  };
}

/**
 * Pin down which company the client means. A wrong match poisons everything after it, so an exact
 * domain wins, then a model picks from the database hits with the brief in hand.
 */
export async function resolveCompany(name: string, domain: string | null, brief: string): Promise<CompanyRow> {
  const d = clean(domain);
  const hits = await companySearch({ query: d ? `${name} ${d}` : name, limit: 5, fields: RICH_FIELDS });
  const list = (hits.companies ?? []).map(companyRow);
  const exact = d && list.find((c) => c.domain === d);
  if (exact) return exact;
  if (d) {
    const row = await byDomain(d);
    if (row) say(`Found ${row.name} by its domain`);
    return row ?? { name, domain: d, description: '', headcount: null, country: null, founded: null, hq: null, fundingUsd: null, lastRound: null };
  }
  const choice = list.length
    ? await json<{ index: number; reason: string }>({
        system: 'Pick the company the client means. If none fit, return index -1.',
        user: `Client brief: ${brief}\nCandidates:\n${list.map((c, i) => `${i}. ${c.name} (${c.domain}) ${c.headcount ?? '?'} staff: ${c.description.slice(0, 160)}`).join('\n')}\n\nReturn {"index": number, "reason": string}`,
        check: (v) => (typeof v?.index !== 'number' ? 'index must be a number' : null),
      })
    : { index: -1, reason: 'no database hits' };
  if (choice.index >= 0 && list[choice.index]) {
    say(`Matched ${list[choice.index].name} (${list[choice.index].domain}): ${choice.reason}`);
    return list[choice.index];
  }
  // Short or common names ("Linear") drown in lookalikes. Ask the web for the official site, then look that domain up.
  say(`The database has no clear match for "${name}"; asking the web for its official site`, 'recover');
  const web = await webSearch(`${name} official website`).catch(() => [] as WebResult[]);
  const brand = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const site = web.map((r) => clean(r.url)).find((h) => h && !SOCIAL.test(h) && h.replace(/[^a-z0-9]/g, '').includes(brand.slice(0, 12)));
  if (!site) throw new Error(`could not tell which "${name}" the client means`);
  const hit = await byDomain(site);
  say(`The web points to ${site}${hit ? `; matched ${hit.name} in the database` : ''}`);
  return hit ?? { name, domain: site, description: '', headcount: null, country: null, founded: null, hq: null, fundingUsd: null, lastRound: null };
}

/**
 * The search ranks by words, so a known domain can miss. Look it up exactly (several records can
 * share a domain: keep the biggest), then fall back to enrich, which costs more.
 */
async function byDomain(d: string): Promise<CompanyRow | null> {
  const rows = ((await companiesByDomain([d], RICH_FIELDS)).companies ?? []).map(companyRow).filter((c) => c.domain === d);
  const best = rows.sort((a, b) => (b.headcount ?? 0) - (a.headcount ?? 0))[0];
  if (best) return best;
  const e = await companyEnrich(d).catch((err) => (err instanceof BudgetExceeded ? Promise.reject(err) : null));
  return e ? { ...companyRow(e), domain: d } : null;
}

const SOCIAL = /linkedin\.com|facebook\.com|instagram\.com|(^|\.)x\.com|twitter\.com|youtube\.com|wikipedia\.org|crunchbase\.com|tiktok\.com|github\.com/i;

/**
 * Screen database hits against a profile with one cheap model call, then drop dead domains (a DNS
 * lookup is free; a page fetch isn't). Credits then go only on companies worth checking.
 */
export async function screen<T extends { name: string; domain: string; description: string; headcount: number | null; country: string | null }>(
  profile: string,
  fresh: T[],
  range: { min: number | null; max: number | null } = { min: null, max: null },
  rules = "Keep only clear fits, best first. Drop agencies, consultancies, law firms, foundations, accelerators, freelancers and companies whose description doesn't show the fit. A company that IS the kind of company described is a fit; don't require it to sell to that kind of company unless the profile says so.",
): Promise<(T & { why: string })[]> {
  const inRange = fresh.filter((c) => c.headcount == null || ((range.min == null || c.headcount >= range.min * 0.8) && (range.max == null || c.headcount <= range.max * 1.25)));
  if (inRange.length < fresh.length) say(`${fresh.length - inRange.length} companies outside the ${range.min ?? 0}-${range.max ?? '∞'} employee range`, 'step');
  if (!inRange.length) return [];
  const r = await json<{ keep: { i: number; why: string }[] }>({
    system: `Screen companies for a client using their database descriptions. ${rules}`,
    user: `Profile: ${profile}\nCandidates:\n${inRange.map((c, i) => `${i}. ${c.name} (${c.domain}), ${c.headcount ?? '?'} staff, ${c.country ?? '?'}: ${(c.description ?? '').slice(0, 220)}`).join('\n')}\n\nReturn {"keep": [{"i": number, "why": string}]}`,
    check: (v) => (!Array.isArray(v?.keep) ? 'keep must be an array' : null),
  });
  const kept = r.keep.filter((k) => inRange[k.i]).map((k) => ({ ...inRange[k.i], why: k.why }));
  const unique = kept.filter((c, i) => kept.findIndex((x) => x.domain === c.domain) === i);
  const alive = await Promise.all(unique.map((c) => resolves(c.domain)));
  const live = unique.filter((_, i) => alive[i]);
  say(`Screened ${inRange.length} candidates on their database profiles; ${unique.length} worth checking${live.length < unique.length ? `, ${unique.length - live.length} with dead domains skipped` : ''}`, 'step');
  return live;
}

// ---- People on the open web -------------------------------------------------------------------

export interface WebPresence {
  hits: WebResult[];
  mentions: WebResult[];
  left: WebResult | null;
}

/** Search "Name" Company; a hit counts when it names the surname and the company, and a "former/left" line flags a leaver. */
export async function personOnWeb(name: string, company: string, prefetched?: WebResult[]): Promise<WebPresence> {
  const hits = prefetched ?? (await webSearch(`"${name}" ${company}`).catch(() => [] as WebResult[]));
  const last = name.split(/\s+/).pop()!.toLowerCase();
  const brand = company.toLowerCase().split(/\s+/)[0];
  const mentions = hits.filter((h) => `${h.title} ${h.snippet}`.toLowerCase().includes(last) && `${h.title} ${h.snippet} ${h.url}`.toLowerCase().includes(brand));
  // Posts and lists name several people; "ex-Paystack" must sit in the same piece of text as this person.
  const left = mentions.find((h) => `${h.title} | ${h.snippet}`.split(/\s(?:\.\.\.|…)\s|[|·•\n]/).some((seg) => seg.toLowerCase().includes(last) && leftSignal(seg, brand))) ?? null;
  return { hits, mentions, left };
}

/**
 * "former COO of Paystack", "ex-Paystack", "left Paystack", "Paystack alum". Profile snippets list
 * several jobs separated by "|" or "·", so a "Former ..." in the next job must not count.
 */
export function leftSignal(text: string, brand: string) {
  const b = escape(brand);
  return new RegExp(`\\b(former(ly)?|ex-|previously|left|departed|stepped down)[^.,;|·•\\n]{0,30}\\b${b}\\b|\\b${b}\\s+(alum|alumni|alumnus)\\b`, 'i').test(text);
}

/**
 * Models join two bits of a page with "..." when quoting. Accept that only if every bit is on the page
 * on its own; a short connective fragment can't carry a claim, so it must not be the only real bit.
 */
export function quotedOnPage(quote: string, page: string, onPage: (q: string, p: string) => boolean) {
  const parts = quote.split(/\s*(?:\.\.\.|…)\s*/).map((x) => x.trim()).filter((x) => x.length >= 8);
  if (parts.length <= 1) return onPage(quote.replace(/\s*(?:\.\.\.|…)\s*/g, ' '), page) || (parts.length === 1 && onPage(parts[0], page));
  return parts.every((x) => onPage(x, page));
}

// ---- Writer audit -----------------------------------------------------------------------------

export const HEDGES = /\b(likely|probably|possibly|perhaps|may|might|could|suggests?|suggesting|presumably|appears to|seems?|will resonate|potentially)\b/i;

/**
 * Plain-code audit of a draft: every point cites known keys, makes no guesses, and every number in
 * it appears in what it cites. `values` maps each citable key to the text it stands for.
 */
export function auditPoints(points: { text: string; cites: string[] }[], values: Record<string, string>) {
  const issues: string[] = [];
  points.forEach((p, i) => {
    const hedges = p.text.match(HEDGES);
    if (hedges) issues.push(`point ${i + 1}: guesses ("${hedges[0]}"); state the fact and a concrete action instead`);
    const cited = p.cites ?? [];
    const missing = cited.filter((c) => !(c in values));
    if (!cited.length) issues.push(`point ${i + 1}: cites nothing`);
    if (missing.length) issues.push(`point ${i + 1}: cites unknown or unverified facts ${missing.join(', ')}`);
    const allowed = cited.map((c) => values[c] ?? '').join(' ').toLowerCase();
    for (const m of p.text.matchAll(/\$?\d[\d,.]*\s*(?:billion|million|bn|m|k|%)?/gi)) {
      const raw = m[0].trim();
      const digits = raw.replace(/[^\d.]/g, '').replace(/\.$/, '');
      if (!digits || digits.length < 2) continue;
      const n = parseFloat(digits);
      const close = [...allowed.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)].some((x) => {
        const v = parseFloat(x[0]);
        return v === n || (v > 0 && Math.abs(v - n) / v < 0.02) || [1e3, 1e6, 1e9].some((k) => Math.abs(v - n * k) / (n * k) < 0.06);
      });
      if (!close) issues.push(`point ${i + 1}: the number "${raw}" isn't in the cited facts`);
    }
  });
  return issues;
}

/** Draft, audit, redraft (up to 3 rounds); a point that still fails on the last round is cut. */
export async function writeAudited(o: { model?: string; system: string; user: string; values: Record<string, string> }) {
  let problems = '';
  for (let round = 0; round < 3; round++) {
    const draft = await json<{ points: { text: string; cites: string[] }[] }>({
      model: o.model,
      maxTokens: 1500,
      system: o.system,
      user: `${o.user}${problems ? `\n\nYour last draft was rejected:\n${problems}` : ''}\n\nReturn {"points": [{"text", "cites": [keys]}]}`,
      check: (v) => (!Array.isArray(v?.points) || !v.points.length ? 'points must be a non-empty array' : null),
    });
    // Models like to repeat the keys at the end of the text ("... [C0.positioning]"); the cites carry them.
    for (const p of draft.points) p.text = p.text.replace(/\s*\[[\w.,\s-]+\]\s*$/, '').trim();
    const issues = auditPoints(draft.points, o.values);
    if (!issues.length) return { points: draft.points, rounds: round + 1 };
    problems = issues.join('\n');
    say(`Draft ${round + 1} rejected: ${issues.length} problem${issues.length > 1 ? 's' : ''} (${issues[0]})`, 'check');
    if (round === 2) return { points: draft.points.filter((_, i) => !issues.some((x) => x.startsWith(`point ${i + 1}:`))), rounds: 3 };
  }
  return { points: [], rounds: 3 };
}

export function money(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}
