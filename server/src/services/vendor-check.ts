import { BudgetExceeded, say, step } from '../context.ts';
import { companyEnrich, companySearch, peopleAt, readPages, webSearch, type WebResult } from '../crust.ts';
import { json } from '../llm.ts';
import { emit } from '../store.ts';
import { quoteOnPage } from '../agents/compare.ts';
import type { Check, Deliverable, Item, Job, Verdict } from '../types.ts';
import { clean, companyRow, dedupe, dnsState, looksLikeDomain, money, personOf, personOnWeb, RICH_FIELDS, seniority, type CompanyRow } from './shared.ts';

/**
 * Vendor check: "check before you pay". Every signal is a plain check with a severity, and the
 * verdict is computed from the checks in code. The model only reads web snippets and must quote them.
 */

interface Intake {
  name: string;
  domain: string | null;
  context: string;
}

interface Mention {
  url: string;
  title: string;
  snippet: string;
  from: 'search' | 'news';
  about: boolean;
  kind: 'scam' | 'complaint' | 'lawsuit' | 'distress' | 'neutral' | 'positive';
  quote: string;
  quoted: boolean;
}

const YEAR = new Date().getFullYear();

export async function runVendorCheck(job: Job): Promise<Deliverable> {
  const raw = String(job.input.company ?? '');
  const intake = await step(job, 'lead', 'intake', () =>
    json<Intake>({
      system: 'You are the Lead at a research agency. A client is about to pay a supplier and wants it checked. Extract the company name, its website domain if the client gave one (else null), and the deal context in one line.',
      user: `Client brief: ${job.brief}\nForm fields: ${JSON.stringify(job.input)}\n\nReturn {"name": string, "domain": string|null, "context": string}`,
      check: (v) => (!v?.name ? 'missing name' : null),
    }),
  );
  const givenDomain = clean(intake.domain) ?? (looksLikeDomain(raw) ? clean(raw) : null);
  if (!job.plan) {
    job.plan = { ...intake, domain: givenDomain };
    // Outside any step there's no agent context, so say() would drop this; emit it as the Lead.
    emit(job, { agent: 'lead', kind: 'step', text: `Work order: check ${intake.name}${givenDomain ? ` (${givenDomain})` : ''} before paying: ${intake.context}` });
  }

  // 1. Records: is there a company record, and is it this company?
  const rec = await step(job, 'records', 'record', async () => {
    let row: CompanyRow | null = null;
    if (givenDomain) {
      say(`Looking up ${givenDomain} in the company database`, 'tool');
      const c = await companyEnrich(givenDomain).catch((e) => {
        if (e instanceof BudgetExceeded) throw e;
        return null;
      });
      if (c) row = companyRow(c);
    }
    if (!row) {
      say(`Searching the company database for "${intake.name}"`, 'tool');
      const r = await companySearch({ query: givenDomain ? `${intake.name} ${givenDomain}` : intake.name, limit: 5, fields: RICH_FIELDS });
      const list = (r.companies ?? []).map(companyRow);
      row = (givenDomain ? list.find((c) => c.domain === givenDomain) : list.filter((c) => norm(c.name) === norm(intake.name)).sort((a, b) => (b.headcount ?? 0) - (a.headcount ?? 0))[0]) ?? null;
    }
    say(row ? `Found a record: ${row.name} (${row.domain}), ${row.headcount ?? '?'} staff, founded ${row.founded ?? '?'}` : 'No company record matches');
    return row;
  });
  const name = rec?.name || intake.name;
  let domain = givenDomain ?? rec?.domain ?? null;

  // 2. Field: does the domain exist and does the site say it's this company?
  const site = await step(job, 'field', 'site', async () => {
    let d = domain;
    if (!d) {
      say(`No domain given or on record; searching for ${name}'s website`, 'tool');
      const hits = await webSearch(`${name} official website`).catch(() => [] as WebResult[]);
      const brand = norm(name).split(' ')[0];
      d = clean(hits.find((h) => clean(h.url)?.includes(brand))?.url) ?? null;
    }
    if (!d) return { domain: null, dns: 'none' as const, ok: false, title: '', named: false, url: '' };
    const dns = await dnsState(d);
    if (dns === 'none') return { domain: d, dns, ok: false, title: '', named: false, url: `https://${d}` };
    say(`Reading ${d}`, 'tool');
    const [p] = await readPages([`https://${d}`], { humanRetry: true });
    const brand = norm(name).split(' ').find((w) => w.length > 2) ?? norm(name);
    return { domain: d, dns, ok: !!p?.ok, title: p?.title ?? '', named: !!p?.ok && norm(`${p.title} ${p.text.slice(0, 20_000)}`).includes(brand), url: p?.url ?? `https://${d}` };
  });
  domain = site.domain;

  // 3. Records then Field: a named leader in the people database, and the same person on the web.
  const leader = await step(job, 'records', 'leader', async () => {
    if (!domain) return null;
    say(`Looking up who runs ${name}`, 'tool');
    const r = await peopleAt({ domain, titles: ['CEO', 'Founder', 'Managing Director', 'Owner', 'President', 'Chief Executive'], limit: 5 }).catch((e) => {
      if (e instanceof BudgetExceeded) throw e;
      return { profiles: [] };
    });
    const people = (r.profiles ?? []).map(personOf).filter((p) => p.name).sort((a, b) => seniority(a.title, a.seniority) - seniority(b.title, b.seniority));
    return people[0] ?? null;
  });
  const leaderWeb = await step(job, 'field', 'leader-web', async () => {
    if (!leader) return null;
    say(`Checking ${leader.name} on the open web`, 'tool');
    const w = await personOnWeb(leader.name, name);
    return { mentions: w.mentions.length, left: w.left ? w.left.snippet.slice(0, 160) : null, url: (w.left ?? w.mentions[0])?.url ?? null };
  });

  // 4. Field: complaints, scam reports, lawsuits and news. The model sorts snippets; each must be quoted.
  const found = await step(job, 'field', 'mentions', async () => {
    const failed: string[] = [];
    // A failed search must not read as "nothing bad found": record it, and the check says so.
    const search = async (q: string, sources?: string[]) => {
      say(`Searching the ${sources ? 'news' : 'web'}: ${q}`, 'tool');
      for (let attempt = 1; ; attempt++) {
        const r = await webSearch(q, sources).catch((e) => {
          if (e instanceof BudgetExceeded) throw e;
          failed.push(sources ? 'news' : 'web');
          say(`${sources ? 'News' : 'Web'} search failed (${String(e.message).slice(0, 120)}); carrying on without it`, 'recover');
          return null;
        });
        // Live search sometimes comes back empty (and free) for a query that has results; one more try costs nothing.
        if (r && !r.length && attempt === 1) {
          say(`The ${sources ? 'news' : 'web'} search came back empty; trying once more`, 'recover');
          continue;
        }
        return r ?? [];
      }
    };
    const bad = await search(`"${name}"${domain ? ` OR ${domain}` : ''} scam OR fraud OR complaint OR lawsuit`);
    const news = await search(`${name}${domain ? ` ${domain}` : ''}`, ['news']);
    const all = [...dedupe(bad).map((r) => ({ ...r, from: 'search' as const })), ...dedupe(news).filter((n) => !bad.some((b) => b.url === n.url)).map((r) => ({ ...r, from: 'news' as const }))].slice(0, 14);
    if (!all.length) return { items: [] as Mention[], failed };
    const r = await json<{ items: { i: number; about: boolean; kind: Mention['kind']; quote: string }[] }>({
      system:
        `You sort web search snippets for a supplier check. For each snippet decide: about=true only if it is about THIS company (same name AND same business; not a namesake, not a generic article). kind: "scam" if it says this company itself is a scam or defrauded customers; "complaint" for a customer complaint about its service; "lawsuit" for a lawsuit, regulator action, fine or ban against it; "distress" for shutdown, insolvency, layoffs or unpaid debts; "neutral" for anything else (including articles about fraud prevention or fraud by third parties on its platform); "positive" for awards, funding, partnerships. quote: the words from the snippet that show it, copied exactly (max 160 chars).`,
      user: `Company: ${name}${domain ? ` (${domain})` : ''}${rec?.description ? `, ${rec.description.slice(0, 200)}` : ''}\n\nSnippets:\n${all.map((s, i) => `${i}. ${s.title}. ${s.snippet}\n   ${s.url}`).join('\n')}\n\nReturn {"items": [{"i", "about", "kind", "quote"}]} with one entry per snippet.`,
      check: (v) => (!Array.isArray(v?.items) ? 'items must be an array' : v.items.some((x: any) => !['scam', 'complaint', 'lawsuit', 'distress', 'neutral', 'positive'].includes(x.kind)) ? 'kind must be scam, complaint, lawsuit, distress, neutral or positive' : null),
    });
    const items = r.items
      .filter((x) => all[x.i])
      .map((x) => {
        const s = all[x.i];
        return { url: s.url, title: s.title, snippet: s.snippet, from: s.from, about: !!x.about, kind: x.kind, quote: x.quote ?? '', quoted: !!x.quote && quoteOnPage(x.quote, `${s.title}. ${s.snippet}`) } as Mention;
      });
    const about = items.filter((m) => m.about);
    say(`${about.length} of ${items.length} results are about ${name}${about.length ? `: ${['scam', 'lawsuit', 'complaint', 'distress'].map((k) => `${about.filter((m) => m.kind === k).length} ${k}`).join(', ')}` : ''}`);
    return { items, failed };
  });
  const mentions = found.items;

  // 5. Verifier: every signal as a plain check; the verdict is arithmetic on the failures.
  const result = await step(job, 'verifier', 'verdict', async () => {
    const checks: Check[] = [];
    const add = (c: Check) => checks.push(c);
    const established = !!rec && (rec.headcount ?? 0) >= 200 && !!rec.founded && YEAR - rec.founded >= 5;
    const soften = (s: Check['severity']): Check['severity'] => (established ? (s === 'high' ? 'medium' : 'low') : s);

    add(site.domain
      ? { name: 'domain resolves', ok: site.dns !== 'none', severity: site.dns === 'unknown' ? 'low' : 'high', note: site.dns === 'ok' ? `${site.domain} resolves` : site.dns === 'unknown' ? 'DNS lookup timed out' : `${site.domain} does not exist in DNS`, source: 'dns' }
      : { name: 'domain resolves', ok: false, severity: 'medium', note: 'no website given, on record, or found on the web', source: 'web search' });
    if (site.dns !== 'none' && site.domain) {
      add({ name: 'website loads', ok: site.ok, severity: 'medium', note: site.ok ? site.title.slice(0, 90) || site.url : 'the homepage did not load', source: site.url });
      if (site.ok) add({ name: 'website names the company', ok: site.named, severity: 'medium', note: site.named ? `${name} appears on its own homepage` : `the homepage does not mention ${name}`, source: site.url });
    }
    add({ name: 'company record', ok: !!rec, severity: 'medium', note: rec ? `${rec.name} (${rec.domain})` : 'no record in the company database', source: 'crustdata' });
    if (rec && givenDomain) {
      const matches = rec.domain === givenDomain && sameName(rec.name, intake.name);
      add({ name: 'record matches the name and domain', ok: matches, severity: 'high', note: matches ? `${rec.name} is registered at ${rec.domain}` : `the record for ${givenDomain} is "${rec.name}" (${rec.domain}), not "${intake.name}"`, source: 'crustdata' });
    }
    if (rec) {
      const age = rec.founded ? YEAR - rec.founded : null;
      add({
        name: 'founded year plausible',
        ok: age != null && age >= 2 && age < 200,
        severity: age == null ? 'low' : age < 0 ? 'high' : age < 1 ? 'medium' : 'low',
        note: age == null ? 'no founding year on record' : age < 0 ? `founding year ${rec.founded} is in the future` : age < 2 ? `founded ${rec.founded}: under two years old` : `founded ${rec.founded}`,
        source: 'crustdata',
      });
      add({ name: 'headcount plausible', ok: (rec.headcount ?? 0) >= 5, severity: 'low', note: rec.headcount == null ? 'no headcount on record' : `${rec.headcount} staff on record`, source: 'crustdata' });
    }
    add({ name: 'named leader in the people database', ok: !!leader, severity: 'medium', note: leader ? `${leader.name}, ${leader.title}` : 'no CEO, founder or owner on record', source: leader?.profileUrl ?? 'crustdata' });
    if (leader) {
      const ok = !!leaderWeb && leaderWeb.mentions > 0 && !leaderWeb.left;
      add({ name: 'leader confirmed on the web', ok, severity: 'medium', note: leaderWeb?.left ? `web says they left: "${leaderWeb.left}"` : ok ? `${leaderWeb!.mentions} page${leaderWeb!.mentions > 1 ? 's' : ''} link ${leader.name} to ${name}` : `no web page links ${leader.name} to ${name}`, source: leaderWeb?.url ?? undefined });
    }

    const webDown = found.failed.includes('web');
    const hits = (k: Mention['kind']) => mentions.filter((m) => m.about && m.quoted && m.kind === k);
    const scams = hits('scam'), suits = hits('lawsuit'), complaints = hits('complaint'), distress = hits('distress');
    const ev = (ms: Mention[]) => (ms.length ? `: "${ms[0].quote}"` : '');
    if (webDown) add({ name: 'web searched for complaints', ok: false, severity: 'medium', note: 'the web search failed, so complaints and scam reports were not checked', source: 'web search' });
    if (!webDown) add({ name: 'no scam or fraud reports', ok: !scams.length, severity: soften(scams.length >= 2 ? 'high' : 'medium'), note: scams.length ? `${scams.length} report${scams.length > 1 ? 's' : ''} call it a scam or fraud${ev(scams)}` : 'none found', source: scams[0]?.url });
    if (!webDown) add({ name: 'no lawsuits or regulator action', ok: !suits.length, severity: soften('medium'), note: suits.length ? `${suits.length} mention${suits.length > 1 ? 's' : ''}${ev(suits)}` : 'none found', source: suits[0]?.url });
    if (!webDown) add({ name: 'no pattern of complaints', ok: complaints.length < 3, severity: soften(complaints.length >= 3 ? 'medium' : 'low'), note: complaints.length ? `${complaints.length} complaint${complaints.length > 1 ? 's' : ''}${ev(complaints)}` : 'none found', source: complaints[0]?.url });
    if (!webDown) add({ name: 'no signs of distress', ok: !distress.length, severity: soften('medium'), note: distress.length ? `${distress.length} mention${distress.length > 1 ? 's' : ''} of shutdown, layoffs or debts${ev(distress)}` : 'none found', source: distress[0]?.url });
    const news = mentions.filter((m) => m.about && m.from === 'news');
    if (!found.failed.includes('news')) add({ name: 'covered in the news', ok: news.length > 0, severity: 'low', note: news.length ? `${news.length} news item${news.length > 1 ? 's' : ''}, e.g. "${news[0].title.slice(0, 90)}"` : 'no news coverage found', source: news[0]?.url });

    const fails = (s: Check['severity']) => checks.filter((c) => !c.ok && c.severity === s).length;
    const high = fails('high'), medium = fails('medium'), low = fails('low');
    const verdict: Verdict = high ? 'red' : medium >= 2 || (medium >= 1 && low >= 2) ? 'amber' : 'green';
    say(`${checks.filter((c) => c.ok).length} of ${checks.length} checks passed; ${high} serious, ${medium} medium, ${low} minor problems → ${verdict}`, 'check');
    return { checks, verdict, high, medium, low };
  });

  const { checks, verdict } = result;
  const failed = checks.filter((c) => !c.ok && c.severity !== 'low');
  const lead = { green: 'no serious problems found', amber: 'verify before you pay', red: 'do not pay until this is explained' }[verdict as 'green' | 'amber' | 'red'];
  const items: Item[] = [
    {
      title: name,
      subtitle: domain ?? 'no website found',
      link: domain ? `https://${domain}` : undefined,
      status: verdict === 'red' ? 'dropped' : 'verified',
      dropReason: verdict === 'red' ? failed.filter((c) => c.severity === 'high').map((c) => c.note).join('; ') : undefined,
      checks,
      fields: { founded: rec?.founded ? String(rec.founded) : '', headcount: rec?.headcount != null ? String(rec.headcount) : '', hq: rec?.hq ?? rec?.country ?? '', funding: money(rec?.fundingUsd), leader: leader ? `${leader.name}, ${leader.title}` : '' },
    },
    // The evidence the model sorted: kept when it's about this company and its quote is in the snippet.
    ...mentions
      .filter((m) => m.kind !== 'neutral' || m.from === 'news')
      .map((m) => ({
        title: m.title.slice(0, 140),
        subtitle: m.quote || m.snippet.slice(0, 160),
        link: m.url,
        status: m.about && m.quoted ? 'verified' : 'dropped',
        dropReason: !m.about ? 'about a different company or not about it at all' : !m.quoted ? 'quote not found in the snippet' : undefined,
        checks: [
          { name: 'about this company', ok: m.about, note: m.about ? `about ${name}` : 'not about this company' },
          { name: 'quote in the snippet', ok: m.quoted, note: m.quoted ? 'found word for word' : 'not found' },
        ],
        fields: { kind: m.kind, from: m.from },
      }) as Item),
  ];
  return {
    headline: `${verdict[0].toUpperCase() + verdict.slice(1)} for ${name}${domain ? ` (${domain})` : ''}: ${lead}. ${checks.filter((c) => c.ok).length} of ${checks.length} checks passed${failed.length ? `; problems: ${failed.map((c) => c.name).join(', ')}` : ''}.`,
    verdict,
    company: { name, domain },
    context: intake.context,
    items,
    stats: { checks: checks.length, passed: checks.filter((c) => c.ok).length, high: result.high, medium: result.medium, low: result.low, mentions: mentions.length, mentionsAbout: mentions.filter((m) => m.about && m.quoted).length },
  };
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\b(inc|ltd|llc|limited|plc|gmbh|corp|corporation|co|company|technologies|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** "Paystack" and "Paystack Payments Limited" are the same name; "Acme" and "Globex" aren't. */
function sameName(a: string, b: string) {
  const x = norm(a), y = norm(looksLikeDomain(b) ? b.replace(/^https?:\/\/(www\.)?/, '').split('.')[0] : b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x) || x.split(' ')[0] === y.split(' ')[0] || x.replace(/ /g, '') === y.replace(/ /g, '');
}
