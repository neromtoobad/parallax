import { span } from 'neatlogs';
import { env, chaos } from './env.ts';
import { assertBudget, charge, Permanent, say } from './context.ts';

const BASE = 'https://api.crustdata.com';

export class CrustError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * One Crustdata call. Bills credits from the X-Credits-Used header, retries 429/5xx and network
 * errors with backoff, and treats other 4xx as permanent (retrying a bad request just burns time).
 */
async function call<T>(path: string, body: unknown, estCredits = 1): Promise<T> {
  assertBudget();
  if (!env.crustKey) throw new Permanent('CRUSTDATA_API_KEY is not set');
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      if (chaos('crust')) throw new CrustError(503, `injected fault on ${path}`);
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.crustKey}`,
          'content-type': 'application/json',
          'x-api-version': '2025-11-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const used = Number(res.headers.get('x-credits-used') ?? (res.ok ? estCredits : 0));
      if (used) charge({ credits: used });
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 200);
        try {
          const j = JSON.parse(text);
          msg = j.error?.message ?? j.description ?? j.reason ?? (typeof j.error === 'string' ? j.error : msg);
        } catch {}
        throw new CrustError(res.status, `${path} ${res.status}: ${msg}`);
      }
      return JSON.parse(text) as T;
    } catch (err) {
      const status = err instanceof CrustError ? err.status : 0; // 0 = network/timeout
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable) throw new Permanent((err as Error).message);
      if (attempt >= 4) throw err;
      const wait = status === 429 ? 6000 * attempt : 700 * 2 ** attempt;
      say(`Crustdata ${path} ${status || 'network error'}; retry ${attempt} in ${(wait / 1000).toFixed(1)}s`, 'retry');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const tool = <A extends any[], R>(name: string, fn: (...a: A) => Promise<R>) => span({ kind: 'TOOL', toolName: name, name }, fn);

// ---- Company -------------------------------------------------------------------------------

export const COMPANY_FIELDS = [
  'basic_info.name',
  'basic_info.primary_domain',
  'basic_info.website',
  'basic_info.description',
  'basic_info.year_founded',
  'basic_info.employee_count_range',
  'taxonomy.professional_network_industry',
  'headcount.total',
  'locations.headquarters',
  'locations.country',
];

export const FUNDING_FIELDS = ['funding.total_investment_usd', 'funding.last_round_type', 'funding.last_fundraise_date'];

export const companySearch = tool('crustdata.company_search', async (q: { query: string; country?: string; minStaff?: number | null; maxStaff?: number | null; limit?: number; cursor?: string; fields?: string[]; mode?: 'hybrid' | 'semantic' | 'lexical' }) => {
  const body: any = { search: { query: q.query, mode: q.mode ?? 'hybrid' }, fields: q.fields ?? COMPANY_FIELDS, limit: q.limit ?? 10 };
  const conds: any[] = [];
  if (q.country) conds.push({ field: 'locations.country', type: 'in', value: countryNames(q.country) });
  if (q.minStaff) conds.push({ field: 'headcount.total', type: '=>', value: Math.floor(q.minStaff * 0.8) });
  if (q.maxStaff) conds.push({ field: 'headcount.total', type: '=<', value: Math.ceil(q.maxStaff * 1.25) });
  if (conds.length) body.filters = conds.length === 1 ? conds[0] : { op: 'and', conditions: conds };
  if (q.cursor) body.cursor = q.cursor;
  return call<{ companies: any[]; next_cursor: string | null }>('/company/search', body, 0.5);
});

/** The database spells countries several ways ("United States", "USA", ...); match them all. */
const COUNTRY_ALIASES: string[][] = [
  ['United States', 'USA', 'United States of America', 'US'],
  ['United Kingdom', 'UK', 'GBR', 'Great Britain'],
  ['United Arab Emirates', 'UAE', 'ARE'],
  ['Nigeria', 'NGA'],
  ['Kenya', 'KEN'],
  ['South Africa', 'ZAF'],
  ['Ghana', 'GHA'],
  ['India', 'IND'],
  ['Germany', 'DEU'],
  ['France', 'FRA'],
  ['Canada', 'CAN'],
];
export function countryNames(c: string) {
  const hit = COUNTRY_ALIASES.find((g) => g.some((x) => x.toLowerCase() === c.trim().toLowerCase()));
  return hit ?? [c.trim()];
}

export const companyEnrich = tool('crustdata.company_enrich', async (domain: string) => {
  const res = await call<any[]>('/company/enrich', { domains: [domain], fields: ['basic_info', 'headcount', 'funding', 'locations', 'hiring'] }, 2);
  return res?.[0]?.matches?.[0]?.company_data ?? null;
});

// ---- People --------------------------------------------------------------------------------

export const PERSON_FIELDS = [
  'basic_profile.name',
  'basic_profile.headline',
  'basic_profile.location',
  'social_handles.professional_network_identifier.profile_url',
  'experience.employment_details.current',
];

export const peopleAt = tool('crustdata.person_search', async (q: { domain: string; titles: string[]; limit?: number; functions?: string[]; seniority?: string[] }) => {
  // "VP Engineering" should find "VP of Engineering": every word of a title must appear, in any order.
  const titleConds = q.titles.map((t) => {
    const words = t.split(/[\s,&/]+/).filter((w) => w.length > 1 && !/^(of|and|the|for)$/i.test(w));
    const conds = words.map((w) => ({ field: 'experience.employment_details.current.title', type: '(.)', value: w }));
    return conds.length === 1 ? conds[0] : { op: 'and', conditions: conds };
  });
  // A function (e.g. "Human Resources") at a senior level also counts, for titles nobody thought to list.
  if (q.functions?.length) {
    const fn: any[] = [{ field: 'experience.employment_details.current.function_category', type: 'in', value: q.functions }];
    if (q.seniority?.length) fn.push({ field: 'experience.employment_details.current.seniority_level', type: 'in', value: q.seniority });
    titleConds.push(fn.length === 1 ? fn[0] : { op: 'and', conditions: fn });
  }
  const body = {
    filters: {
      op: 'and',
      conditions: [
        { field: 'experience.employment_details.current.company_website_domain', type: '=', value: q.domain },
        titleConds.length === 1 ? titleConds[0] : { op: 'or', conditions: titleConds },
      ],
    },
    fields: PERSON_FIELDS,
    limit: q.limit ?? 5,
  };
  return call<{ profiles: any[] }>('/person/search', body, 0.3);
});

/** Any person search: the caller builds the filters (name lookups, past employers). */
export const personSearch = tool('crustdata.person_search', async (filters: any, opts: { fields?: string[]; limit?: number } = {}) =>
  call<{ profiles: any[] }>('/person/search', { filters, fields: opts.fields ?? PERSON_FIELDS, limit: opts.limit ?? 5 }, 0.3),
);

// ---- Web -----------------------------------------------------------------------------------

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export const webSearch = tool('crustdata.web_search', async (query: string, sources: string[] = ['web']) => {
  const res = await call<{ results: WebResult[] }>('/web/search/live', { query, sources }, 1);
  return (res.results ?? []).slice(0, 8);
});

export const webFetch = tool('crustdata.web_fetch', async (urls: string[], humanMode = false) => {
  const res = await call<{ success: boolean; url: string | null; title: string | null; content: string | null }[]>(
    '/web/enrich/live',
    { urls: urls.slice(0, 10), ...(humanMode ? { human_mode: true } : {}) },
    urls.length,
  );
  return res.map((r, i) => ({ url: r.url ?? urls[i], ok: r.success && !!r.content, title: r.title ?? '', text: r.content ? htmlToText(r.content) : '' }));
});

/** Strip a page down to readable text, so models read content and quotes can be checked. */
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, 40_000);
}

// ---- Free first, paid second ------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Fetch a page ourselves. Costs nothing; fails on bot walls and dead sites. */
export const directFetch = tool('web.direct_fetch', async (url: string) => {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return { url, ok: false, title: '', text: '' };
    const html = (await res.text()).slice(0, 2_000_000);
    return { url: res.url || url, ok: true, title: html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() ?? '', text: htmlToText(html) };
  } catch {
    return { url, ok: false, title: '', text: '' };
  }
});

/** A bot-check or empty shell isn't a page. */
export function usablePage(p?: { ok: boolean; text: string }) {
  if (!p?.ok || p.text.length < 400) return false;
  return !/checking your browser|just a moment|enable javascript and cookies|verify you are human|attention required|access denied/i.test(p.text.slice(0, 1500));
}

/** Read pages: our own fetch first (free), Crustdata only for the ones that didn't come back usable. */
export async function readPages(urls: string[], opts: { humanRetry?: boolean } = {}) {
  const first = await Promise.all(urls.map((u) => directFetch(u)));
  const missing = urls.filter((_, i) => !usablePage(first[i]));
  const out = new Map(urls.map((u, i) => [u, first[i]]));
  if (missing.length) {
    const paid = await webFetch(missing).catch(() => missing.map((u) => ({ url: u, ok: false, title: '', text: '' })));
    paid.forEach((p, i) => out.set(missing[i], p));
    if (opts.humanRetry) {
      const still = missing.filter((u) => !usablePage(out.get(u)));
      if (still.length) {
        say(`${still.length} page${still.length > 1 ? 's' : ''} still blocked; retrying as a browser`, 'recover');
        const human = await webFetch(still, true).catch(() => []);
        human.forEach((p, i) => out.set(still[i], p));
      }
    }
  }
  return urls.map((u) => out.get(u)!).map((p) => ({ ...p, ok: usablePage(p) }));
}
