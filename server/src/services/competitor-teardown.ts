import { BudgetExceeded, say, step } from '../context.ts';
import { companiesByDomain, companySearch, directFetch, readPages, usablePage } from '../crust.ts';
import { env } from '../env.ts';
import { json } from '../llm.ts';
import { quoteOnPage } from '../agents/compare.ts';
import { emit } from '../store.ts';
import type { Check, Deliverable, Item, Job } from '../types.ts';
import { canon, clean, companyRow, escape, looksLikeDomain, money, quotedOnPage, resolveCompany, RICH_FIELDS, screen, toCsv, writeAudited, type CompanyRow } from './shared.ts';

/**
 * Competitor teardown: who the client competes with and how each one sells itself. Records finds
 * the rivals and their size and funding; Field reads each rival's own site and quotes its
 * positioning, target customer and pricing; the Writer may only cite what passed the quote check.
 */

interface Intake {
  name: string;
  domain: string | null;
  focus: string;
  local: boolean;
  known: { name: string; domain: string }[];
}

interface Offer {
  site: boolean;
  url: string;
  pricingUrl: string | null;
  positioning: Claimed | null;
  target: Claimed | null;
  pricing: Claimed | null;
}

interface Claimed {
  value: string;
  quote: string;
  source: string;
  verified: boolean;
  note: string;
}

const WANT = 5;

export async function runCompetitorTeardown(job: Job): Promise<Deliverable> {
  const intake = await step(job, 'lead', 'intake', () =>
    json<Intake>({
      system:
        'You are the Lead at a research agency. A client wants a competitor teardown. Extract the company to tear down against (and its domain if given, else null), what the client cares about most (focus), whether competitors should come from the same country (local=true only for businesses that compete locally, like banks, payments, retail, services), and up to 6 direct competitors you know of, as company names with their main website domains (the database will check each one exists).',
      user: `Client brief: ${job.brief}\nForm fields: ${JSON.stringify(job.input)}\n\nReturn {"name": string, "domain": string|null, "focus": string, "local": boolean, "known": [{"name", "domain"}]}`,
      check: (v) => (!v?.name ? 'missing name' : typeof v.local !== 'boolean' ? 'local must be boolean' : !Array.isArray(v.known) ? 'known must be an array' : null),
    }),
  );
  if (!job.plan) {
    job.plan = intake;
    // Outside any step there's no agent context, so say() would drop this; emit it as the Lead.
    emit(job, { agent: 'lead', kind: 'step', text: `Work order: competitor teardown for ${intake.name}, focus: ${intake.focus}` });
  }

  const company = await step(job, 'lead', 'resolve', () => {
    const raw = String(job.input.company ?? '');
    return resolveCompany(intake.name, intake.domain ?? (looksLikeDomain(raw) ? raw : null), job.brief);
  });
  const name = company.name || intake.name;

  // Field reads the client's own site first: the Writer needs both sides, and the search needs a description.
  const client = await step(job, 'field', 'client', () => readOffer(name, company.domain, intake.focus));

  // Records: companies that describe themselves like the client does.
  // Records: the rivals the Lead named, if the database has them, plus companies that describe themselves like the client.
  const rivals = await step(job, 'records', 'rivals', async () => {
    const brand = name.toLowerCase().split(/\s+/)[0];
    const known = [...new Set((intake.known ?? []).map((k) => clean(k.domain)).filter((d): d is string => !!d && d !== company.domain))].slice(0, 6);
    let named: CompanyRow[] = [];
    if (known.length) {
      say(`Checking the ${known.length} competitors the Lead named against the company database`, 'tool');
      // Several records can share a domain (old pages, regional arms); keep the biggest one per domain.
      const rows = ((await companiesByDomain(known, RICH_FIELDS)).companies ?? []).map(companyRow).filter((c) => c.domain);
      named = known.map((d) => rows.filter((c) => c.domain === d).sort((a, b) => (b.headcount ?? 0) - (a.headcount ?? 0))[0]).filter((c): c is CompanyRow => !!c);
      say(`${named.length} of ${known.length} are in the database${named.length < known.length ? `; ${known.filter((d) => !named.some((n) => n.domain === d)).join(', ')} not found` : ''}`);
    }
    // The company's own name in the query pulls in lookalike names ("Linea", "LINE"); search on what it does.
    const about = (company.description || client.positioning?.value || name).replace(new RegExp(`\\b${escape(name)}\\b`, 'gi'), '').slice(0, 400);
    say(`Searching the company database for businesses like ${name}${intake.local && company.country ? ` in ${company.country}` : ''}`, 'tool');
    const r = await companySearch({ query: about, mode: 'semantic', country: intake.local && company.country ? company.country : undefined, limit: 15, fields: RICH_FIELDS });
    const found = (r.companies ?? []).map(companyRow).filter((c) => c.domain && c.domain !== company.domain && !c.name.toLowerCase().startsWith(brand) && !named.some((n) => n.domain === c.domain));
    say(`Records proposed ${named.length + found.length} candidates`);
    return [...named, ...found];
  });

  const picked = await step(job, 'lead', 'screen', async () => {
    // Buyers shortlist companies of some weight; one-person startups crowd a semantic search otherwise.
    const minStaff = Math.max(10, Math.round((company.headcount ?? 100) * 0.05));
    const kept = await screen(
      `Direct competitors of ${name} (${company.domain}): ${(company.description || client.positioning?.value || '').slice(0, 300)}`,
      rivals,
      { min: minStaff, max: null },
      `Keep only direct competitors: companies whose product a buyer would weigh against ${name}'s. Best first: the ones buyers most often shortlist. Drop the company itself, its subsidiaries, agencies, consultancies, resellers, investors, and companies in a different product category.`,
    );
    return kept.slice(0, WANT + 1);
  });
  if (!picked.length) throw new Error(`no direct competitors of ${name} found in the database`);

  // One step per competitor: a crash or budget stop keeps every teardown already done.
  const items: (Item & { key: string })[] = [];
  let partial = false;
  try {
    for (const c of picked) {
      if (items.filter((i) => i.status === 'verified').length >= WANT) break;
      const item = await step(job, 'field', `teardown:${c.domain}`, async () => toItem(c, await readOffer(c.name, c.domain, intake.focus)), { retries: 1 }).catch((e) => {
        if (e instanceof BudgetExceeded) throw e;
        return { key: c.domain, title: c.name, subtitle: c.domain, link: `https://${c.domain}`, status: 'dropped', checks: [{ name: 'checked', ok: false, note: String(e.message ?? e).slice(0, 120) }], dropReason: 'check failed after retries' } as Item & { key: string };
      });
      items.push(item);
      const ok = item.checks.filter((x) => x.name.endsWith('quoted') && x.ok).length;
      emit(job, { agent: 'verifier', kind: 'check', text: item.status === 'verified' ? `✓ ${item.title}: ${ok} of 3 quotes found on their site` : `✗ ${item.title}: ${item.dropReason}`, data: item });
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded) || !items.some((i) => i.status === 'verified')) throw e;
    partial = true;
    emit(job, { agent: 'cfo', kind: 'money', text: `Budget reached after ${items.length} competitors. Writing up the ones already verified.` });
  }
  const kept = items.filter((i) => i.status === 'verified');
  if (!kept.length) throw new Error(`no competitor's site could be verified (${items.length} tried)`);

  // Writer: only verified quotes and database numbers are citable.
  const values: Record<string, string> = {};
  const addOffer = (id: string, label: string, o: Offer | null, f?: Record<string, string>) => {
    if (o?.positioning?.verified) values[`${id}.positioning`] = `${label}: ${o.positioning.value} ("${o.positioning.quote}")`;
    if (o?.target?.verified) values[`${id}.target`] = `${label} sells to: ${o.target.value} ("${o.target.quote}")`;
    if (o?.pricing?.verified) values[`${id}.pricing`] = `${label} pricing: ${o.pricing.value} ("${o.pricing.quote}")`;
    for (const k of ['headcount', 'founded', 'funding'] as const) if (f?.[k]) values[`${id}.${k}`] = `${label} ${k}: ${f[k]}`;
  };
  addOffer('C0', name, client, { headcount: company.headcount ? String(company.headcount) : '', founded: company.founded ? String(company.founded) : '', funding: money(company.fundingUsd) });
  kept.forEach((k, i) => addOffer(`C${i + 1}`, k.title, (k as any).offer ?? null, k.fields));

  const brief = await step(job, 'writer', 'write', () =>
    writeAudited({
      model: env.models.smart,
      system:
        'You write a competitor teardown for a client. Use ONLY the facts given; each has a key. Write 4-6 points. Each point starts with "Differs:" (how the client stands apart) or "Exposed:" (where a competitor is stronger or the client is open to attack), states the facts plainly, and ends with one concrete thing the client can do about it. Cite every fact key a point relies on (in cites, not in the text). A fact that is missing is unknown: never claim the client or a competitor lacks something unless a fact says so, and never describe a company (\"legacy\", \"retrofitted\", \"bloated\") beyond what its facts say. No hedging words ("likely", "probably", "may", "might", "could", "suggests", "seems", "potentially"). Do not add numbers, names or prices that are not in the cited facts.',
      user: `Client: ${name} (key prefix C0)\nFocus: ${intake.focus}\nFacts:\n${Object.entries(values).map(([k, v]) => `[${k}] ${v}`).join('\n')}`,
      values,
    }),
  );

  const quotes = items.flatMap((i) => i.checks.filter((c) => c.name.endsWith('quoted') && !/no pricing/.test(c.note)));
  return {
    headline: `${name} competes most directly with ${kept.map((k) => k.title).join(', ')}. ${brief.points.length} points on where it differs and where it is exposed, each backed by a quote from the competitor's own site or the company database.`,
    company: { name, domain: company.domain },
    focus: intake.focus,
    client: { positioning: client.positioning, target: client.target, pricing: client.pricing, url: client.url },
    items: [...kept, ...items.filter((i) => i.status === 'dropped')].map(({ key, ...i }) => {
      const { offer, ...rest } = i as any;
      return rest as Item;
    }),
    points: brief.points,
    stats: { candidates: rivals.length, competitors: kept.length, checked: items.length, dropped: items.length - kept.length, quotesChecked: quotes.length, quotesVerified: quotes.filter((q) => q.ok).length, draftRounds: brief.rounds },
    csv: toCsv(['competitor', 'domain', 'positioning', 'target', 'pricing', 'headcount', 'founded', 'funding'], kept.map((k) => [k.title, k.subtitle, k.fields?.positioning, k.fields?.target, k.fields?.pricing, k.fields?.headcount, k.fields?.founded, k.fields?.funding])),
    partial,
  };
}

/** Field: read a company's homepage (and its pricing page, if it has one) and quote how it sells itself. */
async function readOffer(name: string, domain: string, focus: string): Promise<Offer> {
  say(`Reading ${domain}`, 'tool');
  const home = `https://${domain}`;
  const [site] = await readPages([home], { humanRetry: true });
  if (!site?.ok) return { site: false, url: home, pricingUrl: null, positioning: null, target: null, pricing: null };
  // A pricing page is worth a free fetch, never a paid one: plenty of companies don't have one.
  const p = await directFetch(`${home}/pricing`);
  const pricingPage = usablePage(p) && canon(p.url) !== canon(site.url) ? p : null;
  const pages: Record<string, { url: string; text: string }> = { H: { url: site.url, text: site.text } };
  if (pricingPage) pages.P = { url: pricingPage.url, text: pricingPage.text };

  const out = await json<{ positioning: Raw | null; target: Raw | null; pricing: Raw | null }>({
    system:
      "You read a company's own web pages and pull out how it sells itself. For each item give a short plain value and a quote copied character-for-character from the page (max 200 chars) that states it, plus the page id. Quote one continuous run of words from the page: never join pieces with \"...\". positioning: what the product is, in one line. target: who it is for (type of customer or team). pricing: the plan prices or pricing model if the pages state them, else null. Use null for anything the pages don't state. Never use outside knowledge.",
    user: `Company: ${name} (${domain})\nClient focus: ${focus}\n\n${Object.entries(pages).map(([id, pg]) => `[${id}] ${pg.url}\n${pg.text.slice(0, id === 'H' ? 6000 : 5000)}`).join('\n\n')}\n\nReturn {"positioning": {"value", "quote", "page"}|null, "target": {"value", "quote", "page"}|null, "pricing": {"value", "quote", "page"}|null}`,
    check: (v) => (!v || typeof v !== 'object' || !('positioning' in v) ? 'positioning key required' : null),
  });

  // Verifier: a quote counts only if it is on the page it names (and, for prices, says the number).
  const verify = (r: Raw | null, isPrice = false): Claimed | null => {
    if (!r?.value || !r.quote) return null;
    const page = pages[r.page] ?? pages.H;
    const onPage = quotedOnPage(r.quote, page.text, quoteOnPage);
    const says = !isPrice || priceSays(String(r.value), r.quote);
    // Pricing tables come back as cells with feature lists between them, so a stitched quote rarely matches
    // word for word. Then every price in the value must itself be printed on the page as a price.
    const prices = isPrice && !(onPage && says) && pricesOnPage(String(r.value), page.text);
    return { value: String(r.value).slice(0, 200), quote: r.quote.slice(0, 240), source: page.url, verified: (onPage && says) || prices, note: onPage && says ? 'quote found on the page' : prices ? 'every price in it is printed on the page' : !onPage ? 'quote not found on the page' : "quote doesn't state the price" };
  };
  return { site: true, url: site.url, pricingUrl: pricingPage?.url ?? null, positioning: verify(out.positioning), target: verify(out.target), pricing: verify(out.pricing, true) };
}

/** A stated price must be in the quote: at least one non-zero number of the value appears in it. */
function priceSays(value: string, quote: string) {
  const nums = (t: string) => [...t.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0])).filter((n) => n > 0);
  const want = nums(value);
  if (!want.length) return true; // "Free" or "contact sales": nothing numeric to check beyond the quote itself
  const have = new Set(nums(quote));
  return want.some((n) => have.has(n));
}

function pricesOnPage(value: string, page: string) {
  const want = [...value.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]).filter((n) => parseFloat(n) > 0 && !/^(19|20)\d\d$/.test(n));
  if (!want.length) return false;
  const text = page.replace(/,/g, '');
  return want.every((n) => new RegExp(`[$€£]\\s?${n.replace('.', '\\.')}(?![\\d.])|\\b${n.replace('.', '\\.')}\\s?(?:usd|eur|gbp|\\/|per\\b)`, 'i').test(text));
}

interface Raw {
  value: string;
  quote: string;
  page: string;
}

function toItem(c: CompanyRow & { why?: string }, o: Offer): Item & { key: string; offer: Offer } {
  const checks: Check[] = [
    { name: 'company record', ok: c.headcount != null || c.founded != null, note: [c.headcount != null && `${c.headcount} staff`, c.founded && `founded ${c.founded}`, c.fundingUsd && `${money(c.fundingUsd)} raised`].filter(Boolean).join(', ') || 'thin database record', source: 'crustdata' },
    { name: 'site loads', ok: o.site, note: o.site ? o.url : 'could not load the homepage', source: o.url },
  ];
  const q = (label: string, x: Claimed | null, missing: string) => checks.push({ name: `${label} quoted`, ok: !!x?.verified, note: x ? (x.verified ? `"${x.quote}"` : `${x.note}: "${x.quote.slice(0, 100)}"`) : missing, source: x?.source });
  q('positioning', o.positioning, 'no positioning line found');
  q('target customer', o.target, 'the site does not say who it is for');
  q('pricing', o.pricing, o.pricingUrl ? 'no prices on the pricing page' : 'no pricing published');
  const ok = o.site && !!o.positioning?.verified;
  const v = (x: Claimed | null) => (x?.verified ? x.value : '');
  return {
    key: c.domain,
    title: c.name,
    subtitle: c.domain,
    link: o.url,
    status: ok ? 'verified' : 'dropped',
    dropReason: ok ? undefined : !o.site ? 'website did not load' : 'positioning quote not found on their site',
    checks,
    fields: {
      positioning: v(o.positioning),
      target: v(o.target),
      pricing: v(o.pricing),
      headcount: c.headcount != null ? String(c.headcount) : '',
      founded: c.founded ? String(c.founded) : '',
      funding: money(c.fundingUsd),
      lastRound: c.lastRound ?? '',
      hq: c.hq ?? c.country ?? '',
      why: c.why ?? '',
    },
    offer: o,
  };
}
