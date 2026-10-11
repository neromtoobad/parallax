import { BudgetExceeded, say, step } from '../context.ts';
import { companySearch, peopleAt, readPages, webSearch } from '../crust.ts';
import { json } from '../llm.ts';
import { quoteOnPage } from '../agents/compare.ts';
import { personOf } from './company-brief.ts';
import { emit } from '../store.ts';
import type { Job, Lead } from '../types.ts';
import { resolve4, resolve6 } from 'node:dns/promises';

/**
 * Lead list: N companies that fit the client's ideal customer, each with the right person to
 * contact. Records proposes companies and people from the database; Field reads each company's
 * own site and the open web; a lead ships only if both angles hold up.
 */

interface Intake {
  icp: string;
  country: string | null;
  titles: string[];
  count: number;
  exclude: string[];
  headcountMin: number | null;
  headcountMax: number | null;
}

// When nobody holds the exact title, a founder or C-level exec can still take the call. A sales director can't.
const BROAD_TITLES = ['Founder', 'CEO', 'Chief'];

export async function runLeadList(job: Job) {
  const intake = await step(job, 'lead', 'intake', () =>
    json<Intake>({
      system:
        "You are the Lead at a research agency. Turn a client's lead-list request into a work order: a one-line description of the companies to find (for a semantic company search), a country filter if the client named one (full English name like \"United States\", else null), 2-4 job titles of the person to contact (short forms that appear in titles, like \"Head of Sales\" or \"CTO\"), how many leads, any company domains to exclude, and an employee-count range if the client gave one (else null).",
      user: `Client brief: ${job.brief}\nForm fields: ${JSON.stringify(job.input)}\n\nReturn {"icp": string, "country": string|null, "titles": string[], "count": number, "exclude": string[], "headcountMin": number|null, "headcountMax": number|null}`,
      check: (v) => (!v?.icp ? 'icp required' : !Array.isArray(v.titles) || !v.titles.length ? 'titles must be a non-empty array' : null),
    }),
  );
  const want = Math.max(1, Math.min(25, Number(job.input.count ?? intake.count ?? 10)));
  if (!job.plan) {
    job.plan = { ...intake, count: want };
    say(`Work order: ${want} leads, ${intake.icp}${intake.country ? ` in ${intake.country}` : ''}, contact: ${intake.titles.join(' / ')}`, 'step');
  }

  const leads: Lead[] = [];
  const seen = new Set((intake.exclude ?? []).map((d) => d.toLowerCase()));
  let cursor: string | null | undefined;
  let partial = false;

  try {
    for (let page = 1; page <= 4 && leads.filter((l) => l.status === 'verified').length < want; page++) {
      const batch = await step(job, 'records', `source:${page}`, async () => {
        say(`Searching the company database (page ${page})`, 'tool');
        const r = await companySearch({ query: intake.icp, country: intake.country ?? undefined, minStaff: intake.headcountMin, maxStaff: intake.headcountMax, limit: Math.min(40, want * 3 + 6), cursor: cursor ?? undefined });
        return {
          next: r.next_cursor,
          companies: (r.companies ?? []).map((c: any) => ({
            name: c.basic_info?.name ?? '',
            domain: (c.basic_info?.primary_domain ?? '').toLowerCase(),
            description: c.basic_info?.description ?? '',
            headcount: c.headcount?.total ?? null,
            country: c.locations?.country ?? null,
          })),
        };
      });
      cursor = batch.next;
      const fresh = batch.companies.filter((c: any) => c.domain && !seen.has(c.domain));
      fresh.forEach((c: any) => seen.add(c.domain));
      if (!fresh.length && !cursor) break;

      // Screen on the database descriptions first (one cheap model call for the whole page), so
      // credits go only on companies worth checking. Field still has to confirm each one on its own site.
      const screened = await step(job, 'lead', `screen:${page}`, async () => {
        const inRange = fresh.filter((c: any) => c.headcount == null || ((intake.headcountMin == null || c.headcount >= intake.headcountMin * 0.8) && (intake.headcountMax == null || c.headcount <= intake.headcountMax * 1.25)));
        if (inRange.length < fresh.length) say(`${fresh.length - inRange.length} companies outside the ${intake.headcountMin ?? 0}-${intake.headcountMax ?? '∞'} employee range`, 'step');
        if (!inRange.length) return [];
        const r = await json<{ keep: { i: number; why: string }[] }>({
          system: "Screen companies for a client's ideal customer profile using their database descriptions. Keep only clear fits, best first. Drop agencies, consultancies, law firms, foundations, accelerators, freelancers and companies whose description doesn't show the fit. A company that IS the kind of company described is a fit; don't require it to sell to that kind of company unless the profile says so.",
          user: `Ideal customer: ${intake.icp}\nCandidates:\n${inRange.map((c: any, i: number) => `${i}. ${c.name} (${c.domain}), ${c.headcount ?? '?'} staff, ${c.country ?? '?'}: ${(c.description ?? '').slice(0, 220)}`).join('\n')}\n\nReturn {"keep": [{"i": number, "why": string}]}`,
          check: (v) => (!Array.isArray(v?.keep) ? 'keep must be an array' : null),
        });
        const kept = r.keep.filter((k) => inRange[k.i]).map((k) => inRange[k.i]);
        // The database still lists companies that are gone. A DNS lookup is free; a page fetch isn't.
        const alive = await Promise.all(kept.map((c: any) => resolves(c.domain)));
        const live = kept.filter((_: any, i: number) => alive[i]);
        say(`Screened ${inRange.length} candidates on their database profiles; ${kept.length} worth checking${live.length < kept.length ? `, ${kept.length - live.length} with dead domains skipped` : ''}`, 'step');
        return live;
      });

      // Three at a time: fast, and well inside Crustdata's per-minute limits.
      for (let i = 0; i < screened.length; i += 3) {
        const verified = leads.filter((l) => l.status === 'verified').length;
        if (verified >= want) break;
        const group = screened.slice(i, i + Math.min(3, want - verified));
        const done = await Promise.all(group.map((c: any) => step(job, 'field', `check:${c.domain}`, () => checkLead(intake, c), { retries: 1 }).catch((e) => {
          if (e instanceof BudgetExceeded) throw e;
          return { company: c, fit: '', checks: [{ name: 'checked', ok: false, note: String(e.message ?? e).slice(0, 120) }], status: 'dropped', dropReason: 'check failed after retries' } as Lead;
        })));
        for (const l of done) {
          leads.push(l);
          emit(job, {
            agent: 'verifier',
            kind: 'check',
            text: l.status === 'verified' ? `✓ ${l.company.name}: ${l.person?.name} (${l.person?.title})` : `✗ ${l.company.name}: ${l.dropReason}`,
            data: l,
          });
        }
      }
      if (!cursor) break;
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    const got = leads.filter((l) => l.status === 'verified').length;
    if (!got) throw e;
    partial = true;
    emit(job, { agent: 'cfo', kind: 'money', text: `Budget reached with ${got} of ${want} leads verified. Delivering those and charging only for them.` });
  }

  const verified = leads.filter((l) => l.status === 'verified');
  const dropped = leads.filter((l) => l.status === 'dropped');
  if (!verified.length) throw new Error(`no leads survived verification (${dropped.length} checked)`);
  if (verified.length < want && !partial) say(`Ran out of matching companies: ${verified.length} of ${want} leads verified`, 'step');

  const price = job.quote ? Math.max(0.5, Math.round(((job.quote.priceUsd * Math.min(verified.length, want)) / want) * 2) / 2) : 0;
  return {
    partial: verified.length < want,
    priceUsd: price,
    icp: intake.icp,
    leads: verified,
    dropped,
    csv: toCsv(verified),
    stats: {
      wanted: want,
      verified: verified.length,
      checked: leads.length,
      dropped: dropped.length,
      twoSource: verified.filter((l) => l.checks.find((c) => c.name === 'person on the web')?.ok).length,
    },
  };
}

async function checkLead(intake: Intake, c: { name: string; domain: string; description: string; headcount: number | null; country: string | null }): Promise<Lead> {
  const checks: Lead['checks'] = [];
  const drop = (reason: string): Lead => ({ company: c, fit: '', checks, status: 'dropped', dropReason: reason });

  // Field angle 1: does the company's own site say it fits?
  say(`Reading ${c.domain}`, 'tool');
  const [site] = await readPages([`https://${c.domain}`], { humanRetry: true });
  checks.push({ name: 'site is live', ok: !!site?.ok, note: site?.ok ? site.title.slice(0, 80) : 'could not load the homepage' });
  if (!site?.ok) return drop('website did not load');

  const fit = await json<{ fits: boolean; quote: string; reason: string }>({
    system:
      "You check whether a company matches a client's ideal customer profile, using ONLY the company's own homepage text. Quote the exact words from the page that show it (max 160 chars). If the page doesn't show a fit, fits=false.",
    user: `Ideal customer: ${intake.icp}\nCompany: ${c.name} (${c.domain})\nHomepage text:\n${site.text.slice(0, 5000)}\n\nReturn {"fits": boolean, "quote": string, "reason": string}`,
    check: (v) => (typeof v?.fits !== 'boolean' ? 'fits must be boolean' : null),
  });
  const quoted = fit.fits && quoteOnPage(fit.quote, site.text);
  checks.push({ name: 'fits the profile', ok: quoted, note: quoted ? `"${fit.quote}"` : fit.fits ? 'claimed fit, but the quote is not on the page' : fit.reason });
  if (!quoted) return drop(fit.fits ? 'fit quote not found on their site' : `not a fit: ${fit.reason}`);

  // Records angle: who to contact. Broaden the titles once if the exact ones find nobody.
  let people = (await peopleAt({ domain: c.domain, titles: intake.titles, limit: 5 })).profiles ?? [];
  if (!people.length) {
    say(`No ${intake.titles.join('/')} at ${c.name}; trying senior titles`, 'recover');
    people = (await peopleAt({ domain: c.domain, titles: BROAD_TITLES, limit: 5 })).profiles ?? [];
  }
  const ranked = people.map(personOf).filter((p) => p.name);
  const order = [...intake.titles, ...BROAD_TITLES].map((t) => t.toLowerCase());
  ranked.sort((a, b) => rank(a.title, order) - rank(b.title, order));
  // The contact must hold one of the asked-for roles, or be a founder/C-level stand-in.
  const person = ranked.find((p) => rank(p.title, order) < 99);
  checks.push({ name: 'contact in the database', ok: !!person, note: person ? `${person.name}, ${person.title}` : ranked.length ? `only ${ranked[0].title}; not the role asked for` : 'nobody senior found' });
  if (!person) return drop(ranked.length ? `no one in the right role (closest: ${ranked[0].title})` : 'no contact found');

  // Field angle 2: does the open web agree this person is there now?
  const hits = await webSearch(`"${person.name}" ${c.name}`).catch(() => []);
  const last = person.name.split(/\s+/).pop()!.toLowerCase();
  const brand = c.name.toLowerCase().split(/\s+/)[0];
  const mentions = hits.filter((h) => `${h.title} ${h.snippet}`.toLowerCase().includes(last) && `${h.title} ${h.snippet} ${h.url}`.toLowerCase().includes(brand));
  const left = mentions.find((h) => new RegExp(`(former|ex-|previously|left|departed|stepped down)[^.]{0,40}${escape(brand)}|${escape(brand)}[^.]{0,40}(former|alum)`, 'i').test(`${h.title} ${h.snippet}`));
  checks.push({
    name: 'person on the web',
    ok: mentions.length > 0 && !left,
    note: left ? `web says they left: "${left.snippet.slice(0, 120)}"` : mentions.length ? `${mentions.length} page${mentions.length > 1 ? 's' : ''} link them to ${c.name}` : 'database only; no web confirmation',
  });
  if (left) return drop(`${person.name} appears to have left ${c.name}`);

  return {
    company: c,
    person: { name: person.name, title: person.title, profileUrl: person.profileUrl, since: person.since },
    fit: fit.reason,
    checks,
    status: 'verified',
  };
}

const FILLER = new Set(['of', 'and', 'the', '&', 'for', 'at']);
const toks = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w));

/** Position of the first wanted title whose every word is a whole word in this title ("CTO" no longer matches "Director"). */
function rank(title: string, order: string[]) {
  const t = new Set(toks(title));
  const i = order.findIndex((o) => {
    const w = toks(o);
    return w.length > 0 && w.every((x) => t.has(x) || (x === 'founder' && t.has('cofounder')));
  });
  return i < 0 ? 99 : i;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toCsv(leads: Lead[]) {
  const rows = [['company', 'domain', 'contact', 'title', 'profile', 'fit', 'web_confirmed']];
  for (const l of leads) rows.push([l.company.name, l.company.domain, l.person?.name ?? '', l.person?.title ?? '', l.person?.profileUrl ?? '', l.fit, String(!!l.checks.find((c) => c.name === 'person on the web')?.ok)]);
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

/** Does the domain resolve at all? Dead companies' domains often don't. */
async function resolves(domain: string) {
  const t = new Promise<boolean>((r) => setTimeout(() => r(true), 4000)); // slow DNS: give it the benefit of the doubt
  const look = Promise.any([resolve4(domain), resolve4(`www.${domain}`), resolve6(domain)]).then(
    () => true,
    () => false,
  );
  return Promise.race([look, t]);
}
