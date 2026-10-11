/**
 * Compare two eval runs:  node scripts/compare.ts v1 v2  → prints markdown, writes evals/<a>-vs-<b>.md
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BRIEFS } from '../evals/cases.ts';
import { goldScore } from '../evals/score.ts';
import { join } from 'node:path';

const [a, b] = process.argv.slice(2);
const dir = join(import.meta.dirname, '../evals');
// Gold scores are recomputed from the saved jobs with the current gold set, so a gold correction
// applies to every run alike.
const load = (l: string) =>
  (JSON.parse(readFileSync(join(dir, 'results', `${l}.json`), 'utf8')).rows as any[]).map((r) => {
    const c = BRIEFS.find((b) => b.id === r.case);
    const file = join(dir, '../../data/jobs', `${r.jobId}.json`);
    if (r.service !== 'company-brief' || !c || !existsSync(file)) return r;
    const g = goldScore(c, JSON.parse(readFileSync(file, 'utf8')).result?.facts ?? []);
    return { ...r, goldRight: g.filter((x) => x === 'right').length, goldWrong: g.filter((x) => x === 'wrong').length };
  });
const A = load(a), B = load(b);

const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const avg = (rows: any[], k: string) => (rows.length ? sum(rows, k) / rows.length : 0);
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');

function briefStats(rows: any[]) {
  const r = rows.filter((x) => x.service === 'company-brief');
  return {
    jobs: r.length,
    delivered: r.filter((x) => x.status === 'delivered').length,
    'facts verified': pct(sum(r, 'verified'), sum(r, 'facts')),
    'facts seen from both angles': pct(sum(r, 'twoAngle'), sum(r, 'facts')),
    'gold facts right': `${sum(r, 'goldRight')}/${r.length * 2}`,
    'gold facts wrong': `${sum(r, 'goldWrong')}`,
    'brief points with guesswork': pct(sum(r, 'hedgedPoints'), sum(r, 'points')),
    'avg cost per brief': `$${avg(r, 'costUsd').toFixed(4)}`,
    'avg seconds': avg(r, 'secs').toFixed(0),
    'avg model calls': avg(r, 'llmCalls').toFixed(1),
  };
}

function leadStats(rows: any[]) {
  const r = rows.filter((x) => x.service === 'lead-list');
  return {
    jobs: r.length,
    'leads delivered / wanted': `${sum(r, 'verified')}/${sum(r, 'wanted')}`,
    'leads confirmed by both angles': pct(sum(r, 'twoSource'), sum(r, 'verified')),
    'candidates checked per lead': (sum(r, 'checked') / Math.max(1, sum(r, 'verified'))).toFixed(1),
    'cost per delivered lead': `$${(sum(r, 'costUsd') / Math.max(1, sum(r, 'verified'))).toFixed(4)}`,
    'avg seconds': avg(r, 'secs').toFixed(0),
  };
}

function table(title: string, x: Record<string, any>, y: Record<string, any>) {
  const lines = [`### ${title}`, '', `| metric | ${a} | ${b} |`, '| --- | --- | --- |'];
  for (const k of Object.keys(x)) lines.push(`| ${k} | ${x[k]} | ${y[k]} |`);
  return lines.join('\n');
}

const md = [
  `## Eval: ${a} vs ${b}`,
  '',
  table('Company briefs', briefStats(A), briefStats(B)),
  '',
  table('Lead lists', leadStats(A), leadStats(B)),
  '',
  '### Traces',
  '',
  ...[...A.map((r) => ({ ...r, l: a })), ...B.map((r) => ({ ...r, l: b }))].map((r) => `- ${r.l} ${r.service} ${r.case}: ${r.status}, $${Number(r.costUsd).toFixed(4)}, trace ${r.traces?.at(-1)}`),
].join('\n');

console.log(md);
writeFileSync(join(dir, `${a}-vs-${b}.md`), md + '\n');
