// Storybook: a picture book with a real child as the hero. The writer writes eight pages, the illustrator
// fixes one look for the hero and paints every page with it, the producer binds the book, and the auditor
// reads it as a parent would before it goes out.
import type { Job } from '../job.ts';
import { llmJson, picture } from '../tools.ts';
import { asFile, esc, placeholder } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'hero', label: "The hero's name and age", hint: 'Tobi, 5' },
  { key: 'loves', label: 'What they love', hint: 'Dinosaurs, jollof rice, his big sister Ada, the colour green', long: true },
  { key: 'about', label: 'What the story is about', hint: 'Being brave on the first day at a new school', long: true },
  { key: 'look', label: 'What the hero looks like', hint: 'Short curly black hair, brown skin, a green dinosaur backpack', optional: true },
  { key: 'style', label: 'Picture style', hint: 'Soft watercolour', optional: true },
];

type Book = { title: string; dedication: string; pages: { text: string; scene: string }[]; moral: string };
type Look = { hero: string; tag: string; style: string; palette: string[] };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  const name = input.hero.split(/[,(]/)[0].trim();

  job.log('writer', 'start', 'Writing the story');
  const book = await llmJson<Book>(job, 'writer', {
    reason: 'story pages',
    system: 'Write a picture book for a young child, starring them. Eight pages, each 1 to 3 short sentences a parent reads aloud (rhythm matters; a repeated line kids can say along is good). Use the things they love, gently, and the story the brief asks for; warm and a little funny, nothing scary. For each page also write the scene to paint: who is there, where, what is happening, one clear moment. JSON {"title","dedication" (one line to the child),"pages":[8 x {"text","scene"}],"moral" (one plain sentence)}.',
    prompt: brief,
    dry: () => JSON.stringify({
      title: `${name} and the Brave Day`, dedication: `For ${name}, who is braver than they know.`,
      pages: Array.from({ length: 8 }, (_, i) => ({ text: `Page ${i + 1}: ${name} took one small brave step. And then another.`, scene: `${name} on page ${i + 1}, ${input.about}` })),
      moral: 'Brave is a small step you take anyway.',
    }),
    maxTokens: 1600,
  });
  const pages = (book.pages ?? []).slice(0, 8);
  job.log('writer', 'done', `"${book.title}", ${pages.length} pages`);

  job.log('illustrator', 'start', 'Drawing the hero');
  const look = await llmJson<Look>(job, 'illustrator', {
    reason: 'character sheet',
    system: 'You illustrate picture books. Fix how the hero looks so every page matches: one sentence covering age, hair, skin, clothes and one item they always have (use what the brief gives; invent only clothes and the item). Then "tag": the same look in at most 14 words, the things a painter must never change ("5-year-old boy, brown skin, short curly black hair, green T-shirt, green dinosaur backpack"). Then one sentence of picture style for the whole book (medium, light, texture), and five hex colours for the book design. JSON {"hero","tag","style","palette":[5 hex]}.',
    prompt: brief,
    dry: () => JSON.stringify({ hero: `${input.hero}, ${input.look || 'a cheerful child in a green t-shirt'}`, tag: input.look || 'a cheerful child in a green t-shirt', style: input.style || 'soft watercolour, warm morning light, gentle paper texture', palette: ['#FFF8EC', '#2D3A2E', '#E9774E', '#9CC9A6', '#F6D58E'] }),
    maxTokens: 400,
  });
  const pal = (look.palette ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const colours = { bg: pal[0] ?? '#FFF8EC', ink: pal[1] ?? '#2D3A2E', accent: pal[2] ?? '#E9774E', soft: pal[3] ?? '#E8F2E6' };
  job.log('illustrator', 'note', look.hero);

  // The cover and every page in the same look, two at a time.
  const who = `${name} (${(look.tag || look.hero).replace(/\.$/, '')})`;
  // the hero's look goes where the hero is named, so it sits near the front of every prompt
  const withHero = (sc: string) => (sc.includes(name) ? sc.replace(name, who) : `${who}. ${sc}`);
  const scenes = [`${name} smiling at the viewer, a happy portrait, ${pages[0]?.scene ?? input.about}`, ...pages.map((p) => p.scene)].map(withHero);
  const pics: string[] = [];
  for (let i = 0; i < scenes.length; i += 3) {
    const batch = await Promise.all(scenes.slice(i, i + 3).map((sc, k) => picture(job, 'illustrator', {
      prompt: `Hand-drawn children's picture book illustration in ${input.style?.trim() || 'soft watercolour'}, not a photo: ${sc}. ${look.style} No text, no letters.`,
      reason: i + k === 0 ? 'cover' : `page ${i + k}`,
      dry: () => placeholder(colours),
    })));
    pics.push(...batch);
    job.log('illustrator', 'note', `Painted ${Math.min(pics.length, scenes.length)} of ${scenes.length}`);
  }
  job.log('illustrator', 'done', `Cover and ${pages.length} pages painted`);

  job.log('producer', 'start', 'Binding the book');
  const files = pics.map((p, i) => asFile(p, i === 0 ? 'cover' : `page-${i}`));
  const html = bind(book, pages, files.map((f) => f.ref), colours, name);
  job.log('producer', 'done', `${pages.length + 2} spreads, ${Math.round(html.length / 1024)} KB`);

  const check = await audit(job, brief, `Title: ${book.title}\nDedication: ${book.dedication}\n${pages.map((p, i) => `Page ${i + 1}: ${p.text}`).join('\n')}\nMoral: ${book.moral}\n\nAlso fail it if anything would frighten or upset a young child, or doesn't fit a child of this age.`);
  return {
    summary: `"${book.title}", an ${pages.length}-page picture book starring ${name}, written, painted and bound.`,
    check, site: { path: `/sites/${job.orderId}/`, html },
    files: files.flatMap((f) => (f.file ? [f.file] : [])),
    doc: { title: book.title, markdown: [`# ${book.title}`, `*${book.dedication}*`, ...pages.map((p, i) => `**${i + 1}.** ${p.text}`), `*${book.moral}*`].join('\n\n') },
  };
}

/** The book: a cover, then one spread per page (picture left, words right), turned with arrows, swipes or clicks. */
function bind(b: Book, pages: Book['pages'], pics: string[], c: { bg: string; ink: string; accent: string; soft: string }, name: string) {
  const spreads = [
    `<section class="spread cover"><img src="${pics[0]}" alt=""><div class="ct"><h1>${esc(b.title)}</h1><p>A story for ${esc(name)}</p></div></section>`,
    `<section class="spread ded"><p>${esc(b.dedication)}</p></section>`,
    ...pages.map((p, i) => `<section class="spread"><img src="${pics[i + 1] ?? pics[0]}" alt=""><div class="words"><p>${esc(p.text)}</p><span class="n">${i + 1}</span></div></section>`),
    `<section class="spread ded end"><p>${esc(b.moral)}</p><small>The End</small></section>`,
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(b.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Literata:opsz,wght@7..72,500;7..72,600&display=swap" rel="stylesheet">
<style>
:root{--bg:${c.bg};--ink:${c.ink};--accent:${c.accent};--soft:${c.soft}}
*{box-sizing:border-box;margin:0}html,body{height:100%}body{background:var(--soft);color:var(--ink);font-family:Literata,Georgia,serif;display:grid;place-items:center;overflow:hidden}
.book{width:min(1100px,94vw);aspect-ratio:16/9;max-height:86vh;position:relative;background:var(--bg);border-radius:18px;box-shadow:0 40px 80px -40px rgba(0,0,0,.4),inset 0 0 0 1px rgba(0,0,0,.05);overflow:hidden}
.spread{position:absolute;inset:0;display:grid;grid-template-columns:1.15fr 1fr;opacity:0;transform:translateX(30px);transition:opacity .5s,transform .5s;pointer-events:none}
.spread.on{opacity:1;transform:none;pointer-events:auto}
.spread img{width:100%;height:100%;object-fit:cover;display:block}
.words{display:flex;align-items:center;padding:8% 9%;position:relative;background:linear-gradient(90deg,rgba(0,0,0,.06),transparent 6%)}
.words p{font-size:clamp(20px,2.6vw,34px);line-height:1.45}
.n{position:absolute;bottom:22px;right:28px;font:600 14px Fredoka;opacity:.5}
.cover{grid-template-columns:1fr}.cover .ct{position:absolute;left:0;right:0;bottom:0;padding:6% 7%;background:linear-gradient(transparent,rgba(0,0,0,.55));color:#fff}
.cover h1{font:700 clamp(36px,5.5vw,72px)/1 Fredoka,sans-serif;letter-spacing:-.01em}.cover p{font-size:20px;margin-top:8px;opacity:.9}
.ded{grid-template-columns:1fr;place-items:center;text-align:center;padding:10%}.ded p{font-size:clamp(22px,3vw,40px);font-style:italic;max-width:24ch}
.ded small{display:block;margin-top:24px;font:700 18px Fredoka;color:var(--accent);letter-spacing:.06em}
nav{position:fixed;bottom:18px;left:0;right:0;display:flex;justify-content:center;gap:10px;align-items:center;font:600 14px Fredoka}
nav button{border:0;background:var(--accent);color:#fff;width:44px;height:44px;border-radius:50%;font-size:20px;cursor:pointer}
@media(max-width:760px){.book{aspect-ratio:auto;height:82vh}.spread{grid-template-columns:1fr;grid-template-rows:1.1fr 1fr}.words{background:none}}
@media print{body{display:block;overflow:visible;background:#fff}.book{width:auto;aspect-ratio:auto;max-height:none;box-shadow:none}.spread{position:relative;opacity:1;transform:none;height:100vh;page-break-after:always}nav{display:none}}
</style></head><body>
<div class="book" id="bk">${spreads.join('\n')}</div>
<nav><button id="pv" aria-label="Back">‹</button><span id="pg"></span><button id="nx" aria-label="Next">›</button></nav>
<script>
const s=[...document.querySelectorAll('.spread')];let i=0;const pg=document.getElementById('pg');
function go(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach((e,j)=>e.classList.toggle('on',j===i));pg.textContent=(i+1)+' / '+s.length}
document.getElementById('pv').onclick=()=>go(i-1);document.getElementById('nx').onclick=()=>go(i+1);
document.getElementById('bk').onclick=e=>go(e.clientX>innerWidth/2?i+1:i-1);
addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')go(i+1);if(e.key==='ArrowLeft')go(i-1)});
let x0=null;addEventListener('touchstart',e=>x0=e.touches[0].clientX);addEventListener('touchend',e=>{if(x0==null)return;const d=e.changedTouches[0].clientX-x0;if(Math.abs(d)>40)go(d<0?i+1:i-1);x0=null});
go(0);
</script></body></html>`;
}

export const storybook: Service = {
  id: 'storybook', name: 'Storybook', priceUsd: 4,
  blurb: 'An illustrated picture book with your child as the hero: eight pages written, painted in one look, bound and read through by an auditor first.',
  team: ['writer', 'illustrator', 'producer', 'auditor'],
  fields,
  example: { hero: 'Tobi, 5', loves: 'Dinosaurs, jollof rice, his big sister Ada, the colour green', about: 'Being brave on his first day at a new school', look: 'Short curly black hair, brown skin, a green dinosaur backpack', style: 'Soft watercolour' },
  run,
};
