// Comic strip: four panels about a business, a moment or a joke, to post. The writer writes the strip (a setup,
// a turn, a punchline), the illustrator fixes each character's look and paints the panels in one style, the
// producer letters it (speech bubbles drawn on top, so the words are always spelled right), and the auditor checks.
import type { Job } from '../job.ts';
import { llmJson, picture } from '../tools.ts';
import { asFile, esc, placeholder } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'about', label: 'What the strip is about', hint: 'Our generator always dies the minute a customer sits in the barber chair', long: true },
  { key: 'who', label: 'Who is in it', hint: 'Tunde the barber (tall, bald, big smile), and a customer in a suit', long: true, optional: true },
  { key: 'for', label: 'Who it is for', hint: 'Our Instagram, to make customers laugh', optional: true },
  { key: 'style', label: 'Drawing style', hint: 'Bold ink lines and flat colour, like a newspaper strip', optional: true },
];

type Strip = { title: string; cast: { name: string; look: string }[]; panels: { scene: string; caption?: string; lines: { who: string; says: string }[] }[] };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  job.log('writer', 'start', 'Writing the strip');
  const strip = await llmJson<Strip>(job, 'writer', {
    reason: 'comic script',
    system: 'Write a four-panel comic strip. Panel 1 sets up, 2 and 3 build, 4 lands the joke or the warm turn. Kind humour, nobody mocked for who they are. At most two speech lines per panel, each under 12 words; an optional caption box under 8 words. List the cast (at most 3) with how each looks in one line (use what the brief gives). For each panel, the scene to draw: who, where, doing what, their expressions. JSON {"title","cast":[{"name","look"}],"panels":[4 x {"scene","caption","lines":[{"who","says"}]}]}.',
    prompt: brief,
    dry: () => JSON.stringify({
      title: 'Perfect timing', cast: [{ name: 'Tunde', look: 'tall bald barber, big smile, white tunic' }, { name: 'Customer', look: 'man in a grey suit' }],
      panels: [
        { scene: 'Tunde welcomes a customer into the barber chair', lines: [{ who: 'Tunde', says: 'Sit down, my brother. Fresh cut coming!' }] },
        { scene: 'The lights go out, the clippers stop', caption: 'Right on time', lines: [{ who: 'Customer', says: 'Again?!' }] },
        { scene: 'Tunde in the dark holding a phone torch and scissors', lines: [{ who: 'Tunde', says: 'No wahala. Old school.' }] },
        { scene: 'Customer admiring a perfect haircut in the mirror', lines: [{ who: 'Customer', says: 'Best cut I have ever had.' }, { who: 'Tunde', says: 'Thank NEPA.' }] },
      ],
    }),
    maxTokens: 1200,
  });
  const panels = (strip.panels ?? []).slice(0, 4);
  job.log('writer', 'done', `"${strip.title}"`);

  job.log('illustrator', 'start', 'Drawing the cast');
  const cast = (strip.cast ?? []).slice(0, 3);
  const style = input.style?.trim() || 'bold clean ink lines and flat bright colours, like a newspaper comic strip';
  const withCast = (sc: string) => cast.reduce((s, c) => s.replace(new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), `${c.name} (${c.look})`), sc);
  const pics = await Promise.all(panels.map((p, i) => picture(job, 'illustrator', {
    prompt: `Comic strip panel, ${style.split(',')[0]}. ${cast.map((c) => `${c.name}: ${c.look}`).join('; ')}. Scene: ${withCast(p.scene)}. Same characters every panel, clear faces, no speech bubbles, no text.`,
    reason: `panel ${i + 1}`, dry: () => placeholder({ bg: '#FFF7E6', ink: '#1B1B1B', accent: ['#E94F37', '#3F88C5', '#F6AE2D', '#44BBA4'][i], soft: '#FFE9C7' }),
  })));
  job.log('illustrator', 'done', `${pics.length} panels in one style`);

  job.log('producer', 'start', 'Lettering');
  const files = pics.map((p, i) => asFile(p, `panel-${i + 1}`));
  const html = letter(strip.title, panels, files.map((f) => f.ref));
  job.log('producer', 'done', 'Bubbles placed, ready to post');

  const check = await audit(job, brief, `Title: ${strip.title}\n${panels.map((p, i) => `Panel ${i + 1}: ${p.scene}${p.caption ? ` [${p.caption}]` : ''}\n${p.lines.map((l) => `  ${l.who}: ${l.says}`).join('\n')}`).join('\n')}\n\nAlso fail it if the joke is unkind about anyone's looks, tribe, religion or gender.`);
  return {
    summary: `"${strip.title}", a four-panel comic strip, written, drawn, lettered and checked.`,
    check, site: { path: `/sites/${job.orderId}/`, html }, files: files.flatMap((f) => (f.file ? [f.file] : [])),
  };
}

function letter(title: string, panels: Strip['panels'], pics: string[]) {
  const cell = (p: Strip['panels'][number], i: number) => {
    const bubbles = (p.lines ?? []).slice(0, 2).map((l, k) => {
      const left = (i + k) % 2 === 0;
      return `<div class="b ${left ? 'l' : 'r'}" style="top:${6 + k * 22}%"><b>${esc(l.who)}</b>${esc(l.says)}</div>`;
    }).join('');
    return `<figure><img src="${pics[i] ?? pics[0]}" alt="">${p.caption ? `<div class="cap">${esc(p.caption)}</div>` : ''}${bubbles}</figure>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}body{background:#F5EFE3;font-family:'Comic Neue',sans-serif;padding:28px 16px}
h1{font:400 clamp(34px,5vw,56px)/1 Bangers,sans-serif;letter-spacing:.03em;text-align:center;margin-bottom:18px;color:#1B1B1B}
.strip{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;background:#1B1B1B;padding:12px;border-radius:6px}
figure{position:relative;aspect-ratio:1;background:#fff;overflow:hidden;border:3px solid #1B1B1B}
figure img{width:100%;height:100%;object-fit:cover;display:block}
.b{position:absolute;max-width:72%;background:#fff;border:3px solid #1B1B1B;border-radius:18px;padding:8px 12px;font-size:clamp(12px,1.25vw,17px);line-height:1.2;box-shadow:3px 3px 0 #1B1B1B}
.b b{display:block;font:400 .8em Bangers;letter-spacing:.05em;color:#E94F37}
.b.l{left:5%}.b.r{right:5%}
.b:after{content:"";position:absolute;bottom:-14px;width:18px;height:14px;background:#fff;border:3px solid #1B1B1B;border-top:0;clip-path:polygon(0 0,100% 0,30% 100%)}
.b.l:after{left:22px}.b.r:after{right:22px}
.cap{position:absolute;left:0;bottom:0;background:#F6D55C;border-top:3px solid #1B1B1B;border-right:3px solid #1B1B1B;padding:4px 10px;font:400 clamp(12px,1.2vw,16px) Bangers;letter-spacing:.05em}
p.by{text-align:center;margin-top:14px;font-size:13px;opacity:.6}
@media(max-width:760px){.strip{grid-template-columns:1fr 1fr}.b{font-size:13px}}
</style></head><body><h1>${esc(title)}</h1><div class="strip">${panels.map(cell).join('')}</div><p class="by">Written, drawn and lettered by the agents of Parallax</p></body></html>`;
}

export const comic: Service = {
  id: 'comic', name: 'Comic strip', priceUsd: 3,
  blurb: 'A four-panel strip about your business, written for a laugh, drawn in one style, lettered and checked before you post it.',
  team: ['writer', 'illustrator', 'producer', 'auditor'],
  fields,
  example: { about: 'Our generator always dies the exact minute a customer sits in the barber chair, but Tunde never stops cutting', who: 'Tunde the barber (tall, bald, big smile, white tunic), and a customer in a grey suit', for: 'Our Instagram, to make customers laugh', style: 'Bold ink lines and flat colour, like a newspaper strip' },
  run,
};
