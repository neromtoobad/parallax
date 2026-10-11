import { BudgetExceeded, say, step } from '../context.ts';
import { companySearch, readPages } from '../crust.ts';
import { json } from '../llm.ts';
import { quoteOnPage } from '../agents/compare.ts';
import { emit } from '../store.ts';
import type { Check, Deliverable, Item, Job } from '../types.ts';
import { companyRow, money, RICH_FIELDS, screen, toCsv, type CompanyRow } from './shared.ts';

/**
 * Market map: the companies in a space, with size, age and funding from the database, each one
 * confirmed on its own homepage with a quoted line that shows what it does.
 */

interface Intake {
  space: string;
  country: string | null;
  count: number;
  exclude: string[];
  headcountMin: number | null;
  headcountMax: number | null;
}

export async function runMarketMap(job: Job): Promise<Deliverable> {
  const intake = await step(job, 'lead', 'intake', () =>
    json<Intake>({
      system:
        "You are the Lead at a research agency. Turn a client's market-map request into a work order: a one-line description of the companies in the space (for a semantic company search), a country filter if the client named one (full English name like \"United States\", else null), how many companies, any company domains to exclude, and an employee-count range if the client gave one (else null).",
      user: `Client brief: ${job.brief}\nForm fields: ${JSON.stringify(job.input)}\n\nReturn {"space": string, "country": string|null, "count": number, "exclude": string[], "headcountMin": number|null, "headcountMax": number|null}`,
      check: (v) => (!v?.space ? 'space required' : null),
    }),
  );
  const want = Math.max(1, Math.min(25, Number(job.input.count ?? intake.count ?? 10)));
  const country = intake.country ?? (job.input.country ? String(job.input.country) : null);
  if (!job.plan) {
    job.plan = { ...intake, country, count: want };
    say(`Work order: map ${want} companies in ${intake.space}${country ? ` (${country})` : ''}`, 'step');
  }

  const items: Item[] = [];
  const seen = new Set((intake.exclude ?? []).map((d) => d.toLowerCase()));
  const verifiedCount = () => items.filter((i) => i.status === 'verified').length;
  let cursor: string | null | undefined;
  let partial = false;

  try {
    for (let page = 1; page <= 4 && verifiedCount() < want; page++) {
      const batch = await step(job, 'records', `source:${page}`, async () => {
        say(`Searching the company database (page ${page})`, 'tool');
        const r = await companySearch({ query: intake.space, country: country ?? undefined, minStaff: intake.headcountMin, maxStaff: intake.headcountMax, limit: Math.min(40, want * 3 + 6), cursor: cursor ?? undefined, fields: RICH_FIELDS });
        return { next: r.next_cursor, companies: (r.companies ?? []).map(companyRow) };
      });
      cursor = batch.next;
      const fresh = batch.companies.filter((c) => c.domain && !seen.has(c.domain));
      fresh.forEach((c) => seen.add(c.domain));
      if (!fresh.length && !cursor) break;

      const screened = await step(job, 'lead', `screen:${page}`, () =>
        screen(
          `Companies in this space: ${intake.space}`,
          fresh,
          { min: intake.headcountMin, max: intake.headcountMax },
          "Keep only companies whose own product is in this space, best known first. Drop agencies, consultancies, investors, media, directories, and companies that only use or resell such products.",
        ),
      );

      for (let i = 0; i < screened.length; i += 3) {
        if (verifiedCount() >= want) break;
        const group = screened.slice(i, i + Math.min(3, want - verifiedCount()));
        const done = await Promise.all(
          group.map((c) =>
            step(job, 'field', `check:${c.domain}`, () => checkCompany(intake.space, c), { retries: 1 }).catch((e) => {
              if (e instanceof BudgetExceeded) throw e;
              return { title: c.name, subtitle: c.domain, link: `https://${c.domain}`, status: 'dropped', checks: [{ name: 'checked', ok: false, note: String(e.message ?? e).slice(0, 120) }], dropReason: 'check failed after retries' } as Item;
            }),
          ),
        );
        for (const it of done) {
          items.push(it);
          emit(job, { agent: 'verifier', kind: 'check', text: it.status === 'verified' ? `✓ ${it.title}: "${(it.fields?.quote ?? '').slice(0, 90)}"` : `✗ ${it.title}: ${it.dropReason}`, data: it });
        }
      }
      if (!cursor) break;
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    if (!verifiedCount()) throw e;
    partial = true;
    emit(job, { agent: 'cfo', kind: 'money', text: `Budget reached with ${verifiedCount()} of ${want} companies verified. Delivering those and charging only for them.` });
  }

  const verified = items.filter((i) => i.status === 'verified').slice(0, want);
  const dropped = items.filter((i) => i.status === 'dropped');
  if (!verified.length) throw new Error(`no companies survived verification (${dropped.length} checked)`);
  if (verified.length < want && !partial) say(`Ran out of matching companies: ${verified.length} of ${want} verified`, 'step');

  const price = job.quote ? Math.max(0.5, Math.round(((job.quote.priceUsd * Math.min(verified.length, want)) / want) * 2) / 2) : 0;
  const funded = verified.filter((v) => v.fields?.funding).length;
  return {
    headline: `${verified.length} of ${want} companies mapped in ${intake.space}${country ? ` (${country})` : ''}, each confirmed on its own website${funded ? `; ${funded} with disclosed funding` : ''}.`,
    space: intake.space,
    items: [...verified, ...dropped],
    stats: { wanted: want, verified: verified.length, checked: items.length, dropped: dropped.length, withFunding: funded },
    csv: toCsv(['company', 'domain', 'what_they_do', 'headcount', 'founded', 'funding_usd', 'last_round', 'hq'], verified.map((v) => [v.title, v.subtitle, v.fields?.quote, v.fields?.headcount, v.fields?.founded, v.fields?.fundingUsd, v.fields?.lastRound, v.fields?.hq])),
    partial: verified.length < want,
    priceUsd: price,
  };
}

/** Field: read the homepage and quote the line that shows the company is in the space. */
async function checkCompany(space: string, c: CompanyRow & { why: string }): Promise<Item> {
  const checks: Check[] = [];
  const fields: Record<string, string> = {
    headcount: c.headcount != null ? String(c.headcount) : '',
    founded: c.founded ? String(c.founded) : '',
    funding: money(c.fundingUsd),
    fundingUsd: c.fundingUsd != null ? String(c.fundingUsd) : '',
    lastRound: c.lastRound ?? '',
    hq: c.hq ?? c.country ?? '',
  };
  const item = (status: Item['status'], dropReason?: string): Item => ({ title: c.name, subtitle: c.domain, link: `https://${c.domain}`, status, checks, fields, dropReason });
  checks.push({ name: 'company record', ok: c.headcount != null || c.founded != null, note: [c.headcount != null && `${c.headcount} staff`, c.founded && `founded ${c.founded}`, c.hq].filter(Boolean).join(', ') || 'thin database record', source: 'crustdata' });

  say(`Reading ${c.domain}`, 'tool');
  const [site] = await readPages([`https://${c.domain}`], { humanRetry: true });
  checks.push({ name: 'site is live', ok: !!site?.ok, note: site?.ok ? site.title.slice(0, 80) : 'could not load the homepage', source: `https://${c.domain}` });
  if (!site?.ok) return item('dropped', 'website did not load');

  // The site must be the company the database means: its name shows up on its own homepage.
  const brand = c.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(inc|ltd|llc|the|technologies|labs|corp)$/.test(w))[0] ?? c.name.toLowerCase();
  const named = `${site.title} ${site.text.slice(0, 20_000)}`.toLowerCase().includes(brand);
  checks.push({ name: 'site names the company', ok: named, note: named ? `"${brand}" appears on the homepage` : `"${brand}" not on the homepage; the domain may belong to someone else`, source: site.url });
  if (!named) return item('dropped', 'homepage does not name the company');

  const r = await json<{ inSpace: boolean; quote: string; what: string }>({
    system: "You check whether a company's product is in a given market space, using ONLY its homepage text. Quote the exact words from the page that show what it does (max 160 chars), and say what it does in under 12 words. If the page doesn't show it is in the space, inSpace=false.",
    user: `Space: ${space}\nCompany: ${c.name} (${c.domain})\nHomepage text:\n${site.text.slice(0, 5000)}\n\nReturn {"inSpace": boolean, "quote": string, "what": string}`,
    check: (v) => (typeof v?.inSpace !== 'boolean' ? 'inSpace must be boolean' : null),
  });
  const quoted = r.inSpace && quoteOnPage(r.quote, site.text);
  checks.push({ name: 'in the space', ok: quoted, note: quoted ? `"${r.quote}"` : r.inSpace ? 'claimed, but the quote is not on the page' : r.what, source: site.url });
  if (!quoted) return item('dropped', r.inSpace ? 'quote not found on their site' : `not in the space: ${r.what}`);
  fields.what = r.what;
  fields.quote = r.quote;
  const out = item('verified');
  out.subtitle = `${c.domain} · ${r.what}`;
  return out;
}
