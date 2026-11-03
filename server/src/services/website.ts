// Website: a one-page site for a small business, researched, written, art-directed, built and checked.
import type { Job } from '../job.ts';
import { llmJson, readPage } from '../tools.ts';
import { direct, esc, type Palette } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'business', label: 'Business name', hint: 'Kōji Ramen' },
  { key: 'what', label: 'What you do', hint: 'A twelve-seat ramen counter. Slow broth, three bowls, closed Mondays.', long: true },
  { key: 'contact', label: 'Address, hours and contact', hint: '14 Rua da Rosa, Lisbon · Tue–Sun 12–15, 18–22 · +351 912 000 000', long: true },
  { key: 'link', label: 'Current website or social page', hint: 'https://…', optional: true },
  { key: 'style', label: 'How it should feel', hint: 'Calm, a bit Japanese, not fancy', optional: true },
];

type Facts = { name: string; tagline: string; offer: string[]; audience: string; tone: string; contact: { address?: string; hours?: string; phone?: string; email?: string } };
type Copy = { headline: string; sub: string; cta: string; sections: { title: string; body: string }[]; about: string; closing: string };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);

  // 1. Research: the facts, from the brief and (if given) the current page.
  let page = '';
  if (input.link?.trim()) {
    job.log('reader', 'start', `Reading ${input.link.trim()}`);
    page = await readPage(input.link.trim(), 5000).catch(() => '');
    job.log('reader', 'done', page ? `Read ${page.length.toLocaleString()} characters` : 'The page could not be read; working from the brief');
  }
  job.log('researcher', 'start', 'Pulling the facts together');
  const facts = await llmJson<Facts>(job, 'researcher', {
    reason: 'fact sheet for the site',
    system: 'Make a fact sheet for a small business website from the brief (and its current page, if given). Only facts that are stated; never invent prices, awards, years or reviews. JSON {"name", "tagline" (short, true), "offer": [up to 4 things they sell or do], "audience", "tone", "contact": {"address","hours","phone","email"}}.',
    prompt: `${brief}${page ? `\n\nCurrent page text:\n${page}` : ''}`,
    dry: () => JSON.stringify({ name: input.business, tagline: input.what.split('.')[0], offer: input.what.split('.').slice(1).map((s) => s.trim()).filter(Boolean).slice(0, 3), audience: 'locals and visitors nearby', tone: input.style || 'warm and plain', contact: { address: input.contact } }),
    maxTokens: 600,
  });
  job.log('researcher', 'done', `${facts.name}: ${facts.tagline}`);

  // 2. Writing: the copy, then the search details.
  job.log('writer', 'start', 'Writing the page');
  const copy = await llmJson<Copy>(job, 'writer', {
    reason: 'write the site copy',
    system: 'Write the copy for a one-page small business website. Plain, specific, warm; short sentences; no clichés ("elevate", "unleash", "journey"), no invented facts. JSON {"headline" (max 8 words), "sub" (one sentence), "cta" (2-3 words), "sections": [3 x {"title","body" (2-3 sentences)}], "about" (3 sentences), "closing" (one line)}.',
    prompt: `Facts: ${JSON.stringify(facts)}\nFeel: ${input.style || facts.tone}`,
    dry: () => JSON.stringify({
      headline: facts.tagline || facts.name, sub: input.what, cta: 'Come by',
      sections: (facts.offer.length ? facts.offer : ['What we do', 'Where to find us', 'When we are open']).slice(0, 3).map((o) => ({ title: o, body: `${o}. Made here by the people who run ${facts.name}.` })),
      about: `${facts.name} is run by a small team. ${input.what}`, closing: `See you at ${facts.name}.`,
    }),
    maxTokens: 1100,
  });
  job.log('writer', 'done', `"${copy.headline}"`);
  job.log('analyst', 'start', 'Search title and description');
  const seo = await llmJson<{ title: string; description: string }>(job, 'analyst', {
    reason: 'search title and description',
    system: 'Write the HTML title (under 60 characters, business name + what + place) and meta description (under 155 characters) for this page. JSON {"title","description"}.',
    prompt: `Facts: ${JSON.stringify(facts)}\nHeadline: ${copy.headline}`,
    dry: () => JSON.stringify({ title: `${facts.name} · ${facts.tagline}`.slice(0, 60), description: copy.sub.slice(0, 155) }),
    maxTokens: 200,
  });
  job.log('analyst', 'done', seo.title);

  // 3. Visuals: the look and the hero picture, then the build.
  const art = await direct(job, `${brief}\nTone: ${facts.tone}`, 'website', {
    palette: { bg: '#FBF8F3', ink: '#1E1B16', accent: '#C2502E', soft: '#F1E6D8' }, font: 'Fraunces',
    image: `A warm, natural-light photo inside ${facts.name}: ${input.what}`,
  });
  job.log('producer', 'start', 'Building the page');
  const html = build(facts, copy, seo, art);
  job.log('producer', 'done', `One page, ${Math.round(html.length / 1024)} KB`);

  const check = await audit(job, brief, `Title: ${seo.title}\nFacts: ${JSON.stringify(facts)}\nCopy: ${JSON.stringify(copy)}`);
  return {
    summary: `A one-page website for ${facts.name}, live at its own address, with the copy, the look and a hero picture made for it.`,
    check, site: { path: `/sites/${job.orderId}/`, html },
  };
}

function build(f: Facts, c: Copy, seo: { title: string; description: string }, a: { palette: Palette; font: string; image: string }) {
  const p = a.palette, font = a.font.replace(/ /g, '+');
  const contact = [f.contact.address, f.contact.hours, f.contact.phone, f.contact.email].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(seo.title)}</title><meta name="description" content="${esc(seo.description)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=${font}:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:${p.bg};--ink:${p.ink};--accent:${p.accent};--soft:${p.soft}}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--ink);font:17px/1.6 Inter,system-ui,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
header{display:flex;justify-content:space-between;align-items:center;padding:22px 0}
.brand{font:700 22px/1 '${a.font}',serif;letter-spacing:-.01em}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600}
.hero{display:grid;grid-template-columns:1.05fr 1fr;gap:48px;align-items:center;padding:40px 0 72px}
h1{font:700 clamp(40px,6vw,72px)/1.02 '${a.font}',serif;letter-spacing:-.02em;margin-bottom:18px}
.sub{font-size:20px;max-width:30ch;opacity:.85;margin-bottom:28px}
.hero img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:28px;background:var(--soft)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding-bottom:80px}
.card{background:var(--soft);border-radius:22px;padding:28px}.card h3{font:600 24px/1.2 '${a.font}',serif;margin-bottom:10px}
.about{display:grid;grid-template-columns:1fr 1fr;gap:48px;padding:72px 0;border-top:1px solid color-mix(in srgb,var(--ink) 15%,transparent)}
.about h2{font:700 40px/1.1 '${a.font}',serif}.about ul{list-style:none;padding:0;margin-top:18px}.about li{padding:8px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}
footer{background:var(--ink);color:var(--bg);padding:48px 0;margin-top:24px}footer p{font:600 28px/1.2 '${a.font}',serif}
@media(max-width:820px){.hero,.about{grid-template-columns:1fr}.cards{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap"><header><div class="brand">${esc(f.name)}</div><a class="btn" href="#visit">${esc(c.cta)}</a></header>
<section class="hero"><div><h1>${esc(c.headline)}</h1><p class="sub">${esc(c.sub)}</p><a class="btn" href="#visit">${esc(c.cta)}</a></div><img src="${a.image}" alt="${esc(f.name)}"></section>
<section class="cards">${c.sections.slice(0, 3).map((s) => `<div class="card"><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></div>`).join('')}</section>
<section class="about" id="visit"><div><h2>About ${esc(f.name)}</h2><p style="margin-top:16px">${esc(c.about)}</p></div><div><h2>Visit</h2><ul>${contact}</ul></div></section></div>
<footer><div class="wrap"><p>${esc(c.closing)}</p><small style="opacity:.6">Made by the agents of Parallax</small></div></footer>
</body></html>`;
}

export const website: Service = {
  id: 'website', name: 'Website', priceUsd: 5,
  blurb: 'A one-page site with its own address: researched, written, art-directed with a picture made for it, built and checked.',
  team: ['researcher', 'reader', 'writer', 'analyst', 'illustrator', 'producer', 'auditor'],
  fields,
  example: { business: 'Kōji Ramen', what: 'A twelve-seat ramen counter. Slow pork and chicken broth. Three bowls and one vegetarian. Closed Mondays.', contact: '14 Rua da Rosa, Lisbon · Tue–Sun 12–15 and 18–22 · hello@kojiramen.example', style: 'Calm, a bit Japanese, not fancy' },
  run,
};
