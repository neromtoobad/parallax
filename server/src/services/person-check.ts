import { BudgetExceeded, say, step } from '../context.ts';
import { directFetch, personSearch, PERSON_FIELDS, usablePage, webSearch, type WebResult } from '../crust.ts';
import { json } from '../llm.ts';
import { quoteOnPage } from '../agents/compare.ts';
import type { Check, Claim, Deliverable, Item, Job, Resolved, Verdict } from '../types.ts';
import { canon, clean, looksLikeDomain, personOnWeb, rank, resolveCompany } from './shared.ts';

/**
 * Person check: is this person really at this company, in this role? Records reads the people
 * database (current and past employers); Field reads the open web and the company's own team page.
 * The verdict is counted in code from what each angle says.
 */

interface Profile {
  name: string;
  title: string;
  company: string;
  since: string | null;
  until?: string | null;
  profileUrl: string | null;
}

type Status = 'current' | 'former' | 'elsewhere' | 'none';

interface Found {
  status: Status;
  profile: Profile | null;
  now?: Profile;
  others?: Profile[];
}

export async function runPersonCheck(job: Job): Promise<Deliverable> {
  const person = String(job.input.name ?? '').trim();
  const companyIn = String(job.input.company ?? '').trim();
  const title = String(job.input.title ?? '').trim() || null;
  if (!person || !companyIn) throw new Error('need a name and a company');

  // Lead: which company. A company the database doesn't know can still be checked on the web.
  const company = await step(job, 'lead', 'resolve', async () => {
    say(`Work order: check that ${person} works at ${companyIn}${title ? ` as ${title}` : ''}`, 'step');
    try {
      const c = await resolveCompany(companyIn, looksLikeDomain(companyIn) ? companyIn : null, job.brief);
      return { name: c.name || companyIn, domain: c.domain || null };
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      say(`${companyIn} is not in the company database; checking by name only`, 'recover');
      return { name: companyIn, domain: looksLikeDomain(companyIn) ? clean(companyIn) : null };
    }
  });

  // Records: current employer first, then past employers, then anyone with that name.
  const rec = await step(job, 'records', 'person', async (): Promise<Found> => {
    const nameCond = { field: 'basic_profile.name', type: '(.)', value: person };
    const at = (when: 'current' | 'past') =>
      company.domain
        ? { field: `experience.employment_details.${when}.company_website_domain`, type: '=', value: company.domain }
        : { field: `experience.employment_details.${when}.company_name`, type: '(.)', value: company.name };
    const fields = [...PERSON_FIELDS, 'experience.employment_details.past'];
    say(`Searching the people database for ${person} at ${company.domain ?? company.name}`, 'tool');
    const cur = (await personSearch({ op: 'and', conditions: [nameCond, at('current')] }, { fields, limit: 3 })).profiles ?? [];
    const curHit = cur.find((p) => sameName(p.basic_profile?.name, person));
    if (curHit) return { status: 'current', profile: profileOf(curHit, company) };
    say(`Not listed there now; checking past employers`, 'tool');
    const past = (await personSearch({ op: 'and', conditions: [nameCond, at('past')] }, { fields, limit: 3 })).profiles ?? [];
    const pastHit = past.find((p) => sameName(p.basic_profile?.name, person));
    if (pastHit) return { status: 'former', profile: profileOf(pastHit, company, true), now: profileOf(pastHit) };
    const any = (await personSearch(nameCond, { limit: 3 })).profiles ?? [];
    const other = any.filter((p) => sameName(p.basic_profile?.name, person)).map((p) => profileOf(p));
    return { status: other.length ? 'elsewhere' : 'none', profile: null, others: other };
  });

  // Field: the open web and the company's own team page.
  const field = await step(job, 'field', 'web', async () => {
    say(`Searching the web: "${person}" ${company.name}`, 'tool');
    const hits = await webSearch(`"${person}" ${company.name}`).catch((e) => (e instanceof BudgetExceeded ? Promise.reject(e) : [] as WebResult[]));
    const web = await personOnWeb(person, company.name, hits);
    let read: { status: 'current' | 'former' | 'unknown'; title: string | null; quote: string | null; source: string | null } = { status: 'unknown', title: null, quote: null, source: null };
    const pool = web.mentions.slice(0, 8);
    if (pool.length) {
      const r = await json<{ status: 'current' | 'former' | 'unknown'; title: string | null; quote: string | null; source: number | null }>({
        system: 'You read web search snippets about one person and one company. Say whether the snippets show the person works there NOW (current), used to (former), or neither is clear (unknown). Give their title at that company if a snippet states it, a quote copied exactly from the snippet that shows it (max 160 chars), and the snippet number. Never use outside knowledge. A snippet saying they are a former employee of a DIFFERENT company does not make them former here.',
        user: `Person: ${person}\nCompany: ${company.name}\n\n${pool.map((h, i) => `${i}. ${h.title}. ${h.snippet}\n   ${h.url}`).join('\n')}\n\nReturn {"status": "current"|"former"|"unknown", "title": string|null, "quote": string|null, "source": number|null}`,
        check: (v) => (!['current', 'former', 'unknown'].includes(v?.status) ? 'status must be current, former or unknown' : null),
      });
      const s = r.source != null ? pool[r.source] : undefined;
      // The quote must be in the snippet it names, or the reading doesn't count.
      const ok = !!s && !!r.quote && quoteOnPage(r.quote, `${s.title}. ${s.snippet}`);
      read = ok ? { status: r.status, title: r.title, quote: r.quote, source: s!.url } : { status: 'unknown', title: null, quote: null, source: null };
      if (!ok && r.status !== 'unknown') say(`Web reading rejected: its quote is not in the snippet`, 'check');
    }

    // The company's own team/about page: a search hit on its domain, else a free fetch of the usual paths.
    let team: { url: string; line: string } | null = null;
    if (company.domain) {
      const own = hits.filter((h) => clean(h.url)?.endsWith(company.domain!) && /team|about|leadership|people|company|founder/i.test(h.url)).map((h) => h.url);
      const urls = [...new Set([...own, `https://${company.domain}/about`, `https://${company.domain}/team`, `https://${company.domain}/company`])].slice(0, 4);
      for (const u of urls) {
        const p = await directFetch(u);
        if (!usablePage(p)) continue;
        const line = lineWith(p.text, person);
        if (line) {
          team = { url: canon(p.url), line };
          break;
        }
      }
      say(team ? `${person} is named on ${team.url}` : `${person} not found on ${company.domain}'s own team or about pages`, 'tool');
    }
    return {
      hits: hits.length,
      mentions: web.mentions.slice(0, 6).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
      left: web.left ? { url: web.left.url, snippet: web.left.snippet } : null,
      read,
      team,
    };
  });

  // Verifier: count the angles. No model decides the verdict.
  const out = await step(job, 'verifier', 'verdict', async () => {
    const recCurrent = rec.status === 'current';
    const recFormer = rec.status === 'former';
    const webCurrent = field.read.status === 'current' || (field.mentions.length > 0 && !field.left && field.read.status !== 'former');
    const webFormer = field.read.status === 'former' || (!!field.left && field.read.status !== 'current');
    const current = [recCurrent, webCurrent, !!field.team].filter(Boolean).length;
    const former = [recFormer, webFormer].filter(Boolean).length;
    const titles = [rec.profile?.title, field.read.title].filter(Boolean) as string[];
    const titleOk = !title || titles.some((t) => titleMatch(t, title));

    let verdict: Verdict;
    let why: string;
    if (!current && !former) {
      verdict = 'not-found';
      why = rec.status === 'elsewhere' ? `the database knows a ${person} at ${rec.others?.[0]?.company || 'another company'}, but nothing links them to ${company.name}` : `neither the database nor the web links ${person} to ${company.name}`;
    } else if (former >= current) {
      verdict = 'mismatch';
      why = recFormer ? `the database lists ${company.name} as a past employer${rec.profile?.until ? ` (until ${String(rec.profile.until).slice(0, 7)})` : ''}${rec.now?.company ? `; now at ${rec.now.company}` : ''}` : `the web says they left ${company.name}`;
    } else if (!titleOk) {
      verdict = 'mismatch';
      why = `works at ${company.name}, but as ${titles[0]}, not ${title}`;
    } else {
      verdict = 'confirmed';
      why = `${current} of 3 sources place them at ${company.name} now${titles[0] ? ` as ${titles[0]}` : ''}`;
    }

    const checks: Check[] = [
      { name: 'in the people database at this company', ok: recCurrent, severity: 'medium', note: recCurrent ? `${rec.profile!.title}${rec.profile!.since ? `, since ${String(rec.profile!.since).slice(0, 7)}` : ''}` : recFormer ? `listed as a past employee${rec.now?.company ? `; now at ${rec.now.company}` : ''}` : 'not listed', source: rec.profile?.profileUrl ?? 'crustdata' },
      { name: 'on the open web', ok: webCurrent, severity: 'medium', note: field.read.quote ? `"${field.read.quote}"` : field.left ? `says they left: "${field.left.snippet.slice(0, 140)}"` : field.mentions.length ? `${field.mentions.length} page${field.mentions.length > 1 ? 's' : ''} link them to ${company.name}` : 'no page links them to the company', source: field.read.source ?? field.mentions[0]?.url },
      { name: "on the company's own site", ok: !!field.team, severity: 'low', note: field.team ? `"${field.team.line}"` : company.domain ? 'not on its team or about pages' : 'no company website to check', source: field.team?.url },
      { name: 'no sign they left', ok: !former, severity: 'high', note: former ? why : 'nothing says they left', source: field.left?.url },
    ];
    if (title) checks.push({ name: 'title matches', ok: titleOk, severity: 'high', note: titles.length ? `on record: ${titles.join(' / ')}` : 'no title on record to compare', source: 'crustdata' });
    say(`${verdict}: ${why}`, 'check');
    return { verdict, why, checks, titleOk, current, former };
  });

  // Two-angle fact rows: what the database says next to what the web says.
  const recClaim = (key: string, value: string | null): Claim | undefined => (value ? { key, value, source: rec.profile?.profileUrl ?? 'crustdata', asOf: rec.profile?.since ?? undefined } : undefined);
  const webClaim = (key: string, value: string | null): Claim | undefined => (value && field.read.source ? { key, value, source: field.read.source, quote: field.read.quote ?? undefined } : undefined);
  const row = (key: string, label: string, r?: Claim, w?: Claim, agree?: boolean): Resolved => ({
    key,
    label,
    value: r?.value ?? w?.value ?? null,
    agreement: r && w ? (agree ? 'agree' : 'conflict') : r ? 'records-only' : w ? 'field-only' : 'neither',
    chosen: r && w ? 'both' : r ? 'records' : w ? 'field' : 'none',
    reason: r && w ? (agree ? 'both angles agree' : 'the angles disagree') : r ? 'only the database had this' : w ? 'only the web had this' : 'neither angle found this',
    records: r,
    field: w,
    verified: !!(r || w),
    check: w ? 'quote found in the search snippet' : r ? 'database field' : 'no source',
  });
  const recEmployer = rec.status === 'current' ? `${company.name} (current)` : rec.status === 'former' ? `${company.name} (former)` : null;
  const webEmployer = field.read.status !== 'unknown' ? `${company.name} (${field.read.status})` : null;
  const facts: Resolved[] = [
    row('employer', `At ${company.name}`, recClaim('employer', recEmployer), webClaim('employer', webEmployer), recEmployer === webEmployer),
    row('title', 'Title', recClaim('title', rec.profile?.title ?? null), webClaim('title', field.read.title), !!rec.profile?.title && !!field.read.title && (titleMatch(rec.profile.title, field.read.title) || titleMatch(field.read.title, rec.profile.title))),
  ];

  const items: Item[] = [];
  if (rec.profile) items.push({ title: rec.profile.name, subtitle: `${rec.profile.title} at ${rec.profile.company || company.name}`, link: rec.profile.profileUrl ?? undefined, status: 'verified', checks: [{ name: 'people database', ok: true, note: rec.status === 'current' ? 'current role' : 'past role' }], fields: { since: rec.profile.since ? String(rec.profile.since).slice(0, 10) : '', until: rec.profile.until ? String(rec.profile.until).slice(0, 10) : '', source: 'records' } });
  for (const o of rec.others ?? []) items.push({ title: o.name, subtitle: `${o.title} at ${o.company}`, link: o.profileUrl ?? undefined, status: 'dropped', dropReason: `a namesake at ${o.company || 'another company'}`, checks: [], fields: { source: 'records' } });
  for (const m of field.mentions) {
    const left = field.left?.url === m.url;
    items.push({ title: m.title.slice(0, 140), subtitle: m.snippet.slice(0, 180), link: m.url, status: left ? 'dropped' : 'verified', dropReason: left ? 'says they left' : undefined, checks: [{ name: 'names the person and company', ok: true, note: 'surname and company both in the snippet' }], fields: { source: 'field' } });
  }
  if (field.team) items.push({ title: `${company.name} team page`, subtitle: field.team.line, link: field.team.url, status: 'verified', checks: [{ name: 'named on the company site', ok: true, note: 'name found on the page' }], fields: { source: 'field' } });

  const label = { confirmed: 'Confirmed', mismatch: 'Mismatch', 'not-found': 'Not found' }[out.verdict as 'confirmed' | 'mismatch' | 'not-found'];
  return {
    headline: `${label}: ${person} ${out.verdict === 'confirmed' ? `works at ${company.name}` : out.verdict === 'mismatch' ? `and ${company.name} don't line up` : `could not be placed at ${company.name}`}; ${out.why}.`,
    verdict: out.verdict,
    person: { name: person, company: company.name, domain: company.domain, title },
    facts,
    items,
    stats: { sources: 3, confirming: out.current, contradicting: out.former, webHits: field.hits, webMentions: field.mentions.length, titleMatches: Number(out.titleOk) },
  };
}

function profileOf(p: any, company?: { name: string; domain: string | null }, past = false): Profile {
  const roles: any[] = (past ? p.experience?.employment_details?.past : p.experience?.employment_details?.current) ?? [];
  const brand = company?.name.toLowerCase().split(/\s+/)[0];
  const role = (company && roles.find((r) => (company.domain && clean(r.company_website_domain ?? r.company_website) === company.domain) || (brand && String(r.name ?? r.company_name ?? '').toLowerCase().includes(brand)))) ?? roles[0] ?? {};
  return {
    name: p.basic_profile?.name ?? '',
    title: role.title ?? p.basic_profile?.headline ?? '',
    company: role.name ?? role.company_name ?? '',
    since: role.start_date ?? null,
    until: role.end_date ?? null,
    profileUrl: p.social_handles?.professional_network_identifier?.profile_url ?? null,
  };
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);

/** Same person's name: every word of the shorter name is in the longer one ("Karri Saarinen" ~ "Karri Saarinen (he/him)"). */
function sameName(a: unknown, b: string) {
  if (typeof a !== 'string') return false;
  const x = words(a), y = words(b);
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.length > 0 && short.every((w) => long.has(w));
}

const EXPAND: Record<string, string> = { ceo: 'chief executive officer', cto: 'chief technology officer', cfo: 'chief financial officer', coo: 'chief operating officer', cmo: 'chief marketing officer', cpo: 'chief product officer', chro: 'chief human resources officer', vp: 'vice president', svp: 'senior vice president' };
const longForm = (t: string) => t.toLowerCase().replace(/\b(ceo|cto|cfo|coo|cmo|cpo|chro|vp|svp)\b/g, (m) => EXPAND[m]);

/** "CEO" matches "Co-founder & CEO" and "Chief Executive Officer"; "CTO" doesn't match "CEO". */
export function titleMatch(onRecord: string, asked: string) {
  return rank(longForm(onRecord), [longForm(asked)]) < 99;
}

/** The line of a page that names the person, if any. */
function lineWith(text: string, name: string) {
  const last = words(name).pop();
  const first = words(name)[0];
  if (!last) return null;
  for (const l of text.split('\n')) {
    const w = l.toLowerCase();
    if (w.includes(last) && w.includes(first)) return l.trim().slice(0, 200);
  }
  return null;
}
