// Jingle: a short song for a business. The writer writes the words, the producer writes the score (key, tempo,
// groove, chords and a melody note for every syllable), the illustrator paints the cover, and the score is
// played by synth.ts on the server. The score is a TEE-signed model answer and the render is deterministic, so
// the song's sha256 can be checked by anyone who renders the signed score again.
import { createHash } from 'node:crypto';
import type { Job } from '../job.ts';
import { llmJson } from '../tools.ts';
import { direct, esc, type Palette } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';
import { GROOVES, arrange, render, type Line, type Song } from './synth.ts';

const fields: Field[] = [
  { key: 'business', label: 'Business', hint: 'Sunrise Bakery' },
  { key: 'what', label: 'What it should say', hint: 'Fresh bread from 6am, the best puff-puff in Yaba, come say good morning', long: true },
  { key: 'feel', label: 'How it should sound', hint: 'Afrobeats, happy, a bit cheeky', optional: true },
  { key: 'tagline', label: 'A line it must include', hint: 'Sunrise, every morning', optional: true },
];

type Words = { title: string; verse: { text: string; syllables: string[] }[]; hook: { text: string; syllables: string[] }[] };
type Music = {
  bpm: number; key: string; mode: 'major' | 'minor'; groove: Song['groove']; lead: Song['lead']; why: string;
  verseChords: string[]; hookChords: string[];
  verse: { degrees: number[]; beats: number[] }[]; hook: { degrees: number[]; beats: number[] }[];
};

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);

  job.log('writer', 'start', 'Writing the words');
  const words = await llmJson<Words>(job, 'writer', {
    reason: 'jingle lyrics',
    system: 'Write the words for a 40-second radio jingle for a small business. Two verse lines and two hook lines; the hook is what people hum, and it says the business name. Each line 5 to 9 syllables, plain everyday words, nothing the brief does not say (no invented prices or claims). Split every line into its sung syllables ("bak-er-y" is three: "Bak","er","y"). If the brief gives a line it must include, use it as a hook line. JSON {"title", "verse": [{"text","syllables":[...]}, ...2], "hook": [{"text","syllables":[...]}, ...2]}.',
    prompt: brief,
    dry: () => JSON.stringify({
      title: `${input.business} Song`,
      verse: [{ text: 'Fresh in the morning light', syllables: ['Fresh', 'in', 'the', 'mor', 'ning', 'light'] }, { text: 'Come and start your day right', syllables: ['Come', 'and', 'start', 'your', 'day', 'right'] }],
      hook: [{ text: input.business, syllables: input.business.split(/\s+/) }, { text: 'Every single day', syllables: ['Ev', 'ery', 'sin', 'gle', 'day'] }],
    }),
    maxTokens: 600,
  });
  job.log('writer', 'done', `"${words.hook?.[0]?.text ?? words.title}"`);

  job.log('producer', 'start', 'Writing the score');
  const syl = (ls: Words['verse']) => ls.slice(0, 2).map((l, i) => `${i + 1}. ${l.syllables.join(' · ')} (${l.syllables.length} syllables)`).join('\n');
  const music = await llmJson<Music>(job, 'producer', {
    reason: 'jingle score',
    system: `You are a music producer scoring a jingle. Pick a tempo (70-140 bpm), a key (like C, D, F, G, A, Bb, Eb) and mode (major or minor), a groove from ${GROOVES.join(', ')}, and a lead sound from bell, flute, pluck, brass, whistle. Write four chords for the verse and four for the hook, one per bar, as symbols like C, Am, F, G7, Dm7, Bbmaj7, Esus4 (no slash chords). Then a melody for each line: one scale degree per syllable (1 is the key's tonic, 8 the tonic an octave up, 2-7 the rest of the scale; keep it in 1-10) and one length in beats per syllable (0.5, 1, 1.5 or 2), adding up to about 7 beats per line. Make the hook catchy: repeat a shape, land the business name on strong notes, end the hook on 1. JSON {"bpm","key","mode","groove","lead","why" (one sentence on the choices),"verseChords":[4],"hookChords":[4],"verse":[{"degrees":[...],"beats":[...]},{...}],"hook":[{...},{...}]}.`,
    prompt: `Brief:\n${brief}\n\nVerse syllables:\n${syl(words.verse)}\n\nHook syllables:\n${syl(words.hook)}`,
    dry: () => JSON.stringify({
      bpm: 104, key: 'D', mode: 'major', groove: /afro/i.test(input.feel ?? '') ? 'afrobeats' : 'pop', lead: 'bell', why: 'Bright and quick, like a morning.',
      verseChords: ['D', 'Bm', 'G', 'A'], hookChords: ['G', 'A', 'Bm', 'D'],
      verse: words.verse.map((l) => ({ degrees: l.syllables.map((_, i) => [3, 3, 2, 1, 2, 3, 5, 4][i % 8]), beats: l.syllables.map((_, i) => (i === l.syllables.length - 1 ? 2 : 1)) })),
      hook: words.hook.map((l) => ({ degrees: l.syllables.map((_, i) => [5, 6, 5, 3, 1, 2, 3, 1][i % 8]), beats: l.syllables.map((_, i) => (i === l.syllables.length - 1 ? 2 : 1)) })),
    }),
    maxTokens: 900,
  });
  const line = (w: Words['verse'][number], m?: { degrees: number[]; beats: number[] }): Line => ({ text: w.text, syllables: w.syllables, degrees: m?.degrees ?? [], beats: m?.beats ?? [] });
  const song: Song = {
    title: words.title, bpm: music.bpm, key: /^[A-G][#b]?$/.test(music.key) ? music.key : 'C', mode: music.mode === 'minor' ? 'minor' : 'major',
    groove: GROOVES.includes(music.groove) ? music.groove : 'pop', lead: ['bell', 'flute', 'pluck', 'brass', 'whistle'].includes(music.lead) ? music.lead : 'bell',
    verseChords: music.verseChords ?? [], hookChords: music.hookChords ?? [],
    verse: words.verse.slice(0, 2).map((w, i) => line(w, music.verse?.[i])), hook: words.hook.slice(0, 2).map((w, i) => line(w, music.hook?.[i])),
  };
  job.log('producer', 'note', `${song.key} ${song.mode}, ${music.bpm} bpm, ${song.groove}, ${song.lead} lead: ${music.why ?? ''}`.trim());

  const score = arrange(song);
  const out = render(score);
  const sha = createHash('sha256').update(out.wav).digest('hex');
  job.log('producer', 'done', `Rendered ${out.seconds.toFixed(0)} seconds · sha256 ${sha.slice(0, 12)}…`);

  const art = await direct(job, `${brief}\nThe song: ${song.title}, ${song.groove}, ${song.mode}`, 'single cover', {
    palette: { bg: '#FFF4E2', ink: '#2A1A0E', accent: '#E8572A', soft: '#FFE2C2' }, font: 'Syne',
    image: `Album cover art for a cheerful jingle about ${input.business}: ${input.what}`,
  });

  const lyrics = [...song.verse, ...song.hook, ...song.hook].map((l) => l.text);
  const check = await audit(job, brief, `Title: ${song.title}\nLyrics:\n${lyrics.join('\n')}`);
  const html = player(input.business, song, score.bpm, out, sha, art);
  return {
    summary: `A ${out.seconds.toFixed(0)}-second ${song.groove} jingle for ${input.business}, with its cover, its lyrics and the score it was played from.`,
    check,
    site: { path: `/sites/${job.orderId}/`, html },
    audio: { path: `/sites/${job.orderId}/song.wav`, sha256: sha, seconds: out.seconds, wav: out.wav, score },
  };
}

/** The song's page: the cover, a play button, the words lighting up as they're sung, and the score's facts. */
function player(business: string, s: Song, bpm: number, out: ReturnType<typeof render>, sha: string, a: { palette: Palette; font: string; image: string }) {
  const p = a.palette, font = a.font.replace(/ /g, '+');
  // the sung syllables in order, with their times, grouped into the lines they belong to
  const lines: { text: string; syl: { s: string; t: number; len: number; m: number; sp: boolean }[] }[] = [];
  let k = 0;
  for (const l of [...s.verse, ...s.hook, ...s.hook]) {
    const n = Math.min(l.syllables.length, 14);
    // a space after a syllable only where a word of the line ends
    const ends = new Set<number>(); let acc = 0;
    for (const w of l.text.split(/\s+/)) { acc += w.replace(/[^\p{L}\p{N}]/gu, '').length; ends.add(acc); }
    let seen = 0;
    const syl = out.times.slice(k, k + n).map((x) => { seen += (x.syl ?? '').replace(/[^\p{L}\p{N}]/gu, '').length; return { s: x.syl ?? '', t: x.t, len: x.len, m: x.midi, sp: ends.has(seen) }; });
    k += n;
    lines.push({ text: l.text, syl });
  }
  const data = JSON.stringify(lines).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.title)} · ${esc(business)}</title>
<link href="https://fonts.googleapis.com/css2?family=${font}:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:${p.bg};--ink:${p.ink};--accent:${p.accent};--soft:${p.soft}}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--ink);font:16px/1.5 Inter,system-ui,sans-serif;min-height:100vh}
.wrap{max-width:1040px;margin:0 auto;padding:40px 24px;display:grid;grid-template-columns:420px 1fr;gap:48px;align-items:start}
.cover{position:relative;border-radius:24px;overflow:hidden;aspect-ratio:1;background:var(--soft);box-shadow:0 30px 60px -30px rgba(0,0,0,.35)}
.cover img{width:100%;height:100%;object-fit:cover;display:block;transition:transform 8s linear}.playing .cover img{transform:scale(1.08)}
.label{position:absolute;left:18px;bottom:18px;right:18px;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.5)}
.label b{display:block;font:800 34px/1 '${a.font}',sans-serif;letter-spacing:-.02em}
.play{margin-top:20px;display:flex;align-items:center;gap:16px}
button{width:64px;height:64px;border-radius:50%;border:0;background:var(--accent);color:#fff;font-size:22px;cursor:pointer;flex:none}
.bar{flex:1;height:6px;border-radius:3px;background:color-mix(in srgb,var(--ink) 12%,transparent);overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--accent)}
.facts{margin-top:22px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.facts div{background:var(--soft);border-radius:12px;padding:10px}.facts small{display:block;opacity:.6;font-size:11px}.facts b{font-size:15px}
h1{font:800 clamp(36px,5vw,60px)/1 '${a.font}',sans-serif;letter-spacing:-.02em;margin-bottom:6px}
.by{opacity:.65;margin-bottom:28px}
.lyrics p{font:600 26px/1.35 '${a.font}',sans-serif;margin:0 0 10px;opacity:.35;transition:opacity .2s}
.lyrics p.on{opacity:1}.lyrics span{transition:color .1s}.lyrics span.sung{color:var(--accent)}
.lyrics .tag{font:600 11px/1 Inter;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin:18px 0 8px}
.roll{margin-top:28px;width:100%;height:120px;background:var(--soft);border-radius:14px}
.proof{margin-top:22px;font-size:12px;opacity:.7;word-break:break-all}.proof a{color:inherit}
@media(max-width:860px){.wrap{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
<div><div class="cover"><img src="${a.image}" alt=""><div class="label"><small>${esc(business)}</small><b>${esc(s.title)}</b></div></div>
<div class="play"><button id="b" aria-label="Play">▶</button><div class="bar"><i id="pr"></i></div></div>
<audio id="a" src="song.wav" preload="auto"></audio>
<div class="facts"><div><small>Key</small><b>${esc(s.key)} ${s.mode}</b></div><div><small>Tempo</small><b>${bpm} bpm</b></div><div><small>Groove</small><b>${esc(s.groove)}</b></div><div><small>Length</small><b>${out.seconds.toFixed(0)} s</b></div></div>
<p class="proof">Written, scored and painted by the agents of Parallax. Played from its score with no samples: the same score always gives the same file.<br>sha256 ${sha} · <a href="song.wav" download>download the WAV</a></p></div>
<div><h1>${esc(s.title)}</h1><p class="by">A jingle for ${esc(business)}</p><div class="lyrics" id="ly"></div><canvas class="roll" id="roll"></canvas></div>
</div>
<script>
const L=${data};const a=document.getElementById('a'),b=document.getElementById('b'),ly=document.getElementById('ly'),pr=document.getElementById('pr');
const tags=['Verse','','Hook','','Hook',''];
L.forEach((l,i)=>{if(tags[i]){const t=document.createElement('div');t.className='tag';t.textContent=tags[i];ly.appendChild(t)}const p=document.createElement('p');l.syl.forEach((x,j)=>{const s=document.createElement('span');s.textContent=x.s+(x.sp&&j<l.syl.length-1?' ':'');s.dataset.t=x.t;p.appendChild(s)});ly.appendChild(p)});
const spans=[...ly.querySelectorAll('span')],ps=[...ly.querySelectorAll('p')];
b.onclick=()=>{if(a.paused){a.play();b.textContent='❚❚';document.body.classList.add('playing')}else{a.pause();b.textContent='▶';document.body.classList.remove('playing')}};
a.onended=()=>{b.textContent='▶';document.body.classList.remove('playing')};
const cv=document.getElementById('roll'),cx=cv.getContext('2d');const notes=L.flatMap(l=>l.syl);const lo=Math.min(...notes.map(n=>n.m)),hi=Math.max(...notes.map(n=>n.m))+1;
function draw(){const w=cv.width=cv.clientWidth*2,h=cv.height=cv.clientHeight*2,t=a.currentTime,dur=a.duration||${out.seconds};cx.clearRect(0,0,w,h);
notes.forEach((n,i)=>{const x=n.t/dur*w,y=h*.12+(1-(n.m-lo)/(hi-lo))*h*.7;cx.fillStyle=n.t<=t?getComputedStyle(document.body).getPropertyValue('--accent'):'rgba(0,0,0,.18)';cx.fillRect(x,y,Math.max(4,n.len/dur*w-2),10)});
cx.fillStyle='rgba(0,0,0,.5)';cx.fillRect(t/dur*w,0,3,h);
pr.style.width=(t/dur*100)+'%';spans.forEach(s=>s.classList.toggle('sung',+s.dataset.t<=t&&t>0));ps.forEach(p=>{const ss=[...p.children];p.classList.toggle('on',t>0&&+ss[0].dataset.t<=t+0.6&&(!ss.length||t<=+ss[ss.length-1].dataset.t+1.6))});requestAnimationFrame(draw)}
draw();
</script></body></html>`;
}

export const jingle: Service = {
  id: 'jingle', name: 'Jingle', priceUsd: 3,
  blurb: 'A 40-second song for your business: words written, melody and chords scored, played, a cover painted, and checked.',
  team: ['writer', 'producer', 'analyst', 'illustrator', 'auditor'],
  // the score is its own auction: the producer and the analyst bid to write it, apart from the lyricists
  groups: [{ title: 'Writing', roles: ['writer'] }, { title: 'Music', roles: ['producer', 'analyst'] }, { title: 'Visuals', roles: ['illustrator'] }, { title: 'Checking', roles: ['auditor'] }],
  fields,
  example: { business: 'Sunrise Bakery', what: 'Fresh bread from 6am every day, the softest agege bread and puff-puff in Yaba. Come say good morning.', feel: 'Afrobeats, happy, a bit cheeky', tagline: 'Sunrise, every morning' },
  run,
};
