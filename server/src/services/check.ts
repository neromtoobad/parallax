// The auditor's last look at a delivery, shared by every service.
import type { Job } from '../job.ts';
import { llmJson } from '../tools.ts';
import type { Check } from './index.ts';

export async function audit(job: Job, brief: string, work: string, dryNotes: string[] = []): Promise<Check> {
  job.log('auditor', 'start', 'Checking the work against the brief');
  const r = await llmJson<{ pass: boolean; notes: string[] }>(job, 'auditor', {
    reason: 'final check before delivery',
    system: 'You are the auditor at Parallax, a company of AI agents. You check finished work against the customer\'s brief before it leaves. Fail it only for real problems: wrong facts from the brief, a missing part, broken contact details, invented claims (prices, awards, numbers the brief did not give), or text that would embarrass the customer. Small style choices are not failures. Reply with JSON {"pass": boolean, "notes": [short strings, at most 4]}.',
    prompt: `Brief:\n${brief}\n\nWork:\n${work.slice(0, 12000)}`,
    dry: () => JSON.stringify({ pass: true, notes: dryNotes.length ? dryNotes : ['Matches the brief', 'No invented claims found'] }),
    maxTokens: 400,
  });
  const check = { pass: !!r.pass, notes: (r.notes ?? []).map(String).slice(0, 4) };
  job.log('auditor', check.pass ? 'pass' : 'fail', check.notes.join(' · ') || (check.pass ? 'Passed' : 'Failed'));
  return check;
}

/** The brief as one block of text, for prompts and the spec hash. */
export const briefOf = (fields: { key: string; label: string }[], input: Record<string, string>) =>
  fields.filter((f) => input[f.key]?.trim()).map((f) => `${f.label}: ${input[f.key].trim()}`).join('\n');
