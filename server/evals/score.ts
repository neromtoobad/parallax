import type { BriefCase } from './cases.ts';

/** Gold check for a delivered brief: right, wrong, or missing for founding year and CEO. */
export function goldScore(c: BriefCase, facts: any[]) {
  const fact = (k: string) => facts.find((f) => f.key === k);
  const founded = fact('founded');
  const ceo = fact('ceo');
  const golds = (Array.isArray(c.gold.ceo) ? c.gold.ceo : [c.gold.ceo]).map((n) => n.split(' ').pop()!.toLowerCase());
  return [
    founded?.verified && founded.value != null ? (Number(String(founded.value).match(/\d{4}/)?.[0]) === c.gold.founded ? 'right' : 'wrong') : 'missing',
    ceo?.verified && ceo.value ? (golds.some((g) => String(ceo.value).toLowerCase().includes(g)) ? 'right' : 'wrong') : 'missing',
  ];
}
