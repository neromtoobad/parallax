// A sub-job: an agent that has won a part hires another to check its draft before it hands the part in
// (subjobs.ts). It isn't on the menu. The winner of its one lot reads the draft claim by claim and lists what
// is wrong, unsupported or likely to mislead, each with a fix; the agent that hired it revises from that.
import type { Job } from '../job.ts';
import { llmJson } from '../tools.ts';
import type { Field, Service } from './index.ts';

export const fields: Field[] = [
  { key: 'title', label: 'Draft', hint: 'The piece to check' },
  { key: 'brief', label: 'What it was written for', long: true },
  { key: 'draft', label: 'The draft', long: true },
];

export type Issue = { claim: string; problem: string; fix: string };

async function run(job: Job, input: Record<string, string>) {
  job.log('investigator', 'start', 'Checking the draft claim by claim');
  const r = await llmJson<{ issues: Issue[]; verdict: string }>(job, 'investigator', {
    reason: 'fact check, hired by another agent',
    system: 'You fact-check drafts at Parallax, a company of AI agents; another agent hired you, from its own balance, to check its draft before it hands it in. List the claims, figures and advice that are wrong, unsupported, out of date or likely to mislead the reader, each with what is wrong and the fix. A figure the draft marks as an estimate is fine when the range is plausible; say so only when it is not. Leave out matters of style. At most 8 issues, the most important first. JSON {"issues":[{"claim","problem","fix"}],"verdict":"one sentence on how sound the draft is"}.',
    prompt: `What the draft was written for:\n${input.brief}\n\nThe draft, "${input.title}":\n${input.draft}`,
    dry: () => JSON.stringify({ issues: [{ claim: '(demo) a figure', problem: 'not marked as an estimate', fix: 'say it is an estimate to check' }], verdict: '(demo) sound' }),
    maxTokens: 1600,
  });
  const issues = (r.issues ?? []).filter((i) => i?.claim && i?.fix).slice(0, 8).map((i) => ({ claim: String(i.claim).slice(0, 300), problem: String(i.problem ?? '').slice(0, 300), fix: String(i.fix).slice(0, 300) }));
  job.log('investigator', 'done', `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix: ${String(r.verdict ?? '').slice(0, 160)}`);
  return {
    summary: `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix in "${input.title}". ${String(r.verdict ?? '').slice(0, 200)}`,
    check: { pass: true, notes: [] },
    factcheck: { issues, verdict: String(r.verdict ?? '').slice(0, 300) },
  };
}

export const factcheck: Service = {
  id: 'factcheck', name: 'Fact check', priceUsd: 0,
  blurb: 'Hired by an agent for its own part: a claim-by-claim check of its draft.',
  team: ['investigator', 'reader'],
  fields,
  example: { title: 'A one-page guide', brief: 'A guide for a small business owner', draft: '…' },
  run,
};
