// Pitch deck: ten slides from a founder's notes. The analyst finds the story and the numbers (only the ones
// given), the writer writes each slide, the illustrator sets the look and paints two pictures, the producer
// builds the deck (arrows to move, print to save as PDF), and the auditor checks no number was made up.
import type { Job } from '../job.ts';
import { llmJson } from '../tools.ts';
import { asFile, direct, esc } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'company', label: 'Company', hint: 'Bincard' },
  { key: 'what', label: 'What it does, in a sentence', hint: 'A store-room app for building sites in Nigeria: every bag of cement in and out, tracked from a phone' },
  { key: 'notes', label: 'Everything else: the problem, customers, numbers, team, the ask', hint: 'Sites lose 8-15% of materials to theft and waste (our survey of 40 sites). 12 sites using it in Lagos. ₦25k per site per month. Two founders: an engineer and a QS. Raising $150k pre-seed.', long: true },
  { key: 'audience', label: 'Who will see it', hint: 'Angel investors', optional: true },
];

type Slide = { kind: 'title' | 'problem' | 'solution' | 'how' | 'who' | 'market' | 'model' | 'traction' | 'team' | 'ask'; title: string; points: string[]; big?: string; note?: string };
type Plan = { story: string; numbers: { value: string; label: string }[]; missing: string[] };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  job.log('analyst', 'start', 'Finding the story and the numbers');
  const plan = await llmJson<Plan>(job, 'analyst', {
    reason: 'deck storyline',
    system: 'You prepare pitch decks. From the founder\'s notes, write the story in one sentence (who hurts, what changes, why now), list every number the notes give exactly as given with a short label, and list what an investor will ask that the notes don\'t answer. Never invent a number. JSON {"story","numbers":[{"value","label"}],"missing":[short strings]}.',
    prompt: brief,
    dry: () => JSON.stringify({ story: `${input.company}: ${input.what}`, numbers: (input.notes.match(/[₦$]?\d[\d,.]*\s?[%kKmM]?/g) ?? []).slice(0, 4).map((v) => ({ value: v, label: 'from the notes' })), missing: ['Market size', 'Competition'] }),
    maxTokens: 700,
  });
  job.log('analyst', 'done', plan.story);

  job.log('writer', 'start', 'Writing ten slides');
  const deck = await llmJson<{ slides: Slide[] }>(job, 'writer', {
    reason: 'deck slides',
    system: 'Write a 10-slide pitch deck, in this order: title, problem, solution, how (how it works, 3 steps), who (the customer), market, model (how it makes money), traction, team, ask. Each slide: a title that is a full claim (not a label like "Problem"), up to 3 short points (under 12 words each), and optionally "big": one number or short phrase to show huge, taken from the notes. Use only facts and numbers from the notes; where the notes have nothing (often market), write what the founders will show and put "note": "To fill in: ..." instead of inventing. JSON {"slides":[{"kind","title","points":[...],"big","note"}x10]}.',
    prompt: `${brief}\n\nStory: ${plan.story}\nNumbers you may use: ${JSON.stringify(plan.numbers)}`,
    dry: () => JSON.stringify({ slides: ['title', 'problem', 'solution', 'how', 'who', 'market', 'model', 'traction', 'team', 'ask'].map((kind, i) => ({ kind, title: i === 0 ? input.company : `${input.company} ${kind}`, points: [input.what], big: plan.numbers[i]?.value })) }),
    maxTokens: 1800,
  });
  const slides = (deck.slides ?? []).slice(0, 10);
  job.log('writer', 'done', `${slides.length} slides`);

  const art = await direct(job, `${brief}\nA pitch deck for ${input.audience || 'investors'}`, 'pitch deck', {
    palette: { bg: '#F7F5F0', ink: '#14171F', accent: '#2F5BEA', soft: '#E6ECFB' }, font: 'Space Grotesk',
    image: `A real-world photo of the problem ${input.company} solves: ${input.what}`,
  });
  const cover = asFile(art.image, 'cover');

  job.log('producer', 'start', 'Building the deck');
  const html = build(input.company, slides, art.palette, art.font, cover.ref);
  job.log('producer', 'done', `${slides.length} slides, printable to PDF`);

  const check = await audit(job, brief, slides.map((s, i) => `${i + 1}. ${s.title}${s.big ? ` [${s.big}]` : ''}\n- ${s.points.join('\n- ')}${s.note ? `\n(${s.note})` : ''}`).join('\n') + '\n\nFail it if any number or claim is not in the notes.');
  return {
    summary: `A 10-slide pitch deck for ${input.company}, with the story found, every slide written, a look and a cover photo, and the gaps an investor will ask about listed.`,
    check, site: { path: `/sites/${job.orderId}/`, html }, files: cover.file ? [cover.file] : [],
    doc: { title: `${input.company}: what investors will ask`, markdown: [`**The story:** ${plan.story}`, '**Numbers used:**', ...plan.numbers.map((n) => `- ${n.value}: ${n.label}`), '**Not in your notes yet:**', ...plan.missing.map((m) => `- ${m}`)].join('\n') },
  };
}

function build(company: string, slides: Slide[], p: { bg: string; ink: string; accent: string; soft: string }, font: string, cover: string) {
  const f = font.replace(/ /g, '+');
  const one = (s: Slide, i: number) => {
    const n = `<span class="n">${String(i + 1).padStart(2, '0')}</span>`;
    if (s.kind === 'title' || i === 0) return `<section class="s t" style="background-image:linear-gradient(90deg,${p.ink} 30%,transparent),url('${cover}')"><div><small>${esc(company)}</small><h1>${esc(s.title)}</h1>${s.points[0] ? `<p>${esc(s.points[0])}</p>` : ''}</div></section>`;
    if (s.kind === 'how') return `<section class="s">${n}<h2>${esc(s.title)}</h2><ol class="steps">${s.points.map((x, k) => `<li><b>${k + 1}</b>${esc(x)}</li>`).join('')}</ol>${s.note ? `<p class="todo">${esc(s.note)}</p>` : ''}</section>`;
    return `<section class="s${s.big ? ' big' : ''}">${n}<div class="l"><h2>${esc(s.title)}</h2><ul>${s.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${s.note ? `<p class="todo">${esc(s.note)}</p>` : ''}</div>${s.big ? `<div class="r"><div class="bn" style="font-size:${s.big.length > 22 ? 3.6 : s.big.length > 12 ? 5 : 7}cqw">${esc(s.big)}</div></div>` : ''}</section>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(company)} · Pitch deck</title>
<link href="https://fonts.googleapis.com/css2?family=${f}:wght@500;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:${p.bg};--ink:${p.ink};--a:${p.accent};--soft:${p.soft}}
*{box-sizing:border-box;margin:0}html,body{height:100%}body{background:#111;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;overflow:hidden}
.deck{width:min(96vw,calc(92vh*16/9));aspect-ratio:16/9;position:relative;container-type:inline-size}
.s{position:absolute;inset:0;background:var(--bg);color:var(--ink);padding:7cqw 8cqw;display:flex;gap:5cqw;align-items:center;opacity:0;transition:opacity .35s;border-radius:1cqw;overflow:hidden}
.s.on{opacity:1}.n{position:absolute;top:4cqw;left:8cqw;font:600 1.1cqw Inter;color:var(--a);letter-spacing:.1em}
.l{flex:1.3}.r{flex:1;display:grid;place-items:center;align-self:stretch;background:var(--soft);border-radius:1.5cqw}
h1{font:700 6cqw/1.02 '${font}',sans-serif;letter-spacing:-.02em;max-width:16ch}h2{font:700 3.6cqw/1.08 '${font}',sans-serif;letter-spacing:-.02em;margin-bottom:3cqw;max-width:22ch}
ul{list-style:none;padding:0}li{font-size:1.9cqw;line-height:1.35;padding:1cqw 0;border-top:1px solid color-mix(in srgb,var(--ink) 14%,transparent)}
.bn{font:700 7cqw/1 '${font}',sans-serif;color:var(--a);letter-spacing:-.03em;text-align:center;padding:2cqw}
.t{background-size:cover;background-position:center;color:#fff}.t small{font:600 1.3cqw Inter;letter-spacing:.12em;text-transform:uppercase;opacity:.8}.t p{font-size:2cqw;margin-top:2cqw;max-width:40ch;opacity:.9}
.s:not(.big):not(.t){flex-direction:column;align-items:flex-start;justify-content:center}
.steps{list-style:none;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:2cqw;width:100%}.steps li{border:0;background:var(--soft);border-radius:1.5cqw;padding:2.4cqw;font-size:1.8cqw}.steps b{display:block;font:700 4cqw '${font}';color:var(--a);margin-bottom:1cqw}
.todo{margin-top:2cqw;font-size:1.3cqw;padding:1cqw 1.4cqw;border-radius:.8cqw;background:#FFF3C4;color:#5A4500;display:inline-block}
nav{position:fixed;bottom:12px;color:#aaa;font:500 13px Inter}
@media print{@page{size:1600px 900px;margin:0}body{background:none;display:block;overflow:visible}.deck{width:1600px;aspect-ratio:auto}.s{position:relative;opacity:1;width:1600px;height:900px;border-radius:0;page-break-after:always}nav{display:none}}
</style></head><body>
<div class="deck" id="d">${slides.map(one).join('\n')}</div>
<nav><span id="pg"></span> · arrows to move · print to save a PDF</nav>
<script>
const s=[...document.querySelectorAll('.s')];let i=0;const pg=document.getElementById('pg');
function go(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach((e,j)=>e.classList.toggle('on',j===i));pg.textContent=(i+1)+' / '+s.length}
addEventListener('keydown',e=>{if(['ArrowRight',' ','PageDown'].includes(e.key))go(i+1);if(['ArrowLeft','PageUp'].includes(e.key))go(i-1)});
document.getElementById('d').onclick=e=>go(e.clientX>innerWidth/2?i+1:i-1);go(0);
</script></body></html>`;
}

export const deck: Service = {
  id: 'pitch-deck', name: 'Pitch deck', priceUsd: 5,
  blurb: 'Ten slides from your notes: the story found, every slide written, designed with a cover photo, and no number made up.',
  team: ['analyst', 'writer', 'illustrator', 'producer', 'auditor'],
  fields,
  example: { company: 'Bincard', what: 'A store-room app for building sites in Nigeria: every bag of cement in and out, tracked from a phone', notes: 'Sites lose 8-15% of materials to theft and waste (our survey of 40 sites). 12 sites using it in Lagos since September. ₦25k per site per month. Two founders: a site engineer and a quantity surveyor. Raising $150k pre-seed for 18 months to reach 200 sites.', audience: 'Angel investors' },
  run,
};
