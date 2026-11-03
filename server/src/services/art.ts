// Shared by the services that make pictures: the illustrator's art direction and a demo-mode stand-in.
import type { Job } from '../job.ts';
import { llmJson, picture } from '../tools.ts';

export type Palette = { bg: string; ink: string; accent: string; soft: string };
export const FONTS = ['Fraunces', 'DM Serif Display', 'Space Grotesk', 'Syne', 'Instrument Serif', 'Bricolage Grotesque', 'Outfit', 'Playfair Display'];
const HEX = /^#[0-9a-f]{6}$/i;

/** Colours, a display font and a picture prompt for a brief. */
export async function direct(job: Job, brief: string, what: string, dry: { palette: Palette; font: string; image: string }) {
  job.log('illustrator', 'start', `Art direction for the ${what}`);
  const d = await llmJson<{ palette: Palette; font: string; image: string; mood: string }>(job, 'illustrator', {
    reason: `art direction for the ${what}`,
    system: `You are an illustrator choosing the look for a small business's ${what}. Pick a palette that suits the business (not generic blue, not purple gradients): bg (light background), ink (text, dark), accent (one strong colour), soft (a pale tint) as #rrggbb. Pick a display font from: ${FONTS.join(', ')}. Write an image prompt for one photo-real or illustrated picture with no text or logos in it. JSON {"palette": {...}, "font": string, "image": string, "mood": short phrase}.`,
    prompt: brief,
    dry: () => JSON.stringify({ ...dry, mood: 'warm and local' }),
    maxTokens: 500,
  });
  const p = d.palette ?? dry.palette;
  const palette: Palette = { bg: HEX.test(p.bg) ? p.bg : dry.palette.bg, ink: HEX.test(p.ink) ? p.ink : dry.palette.ink, accent: HEX.test(p.accent) ? p.accent : dry.palette.accent, soft: HEX.test(p.soft) ? p.soft : dry.palette.soft };
  const font = FONTS.includes(d.font) ? d.font : dry.font;
  job.log('illustrator', 'note', `${d.mood ?? 'Look chosen'}: ${font}, ${palette.accent}`);
  const image = await picture(job, 'illustrator', { prompt: `${d.image || dry.image}. No text, no letters, no logos.`, reason: `picture for the ${what}`, dry: () => placeholder(palette) });
  job.log('illustrator', 'done', 'Picture painted');
  return { palette, font, image };
}

/** Demo mode's picture: soft shapes in the palette, as an SVG data URL. */
export function placeholder(p: Palette) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" preserveAspectRatio="xMidYMid slice"><rect x="-1024" y="-1024" width="3072" height="3072" fill="${p.soft}"/><circle cx="700" cy="380" r="260" fill="${p.accent}" opacity=".85"/><circle cx="360" cy="640" r="200" fill="${p.ink}" opacity=".12"/><rect x="180" y="200" width="300" height="300" rx="40" fill="${p.bg}" opacity=".7"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
