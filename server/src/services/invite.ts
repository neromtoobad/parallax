// Invitation: a party, a wedding, a launch. The writer words it, the analyst pins the date and place down
// (so the calendar file and the countdown are right), the illustrator paints the card, the producer makes
// the card to share and the invite page (countdown, map, add to calendar, RSVP), and the auditor checks every
// fact against the brief.
import type { Job } from '../job.ts';
import { llmJson } from '../tools.ts';
import { asFile, direct, esc, type Palette } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'occasion', label: "What's the occasion", hint: "Tolu's 30th birthday" },
  { key: 'host', label: 'Who is inviting', hint: 'Tolu and family' },
  { key: 'when', label: 'When', hint: 'Saturday 13 December 2026, 4pm till late' },
  { key: 'where', label: 'Where', hint: 'The Wings Hall, 12 Admiralty Way, Lekki, Lagos' },
  { key: 'rsvp', label: 'How to RSVP', hint: 'WhatsApp +234 803 000 0000 by 1 December' },
  { key: 'extra', label: 'Dress code, colours, anything else', hint: 'Aso-ebi: emerald and gold. Small chops, live band, no gifts needed', long: true, optional: true },
  { key: 'style', label: 'How it should feel', hint: 'Glamorous, warm, a bit of Lagos', optional: true },
];

type Words = { kicker: string; headline: string; invite: string; details: { label: string; value: string }[]; note: string; rsvp: string };
type Facts = { start: string; end: string; tz: string; place: string; mapQuery: string; phone: string; email: string; rsvpBy: string };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);

  job.log('analyst', 'start', 'Pinning down the date and place');
  const f = await llmJson<Facts>(job, 'analyst', {
    reason: 'event facts',
    system: 'Turn an invitation brief into exact facts for a calendar file. start and end as local ISO date-times without offset (YYYY-MM-DDTHH:MM); if no end is given, start + 5 hours; "till late" means 23:59. tz: the IANA time zone of the place (Lagos is Africa/Lagos). place: the venue exactly as written. mapQuery: the venue and city for a map search. phone: an RSVP phone in international form with only digits and +, or "". email: an RSVP email or "". rsvpBy: the RSVP deadline as written, or "". Never invent a date, a place or a number. JSON {"start","end","tz","place","mapQuery","phone","email","rsvpBy"}.',
    prompt: brief,
    dry: () => JSON.stringify({ start: '2026-12-13T16:00', end: '2026-12-13T23:59', tz: 'Africa/Lagos', place: input.where, mapQuery: input.where, phone: (input.rsvp.match(/\+?\d[\d\s]{7,}/)?.[0] ?? '').replace(/\s/g, ''), email: input.rsvp.match(/\S+@\S+/)?.[0] ?? '', rsvpBy: '' }),
    maxTokens: 400,
  });
  job.log('analyst', 'done', `${f.start} (${f.tz}) · ${f.place}`);

  job.log('writer', 'start', 'Wording the invitation');
  const w = await llmJson<Words>(job, 'writer', {
    reason: 'invitation words',
    system: 'Word an invitation. A small kicker line (like "You are invited" or something warmer that fits), a headline (the occasion, max 7 words), two or three warm sentences of invitation in the host\'s voice, the details as label/value pairs (When, Where, Dress code, and anything else the brief gives, values exactly as the brief says them), one short closing note, and an RSVP line (exactly the brief\'s way to reply and deadline). Nothing the brief does not say. JSON {"kicker","headline","invite","details":[{"label","value"}],"note","rsvp"}.',
    prompt: brief,
    dry: () => JSON.stringify({ kicker: 'You are warmly invited', headline: input.occasion, invite: `${input.host} would love you to come and celebrate.`, details: [{ label: 'When', value: input.when }, { label: 'Where', value: input.where }, ...(input.extra ? [{ label: 'Also', value: input.extra }] : [])], note: 'Come ready to dance.', rsvp: input.rsvp }),
    maxTokens: 700,
  });
  job.log('writer', 'done', `"${w.headline}"`);

  const art = await direct(job, `${brief}\nAn invitation card. Its picture is decoration only: lights, flowers, fabric patterns, ornaments or the setting, in the event's colours. No people, no faces.`, 'invitation', {
    palette: { bg: '#FBF5EA', ink: '#1E2A22', accent: '#B8892B', soft: '#EFE3C8' }, font: 'Playfair Display',
    image: `A beautiful painted illustration for an invitation to ${input.occasion}: ornamental, festive, elegant, no people's faces`,
  });

  job.log('producer', 'start', 'Making the card, the page and the calendar file');
  const img = asFile(art.image, 'art');
  const ics = calendar(input, w, f);
  const html = page(input, w, f, art.palette, art.font, img.ref);
  job.log('producer', 'done', 'Card, invite page and calendar file ready');

  const check = await audit(job, brief, `Kicker: ${w.kicker}\nHeadline: ${w.headline}\nInvite: ${w.invite}\nDetails: ${(w.details ?? []).map((d) => `${d.label}: ${d.value}`).join(' | ')}\nNote: ${w.note}\nRSVP: ${w.rsvp}\nCalendar: ${f.start} to ${f.end} ${f.tz} at ${f.place}; RSVP phone ${f.phone || '-'} email ${f.email || '-'}\n\nFail it if any date, time, place, phone or deadline differs from the brief.`);
  return {
    summary: `An invitation for ${input.occasion}: a card to share, an invite page with a countdown, map, calendar file and one-tap RSVP.`,
    check, site: { path: `/sites/${job.orderId}/`, html },
    files: [...(img.file ? [img.file] : []), { name: 'event.ics', data: Buffer.from(ics) }],
  };
}

/** An .ics file in the event's own time zone, so phones add it at the right local time. */
function calendar(input: Record<string, string>, w: Words, f: Facts) {
  const dt = (s: string) => (s || '').replace(/[-:]/g, '').slice(0, 13) + '00';
  const fold = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(f.start);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Parallax//Invitation//EN', 'BEGIN:VEVENT',
    `UID:${dt(f.start)}-${input.occasion.replace(/\W+/g, '').slice(0, 24)}@useparallax.xyz`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    ...(valid ? [`DTSTART;TZID=${f.tz || 'Africa/Lagos'}:${dt(f.start)}`, `DTEND;TZID=${f.tz || 'Africa/Lagos'}:${dt(f.end || f.start)}`] : []),
    `SUMMARY:${fold(w.headline || input.occasion)}`, `LOCATION:${fold(f.place || input.where)}`,
    `DESCRIPTION:${fold(`${w.invite}\n${w.rsvp}`)}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function page(input: Record<string, string>, w: Words, f: Facts, p: Palette, font: string, art: string) {
  const wa = f.phone ? `https://wa.me/${f.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hello! I'd love to come to ${input.occasion}. My name is `)}` : '';
  const mail = !wa && f.email ? `mailto:${f.email}?subject=${encodeURIComponent(`RSVP: ${input.occasion}`)}` : '';
  const rsvpHref = wa || mail;
  const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(f.mapQuery || input.where)}`;
  const details = (w.details ?? []).slice(0, 6).map((d) => `<div><small>${esc(d.label)}</small><b>${esc(d.value)}</b></div>`).join('');
  const fnt = font.replace(/ /g, '+');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(w.headline)} · ${esc(input.host)}</title>
<meta property="og:title" content="${esc(w.headline)}"><meta property="og:description" content="${esc(w.invite)}"><meta property="og:image" content="${esc(art)}">
<link href="https://fonts.googleapis.com/css2?family=${fnt}:ital,wght@0,600;0,700;1,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:${p.bg};--ink:${p.ink};--a:${p.accent};--soft:${p.soft}}
*{box-sizing:border-box;margin:0}body{background:var(--soft);color:var(--ink);font:16px/1.55 Inter,system-ui,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:36px 20px 60px;display:grid;grid-template-columns:minmax(0,460px) 1fr;gap:44px;align-items:start}
.card{background:var(--bg);border-radius:22px;overflow:hidden;box-shadow:0 30px 70px -35px rgba(0,0,0,.45);position:relative;aspect-ratio:4/5;display:flex;flex-direction:column}
.card .art{height:52%;background:url('${art}') center/cover}
.card .tx{flex:1;padding:22px 28px;text-align:center;display:flex;flex-direction:column;justify-content:center;gap:6px;border-top:3px solid var(--a)}
.card small{font:600 11px Inter;letter-spacing:.18em;text-transform:uppercase;color:var(--a)}
.card h2{font:700 clamp(26px,4.4vw,38px)/1.05 '${font}',serif}
.card p{font-size:13px;opacity:.8}.card .w{font:italic 600 17px '${font}',serif;margin-top:4px}
.save{display:inline-block;margin-top:12px;font-size:13px;color:inherit;opacity:.7}
.k{font:600 12px Inter;letter-spacing:.18em;text-transform:uppercase;color:var(--a)}
h1{font:700 clamp(40px,6vw,68px)/1.02 '${font}',serif;margin:10px 0 16px;letter-spacing:-.01em}
.inv{font-size:19px;max-width:44ch;margin-bottom:24px}
.count{display:flex;gap:10px;margin-bottom:26px}.count div{background:var(--bg);border-radius:14px;padding:12px 14px;min-width:74px;text-align:center}.count b{display:block;font:700 30px/1 '${font}',serif}.count small{font-size:11px;opacity:.6;text-transform:uppercase;letter-spacing:.08em}
.det{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px}.det div{background:var(--bg);border-radius:14px;padding:14px 16px}.det small{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.55}.det b{font-weight:600}
.btns{display:flex;flex-wrap:wrap;gap:10px}.btn{display:inline-flex;align-items:center;gap:8px;padding:14px 22px;border-radius:999px;font-weight:600;text-decoration:none;color:var(--ink);background:var(--bg);border:1px solid color-mix(in srgb,var(--ink) 18%,transparent)}
.btn.main{background:var(--a);color:#fff;border-color:transparent}
.note{margin-top:22px;font:italic 600 20px '${font}',serif}.by{margin-top:28px;font-size:12px;opacity:.55}
@media(max-width:860px){.wrap{grid-template-columns:1fr}.det{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<div><div class="card" id="card"><div class="art"></div><div class="tx"><small>${esc(w.kicker)}</small><h2>${esc(w.headline)}</h2><p class="w">${esc(input.when)}</p><p>${esc(f.place || input.where)}</p><p>${esc(w.rsvp)}</p></div></div>
<a class="save" href="${esc(art)}" download>Save the picture</a></div>
<div><span class="k">${esc(w.kicker)}</span><h1>${esc(w.headline)}</h1><p class="inv">${esc(w.invite)}</p>
<div class="count" id="count"></div>
<div class="det">${details}</div>
<div class="btns">${rsvpHref ? `<a class="btn main" href="${esc(rsvpHref)}" target="_blank">RSVP${wa ? ' on WhatsApp' : ' by email'}</a>` : ''}<a class="btn" href="event.ics" download>Add to calendar</a><a class="btn" href="${esc(map)}" target="_blank">Directions</a><a class="btn" href="#" id="share">Share</a></div>
<p class="note">${esc(w.note)}</p><p class="by">${esc(w.rsvp)} · Invitation made by the agents of Parallax</p></div></div>
<script>
const start=${JSON.stringify(f.start)},tz=${JSON.stringify(f.tz || 'Africa/Lagos')};
// the event's local time in its own zone, turned into an instant
function instant(){if(!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/.test(start))return null;const guess=new Date(start+':00Z');const off=new Date(guess.toLocaleString('en-US',{timeZone:tz}))-new Date(guess.toLocaleString('en-US',{timeZone:'UTC'}));return new Date(guess-off)}
const at=instant(),box=document.getElementById('count');
function tick(){if(!at){box.remove();return}let s=Math.max(0,(at-Date.now())/1000);const u=[['days',86400],['hours',3600],['min',60],['sec',1]].map(([n,k])=>{const v=Math.floor(s/k);s-=v*k;return '<div><b>'+v+'</b><small>'+n+'</small></div>'});box.innerHTML=at>Date.now()?u.join(''):'<div><b>Today!</b></div>'}
tick();setInterval(tick,1000);
document.getElementById('share').onclick=e=>{e.preventDefault();const d={title:document.title,url:location.href};if(navigator.share)navigator.share(d).catch(()=>{});else{navigator.clipboard?.writeText(location.href);e.target.textContent='Link copied'}};
</script></body></html>`;
}

export const invite: Service = {
  id: 'invitation', name: 'Invitation', priceUsd: 3,
  blurb: 'A painted invitation card to share, and an invite page with a countdown, directions, an add-to-calendar file and one-tap RSVP.',
  team: ['analyst', 'writer', 'illustrator', 'producer', 'auditor'],
  fields,
  example: { occasion: "Tolu's 30th birthday", host: 'Tolu and family', when: 'Saturday 13 December 2026, 4pm till late', where: 'The Wings Hall, 12 Admiralty Way, Lekki, Lagos', rsvp: 'WhatsApp +234 803 000 0000 by 1 December', extra: 'Aso-ebi: emerald and gold. Small chops, live band, no gifts needed', style: 'Glamorous, warm, a bit of Lagos' },
  run,
};
