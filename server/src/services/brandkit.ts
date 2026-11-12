// Brand kit: a logo in four forms, colours with names, a type pair, a voice, and the brand on the things a small
// business actually uses (a card, a sign, a social profile, a bag). The illustrator chooses the identity, the
// producer draws the logos as SVG from that choice (so they're sharp at any size and the same every time), the
// writer gives it words, and the auditor checks the words against the brief.
import type { Job } from '../job.ts';
import { llmJson, picture } from '../tools.ts';
import { FONTS, asFile, esc, placeholder } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'business', label: 'Business name', hint: 'Mama Put Kitchen' },
  { key: 'what', label: 'What you do and for whom', hint: 'Home-style Nigerian lunch bowls for office workers on the Island, delivered by 12:30', long: true },
  { key: 'feel', label: 'Three words it should feel like', hint: 'Warm, quick, proudly local' },
  { key: 'avoid', label: 'Anything to avoid', hint: 'No green-white-green flag look', optional: true },
];

const SHAPES = ['circle', 'squircle', 'arch', 'hexagon', 'shield', 'diamond', 'pill'] as const;
const MARKS = ['monogram', 'symbol'] as const;
const SYMBOLS = ['sun', 'leaf', 'wave', 'star', 'bolt', 'drop', 'flame', 'bowl', 'house', 'eye', 'spark', 'mountain'] as const;
type Identity = {
  palette: { name: string; hex: string; use: string }[];
  display: string; body: string;
  mark: { kind: typeof MARKS[number]; letters: string; shape: typeof SHAPES[number]; symbol: typeof SYMBOLS[number] };
  wordmarkCase: 'upper' | 'title' | 'lower';
  imagery: string; why: string;
};
type Words = { taglines: string[]; voice: { is: string[]; isnt: string[] }; bio: string; pitch: string; sample: string };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  const name = input.business.trim();

  job.log('illustrator', 'start', 'Choosing the identity');
  const id = await llmJson<Identity>(job, 'illustrator', {
    reason: 'brand identity',
    system: `You are a brand designer for small businesses. Choose: a palette of 5 colours, each with a short evocative name, a #rrggbb hex and its job (primary, accent, background, ink, support); a display font and a body font from ${FONTS.join(', ')}, Inter; a logo mark: kind "monogram" (1-2 letters from the name) or "symbol" (one of ${SYMBOLS.join(', ')}), inside a shape from ${SHAPES.join(', ')}; the wordmark's case (upper, title or lower); one sentence describing the brand's photography; and one sentence on why it fits. Avoid what the brief says to avoid; no purple gradients, no generic tech blue. JSON {"palette":[{"name","hex","use"}x5],"display","body","mark":{"kind","letters","shape","symbol"},"wordmarkCase","imagery","why"}.`,
    prompt: brief,
    dry: () => JSON.stringify({
      palette: [{ name: 'Pepper Red', hex: '#D9452B', use: 'primary' }, { name: 'Palm Gold', hex: '#F2B33D', use: 'accent' }, { name: 'Rice White', hex: '#FBF6EC', use: 'background' }, { name: 'Pot Black', hex: '#1F1A17', use: 'ink' }, { name: 'Leaf', hex: '#3E7D4F', use: 'support' }],
      display: 'Bricolage Grotesque', body: 'Inter', mark: { kind: 'monogram', letters: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2), shape: 'circle', symbol: 'bowl' },
      wordmarkCase: 'title', imagery: `Close, warm photos of the food at ${name}, shot from above in daylight`, why: 'Warm and appetising, easy to read on a phone.',
    }),
    maxTokens: 700,
  });
  const HEX = /^#[0-9a-f]{6}$/i;
  const pal = (id.palette ?? []).filter((p) => HEX.test(p.hex)).slice(0, 5);
  while (pal.length < 5) pal.push([{ name: 'Ink', hex: '#1F1A17', use: 'ink' }, { name: 'Paper', hex: '#FBF6EC', use: 'background' }, { name: 'Signal', hex: '#D9452B', use: 'primary' }, { name: 'Sun', hex: '#F2B33D', use: 'accent' }, { name: 'Leaf', hex: '#3E7D4F', use: 'support' }][pal.length]);
  const role = (u: string, i: number) => pal.find((p) => p.use?.toLowerCase().includes(u)) ?? pal[i];
  const c = { primary: role('primary', 0).hex, accent: role('accent', 1).hex, bg: role('background', 2).hex, ink: role('ink', 3).hex, support: role('support', 4).hex };
  const display = FONTS.includes(id.display) ? id.display : 'Bricolage Grotesque';
  const body = [...FONTS, 'Inter'].includes(id.body) ? id.body : 'Inter';
  const mark = {
    kind: MARKS.includes(id.mark?.kind) ? id.mark.kind : 'monogram',
    letters: (id.mark?.letters || name.split(/\s+/).map((w) => w[0]).join('')).replace(/[^\p{L}\p{N}&]/gu, '').slice(0, 2).toUpperCase() || name[0].toUpperCase(),
    shape: SHAPES.includes(id.mark?.shape) ? id.mark.shape : 'circle',
    symbol: SYMBOLS.includes(id.mark?.symbol) ? id.mark.symbol : 'spark',
  };
  const word = id.wordmarkCase === 'upper' ? name.toUpperCase() : id.wordmarkCase === 'lower' ? name.toLowerCase() : name;
  job.log('illustrator', 'note', `${mark.kind === 'symbol' ? mark.symbol : mark.letters} in a ${mark.shape} · ${display} + ${body} · ${pal.map((p) => p.name).join(', ')}`);

  const photo = await picture(job, 'illustrator', {
    prompt: `${id.imagery || `A photo for ${name}: ${input.what}`}. Brand photography, colours leaning ${pal.map((p) => p.name).join(', ')}. No text, no logos.`,
    reason: 'brand photo', dry: () => placeholder({ bg: c.bg, ink: c.ink, accent: c.primary, soft: c.accent }),
  });
  job.log('illustrator', 'done', 'Identity and photo ready');

  job.log('writer', 'start', 'Writing the voice');
  const words = await llmJson<Words>(job, 'writer', {
    reason: 'brand voice',
    system: 'Write the words for a small business brand kit. Three tagline options (each under 6 words, specific, no clichés like "elevate" or "unleash"); the voice as three short "we are" traits and three "we are not"; a social bio under 150 characters; a one-sentence pitch; and one sample post in the voice (under 220 characters). Only facts from the brief. JSON {"taglines":[3],"voice":{"is":[3],"isnt":[3]},"bio","pitch","sample"}.',
    prompt: `${brief}\nThe look: ${id.why ?? ''}`,
    dry: () => JSON.stringify({ taglines: [`${name}, made today`, 'Lunch that tastes like home', 'Hot by half twelve'], voice: { is: ['Warm', 'Quick', 'Local'], isnt: ['Fancy', 'Pushy', 'Vague'] }, bio: input.what.slice(0, 140), pitch: `${name}: ${input.what}`, sample: `Today at ${name}: ${input.what.slice(0, 120)}` }),
    maxTokens: 600,
  });
  job.log('writer', 'done', `"${words.taglines?.[0] ?? ''}"`);

  job.log('producer', 'start', 'Drawing the logos and the mockups');
  const fonts = { display, body };
  const logos = {
    'logo-horizontal': horizontal(word, mark, c, fonts),
    'logo-stacked': stacked(word, mark, c, fonts),
    'logo-mark': markSvg(mark, c, fonts, 512),
    'logo-reversed': horizontal(word, mark, { ...c, ink: c.bg, bg: c.ink }, fonts, true),
  };
  const pic = asFile(photo, 'brand-photo');
  const files = [...Object.entries(logos).map(([n, svg]) => ({ name: `${n}.svg`, data: Buffer.from(svg) })), ...(pic.file ? [pic.file] : [])];
  const html = sheet(name, word, mark, c, pal, fonts, words, id, logos, pic.ref, input.what);
  job.log('producer', 'done', `4 logo files, 5 colours, 4 mockups`);

  const check = await audit(job, brief, `Name: ${name}\nTaglines: ${(words.taglines ?? []).join(' | ')}\nBio: ${words.bio}\nPitch: ${words.pitch}\nSample post: ${words.sample}\nColours: ${pal.map((p) => `${p.name} ${p.hex}`).join(', ')}\nAvoid: ${input.avoid ?? '-'}`);
  return {
    summary: `A brand kit for ${name}: logo in four forms, five named colours, a type pair, the voice, and the brand on a card, a sign, a profile and a bag.`,
    check, site: { path: `/sites/${job.orderId}/`, html }, files,
  };
}

// ---------------------------------------------------------------- the logo, drawn

type C = { primary: string; accent: string; bg: string; ink: string; support: string };
type M = { kind: string; letters: string; shape: string; symbol: string };
const fontCss = (f: { display: string; body: string }) => `@import url('https://fonts.googleapis.com/css2?family=${f.display.replace(/ /g, '+')}:wght@700;800&amp;family=${f.body.replace(/ /g, '+')}:wght@400;600&amp;display=swap');`;

function shapePath(shape: string, s: number) {
  const h = s / 2;
  switch (shape) {
    case 'squircle': return `<rect x="0" y="0" width="${s}" height="${s}" rx="${s * 0.28}"/>`;
    case 'arch': return `<path d="M0 ${s} V${h} A${h} ${h} 0 0 1 ${s} ${h} V${s} Z"/>`;
    case 'hexagon': return `<polygon points="${[0, 1, 2, 3, 4, 5].map((i) => { const a = Math.PI / 3 * i - Math.PI / 2; return `${h + h * Math.cos(a)},${h + h * Math.sin(a)}`; }).join(' ')}"/>`;
    case 'shield': return `<path d="M${h} 0 L${s} ${s * 0.16} V${s * 0.5} C${s} ${s * 0.78} ${s * 0.72} ${s * 0.94} ${h} ${s} C${s * 0.28} ${s * 0.94} 0 ${s * 0.78} 0 ${s * 0.5} V${s * 0.16} Z"/>`;
    case 'diamond': return `<rect x="${s * 0.15}" y="${s * 0.15}" width="${s * 0.7}" height="${s * 0.7}" rx="${s * 0.08}" transform="rotate(45 ${h} ${h})"/>`;
    case 'pill': return `<rect x="0" y="${s * 0.12}" width="${s}" height="${s * 0.76}" rx="${s * 0.38}"/>`;
    default: return `<circle cx="${h}" cy="${h}" r="${h}"/>`;
  }
}
/** Simple symbols on a 100 grid, drawn in one colour. */
function symbolPath(sym: string) {
  switch (sym) {
    case 'sun': return `<circle cx="50" cy="50" r="18"/>${[...Array(8)].map((_, i) => `<rect x="47" y="12" width="6" height="14" rx="3" transform="rotate(${i * 45} 50 50)"/>`).join('')}`;
    case 'leaf': return '<path d="M22 78 C22 40 46 20 80 20 C80 56 60 78 22 78 Z"/><path d="M22 78 L62 38" stroke-width="5" stroke-linecap="round" fill="none" class="cut"/>';
    case 'wave': return '<path d="M12 58 C24 42 36 42 50 58 C64 74 76 74 88 58 V78 H12 Z"/><path d="M12 40 C24 24 36 24 50 40 C64 56 76 56 88 40" fill="none" stroke-width="7" stroke-linecap="round" class="line"/>';
    case 'star': return `<polygon points="${[...Array(10)].map((_, i) => { const r = i % 2 ? 16 : 38, a = Math.PI / 5 * i - Math.PI / 2; return `${50 + r * Math.cos(a)},${52 + r * Math.sin(a)}`; }).join(' ')}"/>`;
    case 'bolt': return '<polygon points="56,10 24,56 46,56 40,90 76,42 54,42"/>';
    case 'drop': return '<path d="M50 12 C50 12 22 46 22 62 A28 28 0 0 0 78 62 C78 46 50 12 50 12 Z"/>';
    case 'flame': return '<path d="M50 10 C62 30 76 38 76 60 A26 26 0 0 1 24 60 C24 46 32 38 38 28 C40 40 46 44 50 44 C50 32 46 22 50 10 Z"/>';
    case 'bowl': return '<path d="M14 46 H86 C86 68 70 82 50 82 C30 82 14 68 14 46 Z"/><path d="M34 36 C34 28 40 26 40 18 M50 36 C50 28 56 26 56 18 M66 36 C66 28 72 26 72 18" fill="none" stroke-width="5" stroke-linecap="round" class="line"/>';
    case 'house': return '<path d="M16 48 L50 18 L84 48 V84 H60 V62 H40 V84 H16 Z"/>';
    case 'eye': return '<path d="M8 50 C24 26 76 26 92 50 C76 74 24 74 8 50 Z"/><circle cx="50" cy="50" r="13" class="cut-fill"/>';
    case 'mountain': return '<polygon points="8,82 38,30 54,56 64,42 92,82"/>';
    default: return '<path d="M50 8 L58 42 L92 50 L58 58 L50 92 L42 58 L8 50 L42 42 Z"/>';
  }
}
function markSvg(m: M, c: C, f: { display: string; body: string }, s = 120, standalone = true) {
  const inner = m.kind === 'symbol'
    ? `<g transform="translate(${s * 0.2} ${s * 0.2}) scale(${s * 0.6 / 100})" fill="${c.bg}" stroke="${c.bg}">${symbolPath(m.symbol).replace(/class="(cut|line)"/g, `stroke="${c.bg}"`).replace(/class="cut-fill"/g, `fill="${c.primary}"`)}</g>`
    : `<text x="${s / 2}" y="${s / 2}" dy=".35em" text-anchor="middle" font-family="'${f.display}',sans-serif" font-weight="800" font-size="${s * (m.letters.length > 1 ? 0.42 : 0.56)}" fill="${c.bg}" letter-spacing="-.02em">${esc(m.letters)}</text>`;
  const body = `<g fill="${c.primary}">${shapePath(m.shape, s)}</g>${inner}${m.kind === 'monogram' ? `<circle cx="${s * 0.8}" cy="${s * 0.2}" r="${s * 0.07}" fill="${c.accent}"/>` : ''}`;
  return standalone ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}"><style>${fontCss(f)}</style>${body}</svg>` : body;
}
function horizontal(word: string, m: M, c: C, f: { display: string; body: string }, dark = false) {
  const s = 120, size = 64, w = s + 36 + Math.round(word.length * size * 0.56) + 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${s + 24}" width="${w}" height="${s + 24}"><style>${fontCss(f)}</style>${dark ? `<rect width="100%" height="100%" fill="${c.bg}"/>` : ''}<g transform="translate(12 12)">${markSvg(m, { ...c, bg: dark ? c.ink : c.bg }, f, s, false)}</g><text x="${s + 40}" y="${(s + 24) / 2}" dy=".35em" font-family="'${f.display}',sans-serif" font-weight="800" font-size="${size}" fill="${c.ink}" letter-spacing="-.02em">${esc(word)}</text></svg>`;
}
function stacked(word: string, m: M, c: C, f: { display: string; body: string }) {
  const s = 160, size = 56, w = Math.max(s + 40, Math.round(word.length * size * 0.58) + 40), h = s + 110;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><style>${fontCss(f)}</style><g transform="translate(${(w - s) / 2} 10)">${markSvg(m, c, f, s, false)}</g><text x="${w / 2}" y="${s + 72}" text-anchor="middle" font-family="'${f.display}',sans-serif" font-weight="800" font-size="${size}" fill="${c.ink}" letter-spacing="-.02em">${esc(word)}</text></svg>`;
}

// ---------------------------------------------------------------- the brand sheet

function sheet(name: string, word: string, m: M, c: C, pal: { name: string; hex: string; use: string }[], f: { display: string; body: string }, w: Words, id: Identity, logos: Record<string, string>, photo: string, what: string) {
  const ink = (hex: string) => { const n = parseInt(hex.slice(1), 16); const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.6 ? '#111' : '#fff'; };
  const inline = (svg: string) => svg.replace(/^<svg /, '<svg class="lg" ');
  const tag = w.taglines?.[0] ?? '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} · Brand kit</title>
<link href="https://fonts.googleapis.com/css2?family=${f.display.replace(/ /g, '+')}:wght@700;800&family=${f.body.replace(/ /g, '+')}:wght@400;600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--p:${c.primary};--a:${c.accent};--bg:${c.bg};--ink:${c.ink};--s:${c.support}}
*{box-sizing:border-box;margin:0}body{background:#F4F2EE;color:#1a1a1a;font:15px/1.55 Inter,system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:40px 24px 80px}
.top{display:flex;justify-content:space-between;align-items:end;margin-bottom:28px}.top h1{font:800 44px/1 '${f.display}';letter-spacing:-.02em}.top p{opacity:.6}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}
.tile{background:#fff;border-radius:20px;padding:24px;overflow:hidden;position:relative}
.tile h3{font:600 11px/1 Inter;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin-bottom:16px}
.hero{grid-column:span 8;background:var(--bg);display:grid;place-items:center;min-height:340px}.hero .lg{width:min(80%,560px);height:auto}
.markt{grid-column:span 4;display:grid;place-items:center;background:var(--ink)}.markt .lg{width:55%;height:auto}
.st{grid-column:span 4;display:grid;place-items:center;background:var(--bg)}.st .lg{width:70%;height:auto}
.rev{grid-column:span 4;padding:0;background:var(--ink);display:grid;place-items:center}.rev .lg{width:86%;height:auto}
.dl{grid-column:span 4;display:flex;flex-direction:column;gap:8px}.dl a{color:inherit;display:flex;justify-content:space-between;padding:10px 12px;border-radius:10px;background:#F4F2EE;text-decoration:none;font-weight:600}
.sw{grid-column:span 12;display:grid;grid-template-columns:repeat(5,1fr);gap:0;padding:0}.sw div{padding:22px;min-height:150px;display:flex;flex-direction:column;justify-content:end}.sw b{font:700 20px/1.1 '${f.display}'}.sw small{opacity:.8;font-family:ui-monospace,monospace}
.type{grid-column:span 7}.type .d{font:800 72px/1 '${f.display}';letter-spacing:-.02em}.type .b{font:400 18px/1.5 '${f.body}';margin-top:14px;max-width:46ch}.type small{display:block;margin-top:10px;opacity:.55}
.voice{grid-column:span 5}.voice ul{list-style:none;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px}.voice li{padding:8px 12px;border-radius:10px;background:#F4F2EE}.voice li.no{text-decoration:line-through;opacity:.55}
.voice .tags{margin-top:16px}.voice .tags p{font:700 20px/1.25 '${f.display}';margin-bottom:6px}
.photo{grid-column:span 5;padding:0;min-height:320px}.photo img{width:100%;height:100%;object-fit:cover;display:block}
.mock{grid-column:span 7;display:grid;grid-template-columns:1fr 1fr;gap:16px;background:#E9E6E0}
.card{aspect-ratio:1.75;border-radius:10px;box-shadow:0 12px 30px -12px rgba(0,0,0,.35);padding:18px;display:flex;flex-direction:column;justify-content:space-between}
.card.f{background:var(--p);color:${ink(c.primary)}}.card.b{background:var(--bg);color:var(--ink)}.card .lg{width:60%;height:auto}.card b{font:800 22px '${f.display}'}.card small{font:400 11px/1.4 '${f.body}'}
.sign{grid-column:span 2;height:150px;border-radius:12px;background:var(--ink);display:flex;align-items:center;gap:18px;padding:0 26px;position:relative}
.sign:before{content:"";position:absolute;left:0;right:0;bottom:-14px;height:14px;background:repeating-linear-gradient(90deg,var(--p) 0 26px,var(--bg) 26px 52px);border-radius:0 0 8px 8px}
.sign .lg{height:90px;width:auto}.sign b{font:800 40px '${f.display}';color:var(--bg);letter-spacing:-.02em}
.social{background:#fff;border-radius:14px;padding:14px;display:flex;gap:12px;align-items:center}.social .av{width:64px;height:64px;border-radius:50%;background:var(--bg);display:grid;place-items:center;flex:none}.social .av .lg{width:54px;height:54px}
.social b{display:block}.social small{opacity:.7;font-size:12px}
.bag{display:grid;place-items:center}.bag div{width:150px;height:170px;background:var(--a);border-radius:6px 6px 14px 14px;position:relative;display:grid;place-items:center}.bag div:before{content:"";position:absolute;top:-34px;width:70px;height:46px;border:7px solid var(--ink);border-bottom:0;border-radius:40px 40px 0 0}.bag .lg{width:70%;height:auto}
.why{grid-column:span 12;font:700 26px/1.3 '${f.display}';background:var(--p);color:${ink(c.primary)}}.why small{display:block;font:400 14px Inter;opacity:.8;margin-top:8px}
@media(max-width:900px){.grid>*{grid-column:span 12!important}.sw{grid-template-columns:1fr 1fr}.mock{grid-template-columns:1fr}.sign{grid-column:span 1}}
</style></head><body><div class="wrap">
<div class="top"><div><h1>${esc(name)}</h1><p>Brand kit · made by the agents of Parallax</p></div><p>${esc(tag)}</p></div>
<div class="grid">
<div class="tile hero"><h3 style="position:absolute;top:24px;left:24px">Primary logo</h3>${inline(logos['logo-horizontal'])}</div>
<div class="tile markt"><h3 style="position:absolute;top:24px;left:24px;color:#fff">Mark</h3>${inline(markSvg(m, { ...c }, f, 200))}</div>
<div class="tile st"><h3 style="position:absolute;top:24px;left:24px">Stacked</h3>${inline(logos['logo-stacked'])}</div>
<div class="tile rev">${inline(logos['logo-reversed'])}</div>
<div class="tile dl"><h3>Files</h3>${Object.keys(logos).map((k) => `<a href="${k}.svg" download>${k.replace('logo-', '')}<span>SVG ↓</span></a>`).join('')}</div>
<div class="tile sw">${pal.map((p) => `<div style="background:${p.hex};color:${ink(p.hex)}"><b>${esc(p.name)}</b><small>${p.hex.toUpperCase()} · ${esc(p.use)}</small></div>`).join('')}</div>
<div class="tile type"><h3>Type</h3><div class="d">${esc(word)}</div><p class="b">${esc(w.pitch ?? what)}</p><small>${esc(f.display)} for headlines · ${esc(f.body)} for everything else</small></div>
<div class="tile voice"><h3>Voice</h3><ul>${(w.voice?.is ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}${(w.voice?.isnt ?? []).map((x) => `<li class="no">${esc(x)}</li>`).join('')}</ul><div class="tags"><h3 style="margin-top:6px">Taglines</h3>${(w.taglines ?? []).map((t) => `<p>${esc(t)}</p>`).join('')}</div></div>
<div class="tile photo"><img src="${photo}" alt=""></div>
<div class="tile mock"><div class="card f">${inline(markSvg(m, { ...c, primary: c.bg, bg: c.primary }, f, 120)).replace('class="lg"', 'class="lg" style="width:28%"')}<div><b>${esc(name)}</b><br><small>${esc(tag)}</small></div></div>
<div class="card b">${inline(logos['logo-horizontal'])}<small>${esc(w.bio ?? '')}</small></div>
<div class="sign">${inline(markSvg(m, { ...c, bg: c.ink }, f, 120))}<b>${esc(word)}</b></div>
<div class="social"><div class="av">${inline(markSvg(m, c, f, 120))}</div><div><b>${esc(name)}</b><small>${esc(w.bio ?? '')}</small><p style="margin-top:6px;font-size:13px">${esc(w.sample ?? '')}</p></div></div>
<div class="bag"><div>${inline(markSvg(m, { ...c, primary: c.ink, bg: c.accent }, f, 120))}</div></div></div>
<div class="tile why">${esc(id.why ?? '')}<small>${esc(id.imagery ?? '')}</small></div>
</div></div></body></html>`;
}

export const brandkit: Service = {
  id: 'brand-kit', name: 'Brand kit', priceUsd: 4,
  blurb: 'A logo in four forms, named colours, a type pair, a voice and taglines, shown on a card, a sign, a profile and a bag.',
  team: ['illustrator', 'writer', 'producer', 'auditor'],
  fields,
  example: { business: 'Mama Put Kitchen', what: 'Home-style Nigerian lunch bowls for office workers on Victoria Island, delivered by 12:30', feel: 'Warm, quick, proudly local', avoid: 'No green-white-green flag look' },
  run,
};
