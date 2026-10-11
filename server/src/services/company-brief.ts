import { say, step } from '../context.ts';
import { companyEnrich, companySearch, peopleAt, webFetch, webSearch, type WebResult } from '../crust.ts';
import { env } from '../env.ts';
import { json } from '../llm.ts';
import { quoteOnPage, quoteSupports, same, type Kind } from '../agents/compare.ts';
import type { Claim, Job, Resolved } from '../types.ts';

/**
 * Company brief: everything you need before a sales call, investor meeting or partnership chat,
 * with every fact seen from two angles and checked against its source.
 */

export const FACTS: { key: string; label: string; kind: Kind }[] = [
  { key: 'what', label: 'What they do', kind: 'text' },
  { key: 'founded', label: 'Founded', kind: 'year' },
  { key: 'hq', label: 'Headquarters', kind: 'place' },
  { key: 'headcount', label: 'Employees', kind: 'count' },
  { key: 'funding_total', label: 'Total funding (USD)', kind: 'money' },
  { key: 'last_round', label: 'Latest round', kind: 'round' },
  { key: 'ceo', label: 'CEO', kind: 'person' },
];
const kindOf = (key: string) => FACTS.find((f) => f.key === key)?.kind ?? 'text';

interface Intake {
  name: string;
  domain: string | null;
  purpose: string;
  angles: string[];
}

interface Page {
  id: string;
  url: string;
  title: string;
  text: string;
}

export async function runCompanyBrief(job: Job) {
  // 1. Lead: understand the ask.
  const intake = await step(job, 'lead', 'intake', () =>
    json<Intake>({
      system:
        'You are the Lead at a research agency. Turn a client brief into a work order. Extract the company the client means, its website domain if the brief gives or clearly implies it (else null), the purpose of the brief, and 3-5 specific things the client will want to know for that purpose.',
      user: `Client brief: ${job.brief}\nForm fields: ${JSON.stringify(job.input)}\n\nReturn {"name": string, "domain": string|null, "purpose": string, "angles": string[]}`,
      check: (v) => (!v?.name ? 'missing name' : !Array.isArray(v.angles) ? 'angles must be an array' : null),
    }),
  );
  if (!job.plan) {
    job.plan = intake;
    say(`Work order: brief on ${intake.name}${intake.domain ? ` (${intake.domain})` : ''} for: ${intake.purpose}`, 'step');
  }

  // 2. Lead: pin down which company. A wrong match poisons everything after it.
  const company = await step(job, 'lead', 'resolve', async () => {
    const domain = clean(intake.domain ?? job.input.domain);
    const hits = await companySearch({ query: domain ? `${intake.name} ${domain}` : intake.name, limit: 5 });
    const list = (hits.companies ?? []).map((c: any) => ({ name: c.basic_info?.name, domain: c.basic_info?.primary_domain, description: c.basic_info?.description, headcount: c.headcount?.total }));
    const exact = domain && list.find((c) => clean(c.domain) === domain);
    if (exact) return exact;
    if (domain) return { name: intake.name, domain, description: null, headcount: null };
    if (!list.length) throw new Error(`no company found for "${intake.name}"`);
    const pick = await json<{ index: number; reason: string }>({
      system: 'Pick the company the client means. If none fit, return index -1.',
      user: `Client brief: ${job.brief}\nCandidates:\n${list.map((c, i) => `${i}. ${c.name} (${c.domain}) ${c.headcount ?? '?'} staff: ${(c.description ?? '').slice(0, 160)}`).join('\n')}\n\nReturn {"index": number, "reason": string}`,
      check: (v) => (typeof v?.index !== 'number' ? 'index must be a number' : null),
    });
    if (pick.index < 0 || !list[pick.index]) throw new Error(`could not tell which "${intake.name}" the client means`);
    say(`Matched ${list[pick.index].name} (${list[pick.index].domain}): ${pick.reason}`);
    return list[pick.index];
  });
  const domain = clean(company.domain)!;
  const name = company.name ?? intake.name;

  // 3a. Records: the structured database view. Plain mapping, no model: these are the database's own fields.
  const records = await step(job, 'records', 'records', async () => {
    say(`Pulling the company record for ${domain}`, 'tool');
    const c = await companyEnrich(domain);
    const claims: Claim[] = [];
    const add = (key: string, value: any, asOf?: string) => {
      if (value != null && value !== '') claims.push({ key, value, source: 'crustdata', asOf });
    };
    if (c) {
      add('what', pick(c, 'basic_info.description'));
      add('founded', pick(c, 'basic_info.year_founded'));
      add('hq', place(pick(c, 'locations.headquarters') ?? pick(c, 'locations.hq_location')));
      add('headcount', pick(c, 'headcount.total') ?? pick(c, 'headcount.latest_count'));
      add('funding_total', pick(c, 'funding.total_investment_usd'));
      const rt = pick(c, 'funding.last_round_type');
      if (rt) add('last_round', [rt, pick(c, 'funding.last_fundraise_date')].filter(Boolean).join(', '));
    } else say(`No database record for ${domain}`);
    say(`Looking up who runs ${name}`, 'tool');
    const people = await peopleAt({ domain, titles: ['CEO', 'Chief Executive'], limit: 3 }).catch(() => ({ profiles: [] }));
    const ceo = (people.profiles ?? []).map(personOf).find((p) => /\bceo\b|chief executive/i.test(p.title));
    if (ceo) add('ceo', ceo.name);
    say(`Records found ${claims.length} of ${FACTS.length} facts`);
    return { claims, raw: c ? { name: pick(c, 'basic_info.name'), website: pick(c, 'basic_info.website') } : null };
  });

  // 3b. Field: the open-web view, built only from pages it actually read.
  const field = await step(job, 'field', 'field', async () => {
    const queries = [`${name} ${domain}`, `${name} CEO`, `${name} funding round raised`, `${name} employees headquarters founded`];
    const results: WebResult[] = [];
    for (const q of queries) {
      say(`Searching the web: "${q}"`, 'tool');
      results.push(...(await webSearch(q).catch((e) => (say(`search failed, moving on: ${e.message}`, 'recover'), []))));
    }
    const news = await webSearch(`${name}`, ['news']).catch(() => [] as WebResult[]);
    const urls = pickPages(domain, results);
    say(`Reading ${urls.length} pages`, 'tool');
    const fetched = await webFetch(urls).catch((e) => (say(`page fetch failed (${e.message}); working from search snippets`, 'recover'), []));
    const pages: Page[] = [
      ...fetched.filter((p) => p.ok).map((p, i) => ({ id: `P${i + 1}`, url: p.url, title: p.title, text: p.text })),
      ...dedupe(results).slice(0, 14).map((r, i) => ({ id: `S${i + 1}`, url: r.url, title: r.title, text: `${r.title}. ${r.snippet}` })),
    ];
    const out = await json<{ claims: { key: string; value: string | number | null; source: string; quote: string }[] }>({
      model: env.models.fast,
      maxTokens: 2000,
      system:
        'You are Field, a web researcher. Extract facts about ONE company using only the sources given. Every fact needs the id of the source it came from and a quote copied character-for-character from that source (max 200 chars) that states the fact. If no source states a fact, leave it out. Never use outside knowledge.',
      user: `Company: ${name} (${domain})\nFacts wanted (key: meaning):\n${FACTS.map((f) => `${f.key}: ${f.label}${f.kind === 'money' ? ' as a number in USD' : f.kind === 'count' ? ' as a number' : ''}`).join('\n')}\n\nSources:\n${pages.map((p) => `[${p.id}] ${p.url}\n${focus(p.text, name)}`).join('\n\n')}\n\nReturn {"claims": [{"key", "value", "source": "<id>", "quote"}]}`,
      check: (v) => (!Array.isArray(v?.claims) ? 'claims must be an array' : v.claims.some((c: any) => !c.quote || !c.source) ? 'every claim needs source and quote' : null),
    });
    const byId = new Map(pages.map((p) => [p.id, p]));
    const claims: Claim[] = out.claims
      .filter((c) => FACTS.some((f) => f.key === c.key) && byId.has(c.source))
      .map((c) => ({ key: c.key, value: c.value, source: byId.get(c.source)!.url, quote: c.quote }));
    say(`Field found ${claims.length} of ${FACTS.length} facts on ${pages.length} sources`);
    return {
      claims,
      pages: pages.map((p) => ({ id: p.id, url: p.url, title: p.title, text: p.text.slice(0, 20_000) })),
      news: news.slice(0, 5),
    };
  });

  // 4. Arbiter: line the two angles up. Disagreements get a tiebreak search.
  const resolved: Resolved[] = [];
  for (const f of FACTS) {
    const r = records.claims.find((c: Claim) => c.key === f.key);
    const w = field.claims.find((c: Claim) => c.key === f.key);
    let item: Resolved;
    if (r && w) {
      const agree = same(f.kind, r.value, w.value);
      item = { key: f.key, label: f.label, value: f.kind === 'text' ? w.value : r.value, agreement: agree ? 'agree' : 'conflict', chosen: 'both', reason: agree ? 'both angles agree' : '', records: r, field: w };
    } else if (r) item = { key: f.key, label: f.label, value: r.value, agreement: 'records-only', chosen: 'records', reason: 'only the database had this', records: r };
    else if (w) item = { key: f.key, label: f.label, value: w.value, agreement: 'field-only', chosen: 'field', reason: 'only the web had this', field: w };
    else item = { key: f.key, label: f.label, value: null, agreement: 'neither', chosen: 'none', reason: 'neither angle found this' };

    if (item.agreement === 'conflict') {
      const t = await step(job, 'arbiter', `tiebreak:${f.key}`, () => tiebreak(name, domain, f, r!, w!));
      Object.assign(item, t);
    }
    resolved.push(item);
  }
  await step(job, 'arbiter', 'summary', async () => {
    const n = (a: string) => resolved.filter((x) => x.agreement === a).length;
    say(`${n('agree')} facts agree, ${n('conflict')} conflicted, ${n('records-only') + n('field-only')} came from one angle only`, 'resolve');
    return true;
  });

  // 5. Verifier: a web fact only counts if its quote is really on the page and really says the value.
  const checked = await step(job, 'verifier', 'verify', async () => {
    // Snippets first, so a fully fetched page with the same URL wins.
    const pageText = new Map<string, string>([...field.pages].reverse().map((p: Page) => [p.url, p.text]));
    for (const item of resolved) {
      const web = item.chosen === 'tiebreak' ? item.tiebreak : item.chosen === 'field' || item.chosen === 'both' ? item.field : undefined;
      if (item.chosen === 'records') {
        item.verified = true;
        item.check = 'database field';
        continue;
      }
      if (!web) {
        item.verified = false;
        item.check = 'no source';
        continue;
      }
      const text = web.source === 'crustdata' ? '' : (pageText.get(web.source) ?? (item.tiebreak as any)?.page ?? '');
      const onPage = web.quote ? quoteOnPage(web.quote, text) : false;
      const says = web.quote ? quoteSupports(kindOf(item.key), item.value, web.quote) : false;
      if (onPage && says) {
        item.verified = true;
        item.check = 'quote found on source and states the value';
      } else if (item.records) {
        say(`${item.label}: web quote ${onPage ? "doesn't state the value" : 'not found on the page'}; falling back to the database value`, 'check');
        item.value = item.records.value;
        item.chosen = 'records';
        item.verified = true;
        item.check = 'web claim failed verification; database value kept';
        item.reason = (item.reason ? item.reason + '; ' : '') + 'web claim failed the quote check';
      } else {
        say(`${item.label}: rejected, quote ${onPage ? "doesn't state the value" : 'not found on the page'}`, 'check');
        item.verified = false;
        item.check = onPage ? 'quote does not state the value' : 'quote not found on source';
      }
    }
    const ok = resolved.filter((r) => r.verified).length;
    say(`${ok} of ${resolved.length} facts verified`, 'check');
    return resolved;
  });

  // 6. Writer, then the Verifier again: every line must cite verified facts, and its numbers must match them.
  const facts = checked.filter((r) => r.verified && r.value != null);
  const brief = await step(job, 'writer', 'write', async () => {
    let problems = '';
    for (let round = 0; round < 3; round++) {
      const draft = await json<{ points: { text: string; cites: string[] }[] }>({
        model: env.models.smart,
        maxTokens: 1500,
        system:
          'You write sharp, specific briefing notes. Use ONLY the verified facts given. Each point must cite the fact keys it relies on. Do not add numbers, names or dates that are not in the cited facts. 4-6 points, each one or two sentences, aimed at the purpose.',
        user: `Company: ${name}\nPurpose: ${intake.purpose}\nWhat the client wants to know: ${intake.angles.join('; ')}\nVerified facts:\n${facts.map((f) => `[${f.key}] ${f.label}: ${f.value}`).join('\n')}\nRecent news headlines (may use, cite as "news"):\n${field.news.map((n: WebResult) => `- ${n.title}`).join('\n')}${problems ? `\n\nYour last draft was rejected:\n${problems}` : ''}\n\nReturn {"points": [{"text", "cites": [keys]}]}`,
        check: (v) => (!Array.isArray(v?.points) || !v.points.length ? 'points must be a non-empty array' : null),
      });
      const issues = auditPoints(draft.points, facts, field.news);
      if (!issues.length) return { points: draft.points, rounds: round + 1 };
      problems = issues.join('\n');
      say(`Draft ${round + 1} rejected: ${issues.length} problem${issues.length > 1 ? 's' : ''} (${issues[0]})`, 'check');
      if (round === 2) return { points: draft.points.filter((_, i) => !issues.some((x) => x.startsWith(`point ${i + 1}:`))), rounds: 3 };
    }
    return { points: [], rounds: 3 };
  });

  const conflicts = checked.filter((r) => r.agreement === 'conflict');
  return {
    company: { name, domain },
    purpose: intake.purpose,
    facts: checked,
    points: brief.points,
    news: field.news,
    conflicts: conflicts.map((c) => ({ key: c.key, label: c.label, records: c.records?.value, field: c.field?.value, value: c.value, chosen: c.chosen, reason: c.reason })),
    stats: {
      facts: checked.length,
      verified: checked.filter((r) => r.verified).length,
      agreed: checked.filter((r) => r.agreement === 'agree').length,
      conflicts: conflicts.length,
      draftRounds: brief.rounds,
    },
  };
}

async function tiebreak(name: string, domain: string, f: (typeof FACTS)[number], r: Claim, w: Claim) {
  say(`${f.label}: database says "${r.value}", web says "${w.value}". Looking for a tiebreaker.`, 'conflict');
  const results = await webSearch(`${name} ${f.label.toLowerCase()} ${new Date().getFullYear()}`).catch(() => [] as WebResult[]);
  const sources = dedupe(results)
    .slice(0, 6)
    .map((s, i) => ({ id: `T${i + 1}`, url: s.url, text: `${s.title}. ${s.snippet}` }));
  const v = await json<{ value: string | number | null; side: 'records' | 'field' | 'new' | 'unknown'; source: string | null; quote: string | null; reason: string }>({
    model: env.models.smart,
    system:
      "You are the Arbiter. Two independent researchers disagree on one fact. Decide using the evidence. Prefer the more recent and the more primary source (the company's own site or a filing beats an aggregator). If the new sources settle it, cite one with an exact quote. If nothing settles it, say unknown.",
    user: `Company: ${name} (${domain})\nFact: ${f.label}\nDatabase (Crustdata${r.asOf ? `, as of ${r.asOf}` : ''}): ${r.value}\nWeb (${w.source}): ${w.value}, quote: "${w.quote}"\nNew evidence:\n${sources.map((s) => `[${s.id}] ${s.url}\n${s.text}`).join('\n\n')}\n\nReturn {"value", "side": "records"|"field"|"new"|"unknown", "source": "<id or null>", "quote": "<exact quote or null>", "reason": "<one sentence>"}`,
    check: (x) => (!['records', 'field', 'new', 'unknown'].includes(x?.side) ? 'side must be records, field, new or unknown' : !x.reason ? 'reason required' : null),
  });
  const src = sources.find((s) => s.id === v.source);
  say(`${f.label}: ${v.side === 'unknown' ? 'unresolved' : `went with ${v.side === 'new' ? 'the tiebreak source' : v.side}`} (${v.reason})`, 'resolve');
  if (v.side === 'records') return { value: r.value, chosen: 'records' as const, reason: v.reason };
  if (v.side === 'field') return { value: w.value, chosen: 'field' as const, reason: v.reason };
  if (v.side === 'new' && src && v.quote) return { value: v.value, chosen: 'tiebreak' as const, reason: v.reason, tiebreak: { key: f.key, value: v.value, source: src.url, quote: v.quote, page: src.text } as Claim };
  return { value: r.value, chosen: 'records' as const, reason: `unresolved, kept the database value (${v.reason})` };
}

/** Plain-code audit of a draft: citations exist, numbers in the text match the cited facts. */
function auditPoints(points: { text: string; cites: string[] }[], facts: Resolved[], news: WebResult[]) {
  const issues: string[] = [];
  const keys = new Map(facts.map((f) => [f.key, f]));
  const newsText = news.map((n) => `${n.title} ${n.snippet}`).join(' ').toLowerCase();
  points.forEach((p, i) => {
    const cited = (p.cites ?? []).filter((c) => c !== 'news');
    const missing = cited.filter((c) => !keys.has(c));
    if (!p.cites?.length) issues.push(`point ${i + 1}: cites nothing`);
    if (missing.length) issues.push(`point ${i + 1}: cites unknown or unverified facts ${missing.join(', ')}`);
    const allowed = cited.map((c) => String(keys.get(c)?.value ?? '')).join(' ').toLowerCase() + ' ' + (p.cites?.includes('news') ? newsText : '');
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

// ---- helpers --------------------------------------------------------------------------------

function clean(d: unknown): string | null {
  if (!d || typeof d !== 'string') return null;
  return d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim() || null;
}

function pick(o: any, path: string) {
  return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o) ?? null;
}

function place(v: any): string | null {
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
    profileUrl: p.social_handles?.professional_network_identifier?.profile_url ?? null,
  };
}

const SKIP = /linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|glassdoor\./i;

function pickPages(domain: string, results: WebResult[]) {
  const urls = [`https://${domain}`];
  const own = results.filter((r) => r.url.includes(domain) && !SKIP.test(r.url));
  const about = own.find((r) => /about|company|team|leadership/i.test(r.url));
  if (about) urls.push(about.url);
  for (const r of dedupe(results)) {
    if (urls.length >= 5) break;
    if (!SKIP.test(r.url) && !urls.includes(r.url) && !/\.pdf$/i.test(r.url)) urls.push(r.url);
  }
  return urls;
}

function dedupe(results: WebResult[]) {
  const seen = new Set<string>();
  return results.filter((r) => r?.url && !seen.has(r.url) && seen.add(r.url));
}

/** Keep what matters in a long page: its opening, plus every paragraph that mentions a fact we want. */
function focus(text: string, name: string) {
  if (text.length < 3500) return text;
  const want = /founded|established|employ|staff|team of|headquarter|based in|offices?|ceo|chief executive|founder|raised|funding|series [a-h]|seed|million|billion|valuation/i;
  const paras = text.split('\n').filter((p) => p.trim().length > 30);
  const keep = [text.slice(0, 1200)];
  let size = 1200;
  for (const p of paras) {
    if (size > 5000) break;
    if (want.test(p) || p.includes(name)) {
      keep.push(p.slice(0, 600));
      size += Math.min(600, p.length);
    }
  }
  return keep.join('\n');
}
