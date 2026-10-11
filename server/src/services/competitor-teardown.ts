import { BudgetExceeded, say, step } from '../context.ts';
import { companySearch, directFetch, readPages, usablePage } from '../crust.ts';
import { env } from '../env.ts';
import { json } from '../llm.ts';
import { quoteOnPage, quoteSupports } from '../agents/compare.ts';
import { emit } from '../store.ts';
import type { Check, Deliverable, Item, Job } from '../types.ts';
import { canon, companyRow, looksLikeDomain, money, resolveCompany, RICH_FIELDS, screen, toCsv, writeAudited, type CompanyRow } from './shared.ts';

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
        'You are the Lead at a research agency. A client wants a competitor teardown. Extract the company to tear down against (and its domain if given, else null), what the client cares about most (focus), and whether competitors should come from the same country (local=true only for businesses that compete locally, like banks, payments, retail, services).',
      user: `Client brief: ${job.brief}\nForm fields: ${JSON.stringify(job.input)}\n\nReturn {"name": string, "domain": string|null, "focus": string, "local": boolean}`,
      check: (v) => (!v?.name ? 'missing name' : typeof v.local !== 'boolean' ? 'local must be boolean' : null),
    }),
  );
  if (!job.plan) {
    job.plan = intake;
    say(`Work order: competitor teardown for ${intake.name}, focus: ${intake.focus}`, 'step');
  }

  const company = await step(job, 'lead', 'resolve', () => {
    const raw = String(job.input.company ?? '');
    return resolveCompany(intake.name, intake.domain ?? (looksLikeDomain(raw) ? raw : null), job.brief);
  });
  const name = company.name || intake.name;

  // Field reads the client's own site first: the Writer needs both sides, and the search needs a description.
  const client = await step(job, 'field', 'client', () => readOffer(name, company.domain, intake.focus));

  // Records: companies that describe themselves like the client does.
  const rivals = await step(job, 'records', 'rivals', async () => {
    const about = company.description || client.positioning?.value || name;
    say(`Searching the company database for businesses like ${name}${intake.local && company.country ? ` in ${company.country}` : ''}`, 'tool');
    const r = await companySearch({ query: about.slice(0, 400), mode: 'semantic', country: intake.local && company.country ? company.country : undefined, limit: 25, fields: RICH_FIELDS });
    const brand = name.toLowerCase().split(/\s+/)[0];
    const list = (r.companies ?? []).map(companyRow).filter((c) => c.domain && c.domain !== company.domain && !c.name.toLowerCase().startsWith(brand));
    say(`Records proposed ${list.length} candidates`);
    return list;
  });

  const picked = await step(job, 'lead', 'screen', async () => {
    const kept = await screen(
      `Direct competitors of ${name} (${company.domain}): ${(company.description || client.positioning?.value || '').slice(0, 300)}`,
      rivals,
      undefined,
      `Keep only direct competitors: companies whose product a buyer would weigh against ${name}'s. Best first. Drop the company itself, its subsidiaries, agencies, consultancies, resellers, investors, and companies in a different product category.`,
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
        'You write a competitor teardown for a client. Use ONLY the facts given; each has a key. Write 4-6 points. Each point starts with "Differs:" (how the client stands apart) or "Exposed:" (where a competitor is stronger or the client is open to attack), states the facts plainly, and ends with one concrete thing the client can do about it. Cite every fact key a point relies on. No hedging words ("likely", "probably", "may", "might", "could", "suggests", "seems", "potentially"). Do not add numbers, names or prices that are not in the cited facts.',
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
      "You read a company's own web pages and pull out how it sells itself. For each item give a short plain value and a quote copied character-for-character from the page (max 200 chars) that states it, plus the page id. positioning: what the product is, in one line. target: who it is for (type of customer or team). pricing: the plan prices or pricing model if the pages state them, else null. Use null for anything the pages don't state. Never use outside knowledge.",
    user: `Company: ${name} (${domain})\nClient focus: ${focus}\n\n${Object.entries(pages).map(([id, pg]) => `[${id}] ${pg.url}\n${pg.text.slice(0, id === 'H' ? 6000 : 5000)}`).join('\n\n')}\n\nReturn {"positioning": {"value", "quote", "page"}|null, "target": {"value", "quote", "page"}|null, "pricing": {"value", "quote", "page"}|null}`,
    check: (v) => (!v || typeof v !== 'object' || !('positioning' in v) ? 'positioning key required' : null),
  });

  // Verifier: a quote counts only if it is on the page it names (and, for prices, says the number).
  const verify = (r: Raw | null, isPrice = false): Claimed | null => {
    if (!r?.value || !r.quote) return null;
    const page = pages[r.page] ?? pages.H;
    const onPage = quoteOnPage(r.quote, page.text);
    const says = !isPrice || !/\d/.test(r.value) || quoteSupports('money', r.value, r.quote);
    return { value: String(r.value).slice(0, 200), quote: r.quote.slice(0, 240), source: page.url, verified: onPage && says, note: !onPage ? 'quote not found on the page' : !says ? "quote doesn't state the price" : 'quote found on the page' };
  };
  return { site: true, url: site.url, pricingUrl: pricingPage?.url ?? null, positioning: verify(out.positioning), target: verify(out.target), pricing: verify(out.pricing, true) };
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
