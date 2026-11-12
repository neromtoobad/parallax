// Arcade: a small game for a business, playable on a phone in the browser. The writer designs it (who you play,
// what you catch and what you dodge, the words on screen), the illustrator paints the backdrop, the producer
// builds it on a tested game engine (catch-and-dodge with levels, a combo meter and a best score), and the
// auditor checks the words. The game code is ours and fixed; the agents choose everything in it.
import type { Job } from '../job.ts';
import { llmJson, picture } from '../tools.ts';
import { asFile, esc, placeholder } from './art.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'business', label: 'Business', hint: 'Sunrise Bakery' },
  { key: 'idea', label: 'What the game is about', hint: 'Catch the fresh bread coming out of the oven, dodge the burnt ones', long: true },
  { key: 'prize', label: 'A prize for a high score', hint: 'Score 300 and show this screen for a free puff-puff', optional: true },
];

type Design = {
  title: string; tagline: string; player: { emoji: string; name: string };
  good: { emoji: string; name: string; points: number }[]; bad: { emoji: string; name: string }[]; power: { emoji: string; name: string };
  palette: { sky: string; ground: string; ink: string; accent: string };
  backdrop: string; howto: string; lose: string; win: string;
};

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  job.log('writer', 'start', 'Designing the game');
  const d = await llmJson<Design>(job, 'writer', {
    reason: 'game design',
    system: 'Design a one-minute catch-and-dodge phone game for a small business. The player slides along the bottom catching good things and dodging bad ones; one rare power-up slows everything down. Pick single emoji for each (they must be real, common emoji). Good items: 3, with points 10, 20 and 50 (rarer is worth more); every thing the brief says to catch must be one of them, keeping its real name even when the emoji is only close (puff-puff can be 🍩 named "puff-puff"); fill any spare slot with something the business really sells. Bad items: 2. A short title (max 4 words), a tagline, a one-line how-to, a line for game over, and a line celebrating a new best score (never mention a prize). Colours that suit the business as #rrggbb. A backdrop to paint: the place, wide, no people. JSON {"title","tagline","player":{"emoji","name"},"good":[{"emoji","name","points"}x3],"bad":[{"emoji","name"}x2],"power":{"emoji","name"},"palette":{"sky","ground","ink","accent"},"backdrop","howto","lose","win"}.',
    prompt: brief,
    dry: () => JSON.stringify({
      title: `${input.business} Rush`, tagline: 'Catch it while it is hot', player: { emoji: '🧺', name: 'basket' },
      good: [{ emoji: '🍞', name: 'bread', points: 10 }, { emoji: '🥐', name: 'croissant', points: 20 }, { emoji: '🍩', name: 'puff-puff', points: 50 }],
      bad: [{ emoji: '🔥', name: 'burnt loaf' }, { emoji: '🪳', name: 'cockroach' }], power: { emoji: '⏰', name: 'slow oven' },
      palette: { sky: '#FFE7C2', ground: '#C9783B', ink: '#2B1A0E', accent: '#E8572A' },
      backdrop: `The inside of ${input.business} at sunrise, ovens and shelves`, howto: 'Slide to catch the bread. Miss the burnt ones.', lose: 'Out of the oven! Try again.', win: input.prize || 'New best score!',
    }),
    maxTokens: 800,
  });
  job.log('writer', 'done', `"${d.title}": ${[...(d.good ?? []), ...(d.bad ?? [])].map((x) => x.emoji).join(' ')}`);

  const HEX = /^#[0-9a-f]{6}$/i;
  const pal = { sky: '#FFE7C2', ground: '#C9783B', ink: '#2B1A0E', accent: '#E8572A', ...Object.fromEntries(Object.entries(d.palette ?? {}).filter(([, v]) => HEX.test(String(v)))) };
  const back = await picture(job, 'illustrator', {
    prompt: `${d.backdrop}. A bright, simple illustrated game background, wide view, soft colours, low detail at the bottom, no people, no text.`,
    reason: 'game backdrop', size: '1024x1024', dry: () => placeholder({ bg: pal.sky, ink: pal.ink, accent: pal.accent, soft: pal.ground }),
  });
  job.log('illustrator', 'done', 'Backdrop painted');

  job.log('producer', 'start', 'Building the game');
  const bg = asFile(back, 'backdrop');
  const html = game(d, pal, bg.ref, input.business, input.prize?.trim() ?? '');
  job.log('producer', 'done', 'Playable on phones and desktop');
  const check = await audit(job, brief, `Title: ${d.title}\nTagline: ${d.tagline}\nHow to: ${d.howto}\nGood: ${d.good?.map((g) => `${g.emoji} ${g.name} ${g.points}`).join(', ')}\nBad: ${d.bad?.map((b) => `${b.emoji} ${b.name}`).join(', ')}\nGame over: ${d.lose}\nNew best: ${d.win}\nPrize shown (the customer's own words): ${input.prize || 'none'}\n\nFail it if a thing the brief says to catch is missing, or if it promises a prize the brief did not give.`);
  return {
    summary: `"${d.title}", a one-minute phone game for ${input.business}: designed, painted, built and checked.`,
    check, site: { path: `/sites/${job.orderId}/`, html }, files: bg.file ? [bg.file] : [],
  };
}

function game(d: Design, p: { sky: string; ground: string; ink: string; accent: string }, bg: string, business: string, prize = '') {
  const cfg = JSON.stringify({ player: d.player?.emoji || '🧺', good: (d.good ?? []).slice(0, 3), bad: (d.bad ?? []).slice(0, 2), power: d.power?.emoji || '⏰', win: d.win, lose: d.lose, prize }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${esc(d.title)} · ${esc(business)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;700&display=swap" rel="stylesheet">
<style>
:root{--ink:${p.ink};--a:${p.accent};--sky:${p.sky};--g:${p.ground}}
*{box-sizing:border-box;margin:0}html,body{height:100%;overflow:hidden;touch-action:none}body{background:var(--sky);font-family:Fredoka,sans-serif;color:var(--ink);display:grid;place-items:center}
.box{position:relative;width:min(100vw,calc(100vh*0.62));height:min(100vh,calc(100vw/0.62));overflow:hidden;background:url('${bg}') center/cover}
canvas{position:absolute;inset:0;width:100%;height:100%}
.hud{position:absolute;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;font:700 22px Fredoka;color:#fff;text-shadow:0 2px 0 rgba(0,0,0,.35)}
.card{position:absolute;inset:0;display:grid;place-items:center;background:color-mix(in srgb,var(--sky) 55%,transparent);backdrop-filter:blur(3px);text-align:center;padding:24px}
.card h1{font:700 clamp(34px,9vw,52px)/1 Fredoka;letter-spacing:-.01em}.card p{font-size:18px;margin:10px auto 0;max-width:24ch}
.card .items{font-size:30px;margin:18px 0 6px;letter-spacing:6px}
.card button{margin-top:22px;font:700 20px Fredoka;border:0;border-radius:999px;padding:14px 34px;background:var(--a);color:#fff;cursor:pointer;box-shadow:0 5px 0 color-mix(in srgb,var(--a) 60%,#000)}
.card small{display:block;margin-top:14px;opacity:.6}.hide{display:none}
</style></head><body><div class="box" id="box"><canvas id="c"></canvas>
<div class="hud"><span id="sc">0</span><span id="tm">60</span><span id="lv">♥♥♥</span></div>
<div class="card" id="start"><div><h1>${esc(d.title)}</h1><p>${esc(d.tagline)}</p><div class="items">${(d.good ?? []).map((g) => g.emoji).join('')}</div><p>${esc(d.howto)}</p>${prize ? `<p style="margin-top:8px;font-weight:700;color:var(--a)">${esc(prize)}</p>` : ''}<button id="go">Play</button><small>${esc(business)} · made by the agents of Parallax</small></div></div>
<div class="card hide" id="over"><div><h1 id="ot"></h1><p id="om"></p><p id="best"></p><p id="pz" style="font-weight:700;color:var(--a)"></p><button id="again">Again</button></div></div></div>
<script>
const C=${cfg};const box=document.getElementById('box'),cv=document.getElementById('c'),x=cv.getContext('2d');
let W,H,S;function size(){const r=box.getBoundingClientRect();W=cv.width=r.width*devicePixelRatio;H=cv.height=r.height*devicePixelRatio;S=W/400}size();addEventListener('resize',size);
let px=0.5,items=[],score=0,lives=3,t0=0,last=0,slow=0,combo=0,run=false,pops=[];
const best=()=>{try{return +localStorage.getItem('best')||0}catch{return 0}};
const move=e=>{const r=box.getBoundingClientRect();const cx=(e.touches?e.touches[0].clientX:e.clientX);px=Math.max(.06,Math.min(.94,(cx-r.left)/r.width))};
box.addEventListener('pointermove',move);box.addEventListener('touchmove',e=>{move(e);e.preventDefault()},{passive:false});
addEventListener('keydown',e=>{if(e.key==='ArrowLeft')px=Math.max(.06,px-.06);if(e.key==='ArrowRight')px=Math.min(.94,px+.06)});
function spawn(el){const lvl=1+el/15;const r=Math.random();let it;
 if(r<.04)it={e:C.power,k:'p'};else if(r<.04+Math.min(.42,.18+el/150)){const b=C.bad[Math.floor(Math.random()*C.bad.length)];it={e:b.emoji,k:'b'}}
 else{const g=Math.random()<.6?C.good[0]:Math.random()<.75?C.good[1]:C.good[2];it={e:g.emoji,k:'g',pts:+g.points||10}}
 it.x=.06+Math.random()*.88;it.y=-.05;it.v=(.18+Math.random()*.12)*lvl;it.r=Math.random()*6.28;items.push(it)}
let acc=0;function frame(ts){if(!run)return;const dt=Math.min(.05,(ts-last)/1000||0);last=ts;const el=(ts-t0)/1000;
 const left=Math.max(0,60-el);document.getElementById('tm').textContent=Math.ceil(left);
 acc+=dt*(1.1+el/20);while(acc>1){acc-=1;spawn(el)}
 const k=slow>0?.45:1;slow-=dt;
 x.clearRect(0,0,W,H);
 for(const it of items){it.y+=it.v*dt*k;it.r+=dt*2;
  if(it.y>.86&&it.y<.95&&Math.abs(it.x-px)<.09&&!it.done){it.done=1;
   if(it.k==='g'){combo++;const add=it.pts*(combo>=5?2:1);score+=add;pops.push({x:it.x,y:.84,t:0,s:'+'+add+(combo>=5?' x2':'')})}
   else if(it.k==='b'){lives--;combo=0;pops.push({x:it.x,y:.84,t:0,s:'ouch'});if(navigator.vibrate)navigator.vibrate(60)}
   else{slow=4;pops.push({x:it.x,y:.84,t:0,s:'slow!'})}}
  if(it.y>1.05&&it.k==='g'&&!it.done){it.done=1;combo=0}
  x.save();x.translate(it.x*W,it.y*H);x.rotate(Math.sin(it.r)*.25);x.font=(34*S)+'px serif';x.textAlign='center';x.textBaseline='middle';x.fillText(it.e,0,0);x.restore()}
 items=items.filter(i=>!i.done&&i.y<1.1);
 x.font=(48*S)+'px serif';x.textAlign='center';x.textBaseline='middle';x.fillText(C.player,px*W,.9*H);
 x.font='700 '+(20*S)+'px Fredoka';for(const p of pops){p.t+=dt;x.globalAlpha=Math.max(0,1-p.t);x.fillStyle='#fff';x.strokeStyle='rgba(0,0,0,.4)';x.lineWidth=4*S;x.strokeText(p.s,p.x*W,(p.y-p.t*.08)*H);x.fillText(p.s,p.x*W,(p.y-p.t*.08)*H)}x.globalAlpha=1;pops=pops.filter(p=>p.t<1);
 if(combo>=5){x.fillStyle='rgba(255,255,255,.9)';x.font='700 '+(16*S)+'px Fredoka';x.fillText('COMBO x2',W/2,.12*H)}
 document.getElementById('sc').textContent=score;document.getElementById('lv').textContent='♥'.repeat(Math.max(0,lives));
 if(lives<=0||left<=0)return end(lives>0);requestAnimationFrame(frame)}
function start(){items=[];pops=[];score=0;lives=3;combo=0;slow=0;acc=0;run=true;t0=last=performance.now();document.getElementById('start').classList.add('hide');document.getElementById('over').classList.add('hide');requestAnimationFrame(frame)}
function end(timeUp){run=false;const b=best(),nb=score>b;try{if(nb)localStorage.setItem('best',score)}catch{}
 document.getElementById('ot').textContent=score+' points';document.getElementById('om').textContent=nb&&score>0?C.win:C.lose;document.getElementById('best').textContent='Best: '+Math.max(b,score);document.getElementById('pz').textContent=C.prize||'';document.getElementById('over').classList.remove('hide')}
document.getElementById('go').onclick=start;document.getElementById('again').onclick=start;
</script></body></html>`;
}

export const arcade: Service = {
  id: 'arcade', name: 'Arcade game', priceUsd: 3,
  blurb: 'A one-minute phone game for your business: designed around what you sell, with a painted backdrop, levels, combos and a best score.',
  team: ['writer', 'illustrator', 'producer', 'auditor'],
  fields,
  example: { business: 'Sunrise Bakery', idea: 'Catch the fresh agege bread and puff-puff coming out of the oven, dodge the burnt loaves', prize: 'Score 300 and show this screen at the counter for a free puff-puff' },
  run,
};
