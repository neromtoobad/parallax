/** Plain-code comparison of two values for the same fact. No model involved: agreement must be checkable. */

export type Kind = 'year' | 'count' | 'money' | 'place' | 'person' | 'round' | 'text';

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(billion|bn|b|million|mm|m|thousand|k)?\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = { billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mm: 1e6, m: 1e6, thousand: 1e3, k: 1e3 }[m[2] ?? ''] ?? 1;
  return n * mult;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

const STOP = new Set(['inc', 'the', 'and', 'of', 'llc', 'ltd', 'usa', 'united', 'states', 'america']);

export function same(kind: Kind, a: unknown, b: unknown): boolean {
  if (a == null || b == null || a === '' || b === '') return false;
  switch (kind) {
    case 'year':
      return num(a) === num(b);
    case 'count': {
      const x = num(a), y = num(b);
      if (x == null || y == null) return false;
      return Math.abs(x - y) / Math.max(x, y) <= 0.3; // headcounts drift; 30% is the same company size
    }
    case 'money': {
      const x = num(a), y = num(b);
      if (x == null || y == null) return false;
      return Math.abs(x - y) / Math.max(x, y) <= 0.2;
    }
    case 'round':
      return roundType(String(a)) === roundType(String(b)) && roundType(String(a)) !== '';
    case 'person': {
      const wa = words(String(a)), wb = words(String(b));
      return wa.length > 0 && wb.length > 0 && wa[wa.length - 1] === wb[wb.length - 1];
    }
    case 'place': {
      const wa = words(String(a)).filter((w) => !STOP.has(w)), wb = new Set(words(String(b)).filter((w) => !STOP.has(w)));
      return wa.some((w) => wb.has(w));
    }
    default:
      return true; // free text: both present counts as agreement; the verifier checks each on its own
  }
}

export function roundType(s: string) {
  const t = s.toLowerCase();
  const m = t.match(/series\s*([a-h])\b/) ?? t.match(/\b(seed|pre-seed|ipo|angel|debt|grant|private equity|acquired|secondary)\b/);
  if (!m) return '';
  return m[0].startsWith('series') ? `series ${m[1]}` : m[1];
}

const squash = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}$%.' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Does `quote` appear on the page? Exact after normalising, or 90% of its words in one window. */
export function quoteOnPage(quote: string, page: string): boolean {
  const q = squash(quote), p = squash(page);
  if (!q || q.length < 8) return false;
  if (p.includes(q)) return true;
  const qw = q.split(' ');
  if (qw.length < 5) return false;
  const pw = p.split(' ');
  const need = Math.ceil(qw.length * 0.9);
  const qs = new Set(qw);
  for (let i = 0; i + qw.length <= pw.length; i += Math.max(1, Math.floor(qw.length / 4))) {
    let hit = 0;
    for (let j = i; j < i + qw.length + 3 && j < pw.length; j++) if (qs.has(pw[j])) hit++;
    if (hit >= need) return true;
  }
  return false;
}

/** Does the quote actually say the value? */
export function quoteSupports(kind: Kind, value: unknown, quote: string): boolean {
  if (value == null) return false;
  const q = quote.toLowerCase();
  switch (kind) {
    case 'year':
      return q.includes(String(num(value)));
    case 'count':
    case 'money': {
      const v = num(value);
      if (v == null) return false;
      const found = [...q.replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)\s*(billion|bn|b|million|mm|m|thousand|k)?\b/g)].map((m) => num(m[0]));
      return found.some((f) => f != null && Math.abs(f - v) / Math.max(f, v) <= 0.1);
    }
    case 'round':
      return roundType(q) === roundType(String(value));
    case 'person': {
      const v = words(String(value));
      return v.length > 0 && words(quote).includes(v[v.length - 1]);
    }
    case 'place': {
      const qw = new Set(words(quote));
      return words(String(value)).some((w) => !STOP.has(w) && qw.has(w));
    }
    default:
      return true;
  }
}
