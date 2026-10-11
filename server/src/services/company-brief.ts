import { say, step } from '../context.ts';
import { companyEnrich, companySearch, peopleAt, readPages, webSearch, type WebResult } from '../crust.ts';
import { env } from '../env.ts';
import { json } from '../llm.ts';
import { num, quoteOnPage, quoteSupports, same, type Kind } from '../agents/compare.ts';
import type { Claim, Job, Resolved } from '../types.ts';
import { auditPoints, canon, clean, dedupe, personOf, pick, place } from './shared.ts';

export { canon, personOf };

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

  // 3b. Field: the open-web view, built only from pages it actually read. Two passes: a broad sweep,
  // then a targeted search for each fact still missing (gaps decide the next search, not a fixed list).
  const field = await step(job, 'field', 'field', async () => {
    const results: WebResult[] = [];
    const search = async (q: string, sources?: string[]) => {
      say(`Searching the web: "${q}"`, 'tool');
      const r = await webSearch(q, sources).catch((e) => (say(`search failed, moving on: ${e.message}`, 'recover'), [] as WebResult[]));
      results.push(...r);
      return r;
    };
    const pages: Page[] = [];
    const read = async (urls: string[]) => {
      const fresh = urls.map(canon).filter((u) => !pages.some((p) => canon(p.url) === u));
      if (!fresh.length) return;
      say(`Reading ${fresh.length} page${fresh.length > 1 ? 's' : ''}`, 'tool');
      const got = await readPages(fresh, { minText: 1500 }).catch((e) => (say(`page fetch failed (${e.message}); working from search snippets`, 'recover'), []));
      for (const p of got) if (p.ok) pages.push({ id: `P${pages.length + 1}`, url: canon(p.url), title: p.title, text: p.text });
    };
    const extract = async (keys: string[]) => {
      const snippets = dedupe(results).slice(0, 16).map((r, i) => ({ id: `S${i + 1}`, url: canon(r.url), title: r.title, text: `${r.title}. ${r.snippet}` }));
      const sources = [...pages, ...snippets];
      const wanted = FACTS.filter((f) => keys.includes(f.key));
      const out = await json<{ claims: { key: string; value: string | number | null; source: string; quote: string }[] }>({
        model: env.models.fast,
        maxTokens: 2000,
        system:
          'You are Field, a web researcher. Extract facts about ONE company using only the sources given. Every fact needs the id of the source it came from and a quote copied character-for-character from that source (max 200 chars) that states the fact. If no source states a fact, leave it out. Never use outside knowledge. Ignore sources about a different company with a similar name.',
        user: `Company: ${name} (${domain})\nFacts wanted (key: meaning):\n${wanted.map((f) => `${f.key}: ${f.label}${f.kind === 'money' ? ' as a number in USD' : f.kind === 'count' ? ' as a number' : ''}`).join('\n')}\n\nSources:\n${sources.map((p) => `[${p.id}] ${p.url}\n${focus(p.text, name)}`).join('\n\n')}\n\nReturn {"claims": [{"key", "value", "source": "<id>", "quote"}]}`,
        check: (v) => (!Array.isArray(v?.claims) ? 'claims must be an array' : v.claims.some((c: any) => !c.quote || !c.source) ? 'every claim needs source and quote' : null),
      });
      const byId = new Map(sources.map((p) => [p.id, p]));
      return {
        claims: out.claims
          .filter((c) => wanted.some((f) => f.key === c.key) && byId.has(c.source))
          .map((c) => ({ key: c.key, value: c.value, source: byId.get(c.source)!.url, quote: c.quote }) as Claim),
        sources,
      };
    };

    // Pass 1: the company's own site and the obvious searches.
    await search(`${name} ${domain}`);
    await search(`${name} ${domain} CEO founder`);
    const news = await webSearch(`${name} ${domain}`, ['news']).catch(() => [] as WebResult[]);
    await read(pickPages(domain, results, 3));
    let { claims, sources } = await extract(FACTS.map((f) => f.key));

    // Pass 2: one targeted search per missing fact, then read the best new page.
    const missing = FACTS.filter((f) => !claims.some((c) => c.key === f.key)).map((f) => f.key);
    const GAP: Record<string, [string, string[]?]> = {
      founded: [`${name} ${domain} founded in`],
      hq: [`${name} ${domain} headquarters`],
      headcount: [`${name} ${domain} number of employees`],
      funding_total: [`${name} raises funding total raised`, ['news']],
      last_round: [`${name} raises Series round`, ['news']],
      ceo: [`${name} ${domain} CEO`],
    };
    const queries = [...new Map(missing.filter((k) => GAP[k]).map((k) => [GAP[k][0], GAP[k]])).values()].slice(0, 3);
    if (queries.length) {
      say(`Still missing ${missing.join(', ')}; searching for those directly`, 'step');
      const fresh: WebResult[] = [];
      for (const [q, src] of queries) fresh.push(...(await search(q, src)));
      await read(pickPages(domain, fresh, 2, pages.map((p) => p.url)));
      const more = await extract(missing);
      claims = [...claims, ...more.claims];
      sources = more.sources;
    }
    say(`Field found ${claims.length} of ${FACTS.length} facts on ${sources.length} sources`);
    return {
      claims,
      pages: sources.map((p) => ({ id: p.id, url: p.url, title: p.title, text: p.text.slice(0, 20_000) })),
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
    // A URL can appear as a fetched page and as a search snippet; a quote may come from either.
    const pageText = new Map<string, string>();
    for (const p of field.pages as Page[]) pageText.set(canon(p.url), (pageText.get(canon(p.url)) ?? '') + '\n' + p.text);
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
      const text = web.source === 'crustdata' ? '' : (pageText.get(canon(web.source)) ?? (item.tiebreak as any)?.page ?? '');
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
          'You write sharp, specific briefing notes for someone walking into a meeting. Use ONLY the verified facts given. Each point states facts plainly and then gives one concrete thing to do or ask in the meeting because of them. Each point must cite the fact keys it relies on. Never guess about the company: no "likely", "probably", "may", "might", "could", "suggests", "seems", "potentially", "will resonate". Do not add numbers, names or dates that are not in the cited facts. 4-6 points, each one or two sentences.',
        user: `Company: ${name}\nPurpose: ${intake.purpose}\nWhat the client wants to know: ${intake.angles.join('; ')}\nVerified facts:\n${facts.map((f) => `[${f.key}] ${f.label}: ${f.value}`).join('\n')}\nRecent news headlines (may use, cite as "news"):\n${field.news.map((n: WebResult) => `- ${n.title}`).join('\n')}${problems ? `\n\nYour last draft was rejected:\n${problems}` : ''}\n\nReturn {"points": [{"text", "cites": [keys]}]}`,
        check: (v) => (!Array.isArray(v?.points) || !v.points.length ? 'points must be a non-empty array' : null),
      });
      const newsText = field.news.map((n: WebResult) => `${n.title} ${n.snippet}`).join(' ');
      const issues = auditPoints(draft.points, { ...Object.fromEntries(facts.map((f) => [f.key, String(f.value ?? '')])), news: newsText });
      if (!issues.length) return { points: draft.points, rounds: round + 1 };
      problems = issues.join('\n');
      say(`Draft ${round + 1} rejected: ${issues.length} problem${issues.length > 1 ? 's' : ''} (${issues[0]})`, 'check');
      if (round === 2) return { points: draft.points.filter((_, i) => !issues.some((x) => x.startsWith(`point ${i + 1}:`))), rounds: 3 };
    }
    return { points: [], rounds: 3 };
  });

  const conflicts = checked.filter((r) => r.agreement === 'conflict');
  const v = (k: string) => checked.find((r) => r.key === k && r.verified && r.value != null)?.value;
  const bits = [v('founded') && `founded ${v('founded')}`, v('hq') && `based in ${v('hq')}`, num(v('headcount')) != null && `about ${num(v('headcount'))!.toLocaleString('en-US')} staff`, v('ceo') && `led by ${v('ceo')}`].filter(Boolean);
  return {
    headline: `${name} (${domain})${bits.length ? `: ${bits.join(', ')}` : ''}. ${checked.filter((r) => r.verified).length} of ${checked.length} facts verified, ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} settled.`,
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

// ---- helpers --------------------------------------------------------------------------------

const SKIP = /linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|glassdoor\.|reddit\.com|quora\.com|apps\.apple\.com|play\.google\.com/i;

function pickPages(domain: string, results: WebResult[], max: number, have: string[] = []) {
  const seen = new Set(have.map(canon));
  const urls: string[] = [];
  const add = (u: string) => {
    const c = canon(u);
    if (!seen.has(c) && urls.length < max) {
      seen.add(c);
      urls.push(c);
    }
  };
  if (!have.length) add(`https://${domain}`);
  const ok = results.filter((r) => r?.url && !SKIP.test(r.url) && !/\.pdf$/i.test(r.url));
  const about = ok.find((r) => r.url.includes(domain) && /about|company|team|leadership/i.test(r.url));
  if (about) add(about.url);
  for (const r of ok) add(r.url);
  return urls;
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
