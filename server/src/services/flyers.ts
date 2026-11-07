// Flyers: one design in two sizes (A5 to print, square to post), written, painted, laid out and checked.
import type { Job } from '../job.ts';
import { llmJson } from '../tools.ts';
import { direct, esc, type Palette } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'business', label: 'Business', hint: 'Greenhouse Yoga' },
  { key: 'what', label: 'What the flyer is for', hint: 'Free first class for new students all of March', long: true },
  { key: 'details', label: 'When, where, price', hint: 'Mon–Fri 7am and 6pm · 22 Elm Street · first class free, then $12', long: true },
  { key: 'contact', label: 'How people reach you', hint: 'greenhouseyoga.example · @greenhouseyoga' },
  { key: 'style', label: 'How it should feel', hint: 'Bright, calm, lots of plants', optional: true },
];

type Copy = { headline: string; sub: string; lines: string[]; cta: string };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  job.log('writer', 'start', 'Writing the flyer');
  const copy = await llmJson<Copy>(job, 'writer', {
    reason: 'flyer copy',
    system: 'Write flyer copy for a small business. A headline of at most 6 words people read from across the street, a one-line sub, up to 3 short detail lines taken only from the brief (times, place, price), and a 2-4 word call to action. No invented details. JSON {"headline","sub","lines":[...],"cta"}.',
    prompt: brief,
    dry: () => JSON.stringify({ headline: input.what.split(/[.,]/)[0].split(' ').slice(0, 6).join(' '), sub: input.business, lines: input.details.split('·').map((s) => s.trim()).filter(Boolean).slice(0, 3), cta: 'Come say hi' }),
    maxTokens: 400,
  });
  job.log('writer', 'done', `"${copy.headline}"`);

  const art = await direct(job, brief, 'flyer', {
    palette: { bg: '#F6F3EA', ink: '#16241B', accent: '#2F8F5B', soft: '#DCEFD9' }, font: 'Bricolage Grotesque',
    image: `A bright, uplifting picture for ${input.business}: ${input.what}`,
  });

  job.log('producer', 'start', 'Laying out A5 and square');
  const out = [
    { name: 'flyer-a5', w: 874, h: 1240, svg: layout(copy, input.contact, art, 874, 1240) },
    { name: 'flyer-square', w: 1080, h: 1080, svg: layout(copy, input.contact, art, 1080, 1080) },
  ];
  job.log('producer', 'done', 'Two sizes ready to print and post');

  const check = await audit(job, brief, `Headline: ${copy.headline}\nSub: ${copy.sub}\nLines: ${copy.lines.join(' | ')}\nCTA: ${copy.cta}\nContact: ${input.contact}`);
  return { summary: `A flyer for ${input.business} in two sizes: A5 to print and square to post.`, check, flyers: out };
}

/** The flyer as SVG: picture on top, words below. Square puts them side by side. */
export function layout(c: Copy, contact: string, a: { palette: Palette; font: string; image: string }, w: number, h: number) {
  const p = a.palette, square = w === h, pad = Math.round(w * 0.07);
  const img = square ? { x: 0, y: 0, w: w * 0.5, h } : { x: pad, y: pad, w: w - pad * 2, h: h * 0.48 };
  const tx = square ? w * 0.5 + pad : pad, tw = square ? w * 0.5 - pad * 2 : w - pad * 2;
  let y = square ? pad * 2.2 : img.y + img.h + pad * 1.3;
  const size = Math.round((square ? 74 : 84) * (w / 1000) * (c.headline.length > 22 ? 0.82 : 1));
  const words = wrap(c.headline, Math.floor(tw / (size * 0.52)));
  const parts: string[] = [];
  for (const line of words) { parts.push(`<text x="${tx}" y="${y}" class="h" font-size="${size}">${esc(line)}</text>`); y += size * 1.02; }
  y += size * 0.35;
  // Inter is about 0.55 em a character, so the tagline and the details wrap to the text column like the headline does
  for (const line of wrap(c.sub, Math.floor(tw / (size * 0.36 * 0.55))).slice(0, 3)) { parts.push(`<text x="${tx}" y="${y}" class="s" font-size="${size * 0.36}">${esc(line)}</text>`); y += size * 0.46; }
  y += size * 0.34;
  for (const l of c.lines.slice(0, 3)) for (const line of wrap(l, Math.floor(tw / (size * 0.3 * 0.55))).slice(0, 2)) { parts.push(`<text x="${tx}" y="${y}" class="b" font-size="${size * 0.3}">${esc(line)}</text>`); y += size * 0.46; }
  const by = h - pad - size * 0.9, bw = Math.min(tw, c.cta.length * size * 0.24 + size * 0.9);
  // the contact sits beside the button when it fits in the column, otherwise just above it
  const beside = bw + size * 0.3 + contact.length * size * 0.24 * 0.55 <= tw;
  const cx = beside ? tx + bw + size * 0.3 : tx, cy = beside ? by + size * 0.5 : by - size * 0.3;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<style>@import url('https://fonts.googleapis.com/css2?family=${a.font.replace(/ /g, '+')}:wght@700&amp;family=Inter:wght@500;600&amp;display=swap');
.h{font-family:'${a.font}',serif;font-weight:700;fill:${p.ink};letter-spacing:-.02em}.s{font-family:Inter,sans-serif;font-weight:600;fill:${p.accent}}.b{font-family:Inter,sans-serif;font-weight:500;fill:${p.ink}}</style>
<rect width="${w}" height="${h}" fill="${p.bg}"/>
<defs><clipPath id="c"><rect x="${img.x}" y="${img.y}" width="${img.w}" height="${img.h}" rx="${square ? 0 : 28}"/></clipPath></defs>
<image href="${a.image}" x="${img.x}" y="${img.y}" width="${img.w}" height="${img.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)"/>
${parts.join('\n')}
<rect x="${tx}" y="${by}" width="${bw}" height="${size * 0.78}" rx="${size * 0.39}" fill="${p.accent}"/>
<text x="${tx + bw / 2}" y="${by + size * 0.5}" text-anchor="middle" class="s" style="fill:#fff" font-size="${size * 0.3}">${esc(c.cta)}</text>
<text x="${cx}" y="${cy}" class="b" font-size="${size * 0.24}">${esc(contact)}</text>
</svg>`;
}

function wrap(s: string, max: number) {
  const out: string[] = [];
  for (const word of s.split(/\s+/)) {
    const last = out[out.length - 1];
    if (last && (last + ' ' + word).length <= max) out[out.length - 1] = last + ' ' + word; else out.push(word);
  }
  return out.slice(0, 4);
}

export const flyers: Service = {
  id: 'flyers', name: 'Flyers', priceUsd: 2,
  blurb: 'One flyer in two sizes, A5 to print and square to post: written, painted, laid out and checked.',
  team: ['writer', 'illustrator', 'producer', 'auditor'],
  fields,
  example: { business: 'Greenhouse Yoga', what: 'Your first class is free, all of March', details: 'Mon–Fri 7am and 6pm · 22 Elm Street · first class free, then $12', contact: 'greenhouseyoga.example', style: 'Bright, calm, lots of plants' },
  run,
};
