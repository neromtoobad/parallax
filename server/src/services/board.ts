// A job from the board: a customer's own brief, any research or writing task, done as one document.
// The research winner gathers what is known and what isn't, the writing winner turns it into the piece the
// brief asks for, and the auditor checks it against the brief. It isn't on the menu: it arrives through
// the bank (post:), and the CFO takes it only after the brief passes its screen (board.ts).
import type { Job } from '../job.ts';
import { canSearch, llmJson, search } from '../tools.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

export const fields: Field[] = [
  { key: 'title', label: 'Job', hint: 'A one-page market scan of bike repair in Lagos' },
  { key: 'brief', label: 'Brief', hint: 'What you want, who it is for, and what a good result looks like', long: true },
];

type Notes = { facts: string[]; unknowns: string[]; outline: string[]; queries?: string[] };
type Doc = { title: string; markdown: string };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  job.log('researcher', 'start', 'Reading the brief and gathering what is known');
  let notes = await llmJson<Notes>(job, 'researcher', {
    reason: 'research notes for a board job',
    system: 'You are the researcher at Parallax, a company of AI agents. A customer posted the brief below. Write research notes for the writer: facts you are confident of (each short, with no invented sources), what is uncertain or would need checking, and an outline of the piece the brief asks for. If the brief asks for prices, rates or other figures, give the typical range you know as a fact starting "Estimate:", so the writer can use it as a range to check rather than leave it out. If a web search would help, give up to 3 queries. JSON {"facts":[...],"unknowns":[...],"outline":[...],"queries":[...]}.',
    prompt: brief,
    dry: () => JSON.stringify({ facts: [`The brief asks for: ${input.title}`], unknowns: ['Local figures would need checking'], outline: ['Summary', 'What we found', 'What to do next'], queries: [] }),
    maxTokens: 1800,
  });
  if (canSearch() && notes.queries?.length) {
    const hits = (await Promise.all(notes.queries.slice(0, 3).map((q) => search(job, 'researcher', q, 'board research', 4)))).flat();
    if (hits.length) notes = { ...notes, facts: [...notes.facts, ...hits.slice(0, 8).map((h) => `${h.title}: ${h.snippet} (${h.link})`)] };
  }
  job.log('researcher', 'done', `${notes.facts.length} facts, ${notes.unknowns.length} open questions, ${notes.outline.length} sections`);

  job.log('writer', 'start', 'Writing it up');
  const doc = await llmJson<Doc>(job, 'writer', {
    reason: 'the document for a board job',
    system: 'You are the writer at Parallax, a company of AI agents. Write the piece the customer\'s brief asks for, from the research notes, in Markdown: short sections with headings, plain words, at most about 900 words, and no longer than the brief asks ("one page" is about 450 words). The title goes in "title" only; the markdown starts with the first section. Use only facts from the notes or the brief. Answer every question the brief asks: where it asks for a price or a figure, give the range from the notes and say plainly that it is an estimate to check locally, rather than leaving it out. No links unless they are in the notes. JSON {"title","markdown"}.',
    prompt: `Brief:\n${brief}\n\nResearch notes:\n${JSON.stringify(notes)}`,
    dry: () => JSON.stringify({ title: input.title, markdown: `# ${input.title}\n\n${notes.outline.map((s) => `## ${s}\n\n(demo) A few lines on ${s.toLowerCase()}.`).join('\n\n')}` }),
    maxTokens: 3200,
  });
  // a model that puts the title in the markdown too would print it twice
  doc.markdown = doc.markdown.replace(/^\s*#\s+[^\n]*\n+/, (h) => (h.replace(/^\s*#\s+/, '').trim().toLowerCase() === doc.title.trim().toLowerCase() ? '' : h));
  const words = doc.markdown.split(/\s+/).filter(Boolean).length;
  job.log('writer', 'done', `"${doc.title}", ${words} words`);

  const check = await audit(job, brief, `# ${doc.title}\n\n${doc.markdown}`);
  return { summary: `${doc.title}: a ${words}-word document written for your brief, from research notes, and checked against it.`, check, doc };
}

export const board: Service = {
  id: 'board', name: 'Board job', priceUsd: 0,
  blurb: 'Any research or writing job you post on the board, with your own budget.',
  team: ['researcher', 'scout', 'reader', 'investigator', 'writer', 'analyst', 'auditor'],
  fields,
  example: { title: 'A one-page market scan of bike repair in Lagos', brief: 'I want to open a bike repair stand near Yaba. Who already does this, what do they charge, and what would make mine worth stopping at? One page I can read in five minutes.' },
  run,
};
