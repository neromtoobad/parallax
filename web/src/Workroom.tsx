// The building, live: the auction hall upstairs, the team's desks in the middle, the counter at street level.
// Every lot, sealed bid, reveal, award, work step and payout of one job becomes a beat, and the beats play in
// order, so a finished job replays and a running one plays as the events arrive.
import { useEffect, useMemo, useRef, useState } from 'react';
import { usd, type Order, type Step } from './api.ts';
import type { LiveLot } from './parts.tsx';
import { idOf, NAMES } from './team.ts';

type Beat =
  | { k: 'open'; key: string; title: string; reserve: number }
  | { k: 'commit'; key: string; who: string }
  | { k: 'quote'; key: string; handle: string; price: number; entered: boolean }
  | { k: 'reveal'; key: string; who: string; price: number }
  | { k: 'award'; key: string; title: string; who: string; pay?: number }
  | { k: 'void'; key: string; title: string }
  | { k: 'step'; key: string; who: string; text: string; kind: string }
  | { k: 'inspect'; key: string; title: string; who: string; pass: boolean }
  | { k: 'deliver' | 'accept' | 'reject' | 'stop'; key: string; text?: string };

// How long each beat holds the screen before the next one, in ms.
const HOLD: Record<Beat['k'], number> = { open: 1300, commit: 650, quote: 900, reveal: 750, award: 1900, void: 1200, step: 1700, inspect: 1100, deliver: 1200, accept: 2600, reject: 1600, stop: 1600 };

const ROSTER = Object.keys(NAMES);
const name = (id?: string) => (id ? NAMES[id] ?? id.replace(/^outside:/, '') : '');

// The stage picture is 1115 x 1102; everything below is in its pixels.
const W = 1115, H = 1102;
const FLOOR = [430, 740, 1040]; // the line the feet walk on: hall, desks, street
const STAIR = 992;              // the stairwell on the right joins all three floors
const SPEED = 150;              // walking speed, px per second, the same for every walk
// One step (heel to heel) in the walk sheets is about 65 px of a 200 px figure, 40 px here; the cycle is four
// frames over two steps, so each frame is held for half a step and the planted foot keeps still on the floor.
const STEP = 40;
const WALK = ['walk1', 'walk2', 'walk3', 'walk4'] as const;
const BOARD = 557;              // the middle of the auction board; people in the hall turn to it
const COUNTER = { x: 440, y: 996, past: 652 }; // behind the counter, and the gap at its right end
const HALL = [470, 640, 390, 720, 310, 800, 230, 880];
// The whole team sits facing out behind two long desks, a raised back row of eight and a front row of six. Each
// desk front is its own layer (design/scripts/desks.py), drawn over the row seated behind it. People walk along
// behind their desk at `walk`, step out past its right end at `exit`, and a seated sprite stands at `sit` so the
// laptop on its knees rests on the desk top.
type Row = 'back' | 'front';
const ROWS: Record<Row, { walk: number; sit: number; top: number; exit: number; z: number }> = {
  back: { walk: 694, sit: 682, top: 630, exit: 932, z: 1 },
  front: { walk: 722, sit: 710, top: 658, exit: 872, z: 3 },
};
const SEATS: Record<string, { row: Row; x: number }> = {
  'researcher-2': { row: 'back', x: 286 }, reader: { row: 'back', x: 376 }, 'writer-2': { row: 'back', x: 457 },
  'illustrator-2': { row: 'back', x: 539 }, producer: { row: 'back', x: 617 }, investigator: { row: 'back', x: 685 },
  auditor: { row: 'back', x: 758 }, 'auditor-2': { row: 'back', x: 834 },
  scout: { row: 'front', x: 246 }, researcher: { row: 'front', x: 343 }, writer: { row: 'front', x: 440 },
  illustrator: { row: 'front', x: 547 }, analyst: { row: 'front', x: 643 }, messenger: { row: 'front', x: 745 },
};
// Frames in each strip (web/public/agents/poses/<name>.webp, made by design/scripts/poses.py), all facing right;
// 'type' and 'look' are seated, facing out.
const FRAMES = ['idle', ...WALK, 'type', 'cheer', 'bid', 'box', 'coin', 'look'] as const;
type Pose = 'idle' | 'bid' | 'cheer' | 'box' | 'coin';
const cq = (px: number) => `${(px / W) * 100}cqw`;

/** The beats of one job, in the order they happened. Keys stay the same between the live stream and the saved order. */
function beatsOf(o: Order, lots: LiveLot[], steps: Step[]): Beat[] {
  const out: Beat[] = [];
  for (const l of lots) {
    const r = `${l.title}:${l.round ?? 1}`;
    out.push({ k: 'open', key: `o:${r}`, title: l.title, reserve: l.reserve });
    const sealed = [...new Set([...(l.sealed ?? []), ...l.bids.map((b) => b.agent)].map((a) => idOf(a) ?? a))];
    for (const a of sealed) out.push({ k: 'commit', key: `c:${r}:${a}`, who: a });
    for (const q of l.quotes ?? []) out.push({ k: 'quote', key: `q:${r}:${q.handle}`, handle: q.handle, price: q.price, entered: q.entered });
    for (const b of l.bids) out.push({ k: 'reveal', key: `r:${r}:${idOf(b.agent)}`, who: idOf(b.agent)!, price: b.price });
    if (l.winner) out.push({ k: 'award', key: `a:${r}`, title: l.title, who: l.winner.startsWith('outside:') ? l.winner : idOf(l.winner)!, pay: l.pay });
    if (l.status === 'void') out.push({ k: 'void', key: `v:${r}`, title: l.title });
  }
  for (const s of steps) {
    const who = s.account === 'cfo' || s.agent === 'cfo' ? 'cfo' : idOf(s.account) ?? s.agent;
    out.push({ k: 'step', key: `s:${s.at}:${s.text.slice(0, 24)}`, who, text: s.text, kind: s.kind });
  }
  for (const l of lots) if (l.status === 'passed' || l.status === 'failed')
    out.push({ k: 'inspect', key: `i:${l.title}`, title: l.title, who: l.winner?.startsWith('outside:') ? l.winner : idOf(l.winner) ?? '', pass: l.status === 'passed' });
  if (['delivered', 'accepted', 'rejected'].includes(o.state)) out.push({ k: 'deliver', key: 'deliver' });
  if (o.state === 'accepted') out.push({ k: 'accept', key: 'accept' });
  if (o.state === 'rejected') out.push({ k: 'reject', key: 'reject' });
  if (o.state === 'failed') out.push({ k: 'stop', key: 'stop', text: o.error });
  return out;
}

// 'desk' is an agent's own chair.
type Place = 'desk' | 'street' | { hall: number };
type Scene = {
  place: Record<string, Place>;
  pose: Record<string, Pose>;
  tag: Record<string, string>; // a small label over a head: a price, a lot won ('sealed' shows as the envelope pose)
  bubble?: { who: string; text: string; kind: string; key: string };
  board?: { title: string; reserve: number; rows: { who: string; price?: number; outside?: boolean }[]; winner?: string };
  pills: { handle: string; price: number; entered: boolean }[];
  won: Record<string, number>; // agent → pay, for the coins at the end
  glow: Set<string>;
  caption: string;
  log: string[];
  end?: 'accepted' | 'rejected' | 'stopped';
};

function fold(beats: Beat[]): Scene {
  const s: Scene = { place: {}, pose: {}, tag: {}, pills: [], won: {}, glow: new Set(), caption: 'The team is at their desks, waiting for a job.', log: [] };
  const toDesk = (keep?: string) => {
    for (const [a, p] of Object.entries(s.place)) if (typeof p === 'object' && a !== keep) { s.place[a] = 'desk'; delete s.pose[a]; }
  };
  const untag = () => { for (const a of Object.keys(s.tag)) if (!s.tag[a].startsWith('won')) delete s.tag[a]; };
  for (const b of beats) {
    s.bubble = undefined;
    for (const [a, p] of Object.entries(s.pose)) if (p === 'cheer') { delete s.pose[a]; if (typeof s.place[a] === 'object') s.place[a] = 'desk'; }
    switch (b.k) {
      case 'open':
        toDesk();
        untag();
        s.board = { title: b.title, reserve: b.reserve, rows: [] };
        s.pills = [];
        s.caption = `${b.title} goes to auction. Reserve ${usd(b.reserve)} USDC.`;
        break;
      case 'commit': {
        const taken = new Set(Object.values(s.place).filter((p) => typeof p === 'object').map((p) => (p as { hall: number }).hall));
        s.place[b.who] = { hall: HALL.findIndex((_, i) => !taken.has(i)) % HALL.length };
        s.pose[b.who] = 'bid';
        s.tag[b.who] = 'sealed';
        s.board?.rows.push({ who: b.who });
        s.caption = `${name(b.who)} commits a sealed bid. Nobody can see the price yet.`;
        break;
      }
      case 'quote':
        s.pills.push({ handle: b.handle, price: b.price, entered: b.entered });
        if (b.entered) s.board?.rows.push({ who: `outside:${b.handle}`, price: b.price, outside: true });
        s.caption = b.entered ? `${b.handle} from the NEAR Agent Market bids ${usd(b.price)} USDC.` : `${b.handle} from the Agent Market quotes ${usd(b.price)}, above the reserve.`;
        break;
      case 'reveal': {
        const row = s.board?.rows.find((r) => r.who === b.who);
        if (row) row.price = b.price;
        delete s.pose[b.who];
        s.tag[b.who] = `${usd(b.price)}`;
        s.caption = `${name(b.who)} reveals ${usd(b.price)} USDC. The bank checks it against the hash.`;
        break;
      }
      case 'award':
        if (s.board) s.board.winner = b.who;
        toDesk(b.who);
        untag();
        if (!b.who.startsWith('outside:')) {
          s.glow.add(b.who);
          s.pose[b.who] = 'cheer';
          s.tag[b.who] = `won ${b.title.toLowerCase()}`;
          s.won[b.who] = (s.won[b.who] ?? 0) + (b.pay ?? 0);
        }
        s.caption = `${name(b.who)} wins ${b.title.toLowerCase()} for ${usd(b.pay)} USDC, held in escrow until you accept.`;
        break;
      case 'void':
        toDesk();
        s.caption = `Nobody bid under the reserve for ${b.title.toLowerCase()}.`;
        break;
      case 'step':
        if (b.who !== 'cfo' && s.place[b.who] && s.place[b.who] !== 'street') s.place[b.who] = 'desk';
        s.bubble = { who: b.who, text: b.text, kind: b.kind, key: b.key };
        s.caption = `${b.who === 'cfo' ? 'The CFO' : name(b.who)}: ${b.text}`;
        break;
      case 'inspect':
        if (b.who && !b.who.startsWith('outside:')) s.tag[b.who] = b.pass ? 'passed ✓' : 'failed ✗';
        if (!b.pass) delete s.won[b.who];
        s.caption = `The auditor ${b.pass ? 'passes' : 'fails'} ${b.title.toLowerCase()}.${b.pass ? '' : ' That part is paid nothing.'}`;
        break;
      case 'deliver':
        toDesk();
        s.place.messenger = 'street';
        s.pose.messenger = 'box';
        s.caption = 'Kit carries the finished work down to the counter. The money waits for your answer.';
        break;
      case 'accept':
        s.end = 'accepted';
        delete s.pose.messenger;
        for (const a of Object.keys(s.won)) if (s.won[a] > 0 && a !== 'messenger') { s.place[a] = 'desk'; s.pose[a] = 'coin'; }
        s.caption = 'Accepted. The bank pays each winner from escrow, straight to their NEAR account.';
        break;
      case 'reject':
        s.end = 'rejected';
        s.place.messenger = 'desk';
        delete s.pose.messenger;
        s.caption = 'Rejected. The bank refunds the full price and nobody is paid.';
        break;
      case 'stop':
        s.end = 'stopped';
        s.caption = `The job stopped. ${b.text ?? ''}`.trim();
        break;
    }
    s.log.push(s.caption);
  }
  return s;
}

type Pt = { x: number; y: number; floor: number };
type Goal = Pt & { sit?: boolean; row?: Row };
/** The desk row someone is walking or sitting behind, if any. */
const rowAt = (p: Pt) => (p.floor === 1 ? (['back', 'front'] as Row[]).find((r) => Math.abs(p.y - ROWS[r].walk) < 1) : undefined);

function goalOf(id: string, p: Place): Goal {
  if (p === 'street') return { x: COUNTER.x, y: COUNTER.y, floor: 2 };
  if (typeof p === 'object') return { x: HALL[p.hall], y: FLOOR[0], floor: 0 };
  const seat = SEATS[id] ?? { row: 'front', x: 860 };
  return { x: seat.x, y: ROWS[seat.row].walk, floor: 1, sit: true, row: seat.row };
}

/** The way from one spot to another: out from behind a desk, along the floor to the stairwell, up or down it,
 * along to the goal and in behind its desk. */
function route(at: Pt, to: Goal): Pt[] {
  const out: Pt[] = [];
  const fromRow = rowAt(at);
  if (fromRow && fromRow === to.row) return [to];
  if (fromRow) out.push({ x: ROWS[fromRow].exit, y: at.y, floor: 1 }, { x: ROWS[fromRow].exit, y: FLOOR[1], floor: 1 });
  const from = out[out.length - 1] ?? at;
  const behindCounter = (p: Pt) => p.floor === 2 && p.y < FLOOR[2] - 10;
  if (behindCounter(from) && !behindCounter(to)) out.push({ x: COUNTER.past, y: FLOOR[2], floor: 2 });
  if (from.floor !== to.floor) {
    out.push({ x: STAIR, y: FLOOR[from.floor], floor: from.floor });
    const d = to.floor > from.floor ? 1 : -1;
    for (let f = from.floor + d; ; f += d) { out.push({ x: STAIR, y: FLOOR[f], floor: f }); if (f === to.floor) break; }
  }
  if (behindCounter(to) && !behindCounter(from)) out.push({ x: COUNTER.past, y: FLOOR[2], floor: 2 });
  if (to.row) out.push({ x: ROWS[to.row].exit, y: FLOOR[1], floor: 1 }, { x: ROWS[to.row].exit, y: to.y, floor: 1 });
  out.push(to);
  return out;
}

type Body = Pt & { id: string; path: Pt[]; goal: Goal; face: 1 | -1; walked: number; seated: boolean; moving: boolean; pose?: Pose; busy: boolean; el?: HTMLDivElement | null; spr?: HTMLDivElement | null; lab?: HTMLElement | null };

/** Everyone's position, moved every frame at one walking speed; React only says where each one should be. */
class Crowd {
  bodies = new Map<string, Body>();
  rush = 1;
  onArrive?: (id: string) => void;
  private raf = 0;
  private last = 0;

  constructor() { this.reset(); }

  reset() {
    for (const id of ROSTER) {
      const g = goalOf(id, 'desk');
      const old = this.bodies.get(id);
      this.bodies.set(id, { ...g, id, path: [], goal: g, face: g.x > BOARD ? -1 : 1, walked: 0, seated: !!g.sit, moving: false, busy: false, el: old?.el, spr: old?.spr, lab: old?.lab });
    }
  }

  aim(id: string, p: Place, pose: Pose | undefined, busy: boolean) {
    const b = this.bodies.get(id);
    if (!b) return;
    b.pose = pose;
    b.busy = busy;
    const g = goalOf(id, p);
    if (g.x === b.goal.x && g.y === b.goal.y && g.floor === b.goal.floor) { if (!b.path.length) b.seated = !!g.sit; b.goal = g; return; }
    b.goal = g;
    b.seated = false;
    b.path = route(b, g);
    b.moving = true;
  }

  /** True once nobody is still on the way to the hall (or, given an id, once that one has arrived). */
  settled(id?: string) {
    if (id) return !this.bodies.get(id)?.path.length;
    for (const b of this.bodies.values()) if (b.path.length && b.goal.floor === 0) return false;
    return true;
  }

  start() {
    const loop = (t: number) => {
      const dt = this.last ? Math.min(0.05, (t - this.last) / 1000) : 0;
      this.last = t;
      for (const b of this.bodies.values()) { this.step(b, dt); this.draw(b, t); }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this.raf); this.last = 0; }

  private step(b: Body, dt: number) {
    let left = SPEED * this.rush * dt;
    while (left > 0 && b.path.length) {
      const n = b.path[0];
      const dx = n.x - b.x, dy = n.y - b.y, d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) b.face = dx > 0 ? 1 : -1;
      if (d <= left) {
        b.x = n.x; b.y = n.y; b.floor = n.floor; b.walked += d; left -= d;
        b.path.shift();
      } else {
        b.x += (dx / d) * left; b.y += (dy / d) * left; b.walked += left; left = 0;
        // between floors, count as the upper one so nobody is hidden behind the floor they climb to
        if (Math.abs(dy) > 0) b.floor = Math.min(b.floor, n.floor);
      }
    }
    if (!b.path.length) {
      if (b.moving) { b.moving = false; this.onArrive?.(b.id); }
      b.seated = !!b.goal.sit;
      if (b.goal.floor === 0) b.face = b.x > BOARD ? -1 : 1;
    }
  }

  private draw(b: Body, t: number) {
    if (!b.el || !b.spr) return;
    const moving = b.path.length > 0;
    let frame: (typeof FRAMES)[number] = 'idle', lift = 0;
    if (moving) {
      // The passing frames stand taller than the contact ones, so the head already rises and falls with each step;
      // the box has a single carrying pose and gets a small bob instead.
      const phase = b.walked / STEP;
      if (b.pose === 'box') { frame = 'box'; lift = Math.abs(Math.sin(phase * Math.PI)) * 2.4; }
      else frame = WALK[Math.floor(phase * 2 + 0.5) % 4];
    } else if (b.seated) {
      // At work: head down typing, looking up now and then; while talking, mostly looking out.
      // Someone being paid looks up at the coin.
      const glance = b.pose === 'coin' || Math.sin(t / (b.busy ? 600 : 2300) + b.goal.x) > (b.busy ? -0.3 : 0.8);
      frame = glance ? 'look' : 'type';
      if (frame === 'type') lift = Math.sin(t / 55) > 0 ? 0.9 : 0;
    } else {
      frame = b.pose ?? 'idle';
      if (frame === 'cheer') lift = Math.abs(Math.sin(t / 160)) * 6;
      else lift = Math.sin(t / 700 + b.goal.x) * 0.6; // breathing
    }
    const row = rowAt(b);
    const sitting = b.seated && !moving && !!row;
    const y = sitting ? ROWS[row!].sit : b.y;
    const behind = b.floor === 2 && b.y < FLOOR[2] - 10;
    b.el.style.left = `${(b.x / W) * 100}%`;
    b.el.style.top = `${(y / H) * 100}%`;
    b.el.style.zIndex = row ? String(ROWS[row].z) : behind ? '3' : '5';
    b.el.classList.toggle('sit', sitting);
    if (b.lab) {
      // the name sits on the desk front while someone is behind it, under the feet otherwise
      b.lab.style.left = b.el.style.left;
      b.lab.style.top = `${((row ? ROWS[row].top + 5 : b.y + 6) / H) * 100}%`;
    }
    b.el.classList.toggle('hall', b.floor === 0 && b.y < FLOOR[0] + 5);
    b.el.classList.toggle('l', b.x < W * 0.2);
    b.el.classList.toggle('r', b.x > W * 0.78);
    b.spr.style.backgroundPositionX = `${(FRAMES.indexOf(frame) / (FRAMES.length - 1)) * 100}%`;
    const flip = frame !== 'type' && frame !== 'look' && frame !== 'cheer' && b.face < 0 ? -1 : 1;
    b.spr.style.transform = `translateY(${cq(-lift)}) scaleX(${flip})`;
  }
}

function Figure({ id, crowd, tag, glow, bubble }: { id: string; crowd: Crowd; tag?: string; glow: boolean; bubble?: Scene['bubble'] }) {
  const n = NAMES[id];
  const hold = (el: HTMLDivElement | null, k: 'el' | 'spr' | 'lab') => { const b = crowd.bodies.get(id); if (b) b[k] = el; };
  return (<>
    <div className={`wr-fig${glow ? ' glow' : ''}`} ref={(el) => hold(el, 'el')}>
      {bubble && <div className={`wr-bub ${bubble.kind}`} key={bubble.key}><b>{n}</b> {bubble.text.length > 90 ? `${bubble.text.slice(0, 88)}…` : bubble.text}</div>}
      {!bubble && tag && tag !== 'sealed' && <span className={`wr-tag${tag.startsWith('won') || tag.startsWith('passed') ? ' won' : tag.startsWith('failed') ? ' bad' : ''}`}>{tag}</span>}
      <div className="wr-spr" ref={(el) => hold(el, 'spr')} style={{ backgroundImage: `url(/agents/poses/${n.toLowerCase()}.webp)` }} role="img" aria-label={n} />
    </div>
    <small className="wr-name" ref={(el) => hold(el as HTMLDivElement | null, 'lab')}>{n}</small>
  </>);
}

/** A payout flying from the counter to its winner, along an arc. */
function Coin({ to, pay, delay }: { to: Pt; pay: number; delay: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = { x: COUNTER.x, y: 930 }, end = { x: to.x, y: to.y - 150 };
    const top = Math.min(from.y, end.y) - 140;
    const frames = Array.from({ length: 13 }, (_, i) => {
      const k = i / 12, x = from.x + (end.x - from.x) * k;
      const y = (1 - k) * (1 - k) * from.y + 2 * (1 - k) * k * top + k * k * end.y;
      return { left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, opacity: i === 0 ? 0 : 1, transform: `translate(-50%,-50%) scale(${i === 12 ? 1.08 : 1})` };
    });
    const a = el.animate(frames, { duration: 1300, delay, easing: 'cubic-bezier(.35,.1,.45,1)', fill: 'both' });
    return () => a.cancel();
  }, [to.x, to.y, delay]);
  return <span ref={ref} className="wr-coin">+{usd(pay)}</span>;
}

export function Workroom({ o, lots, steps, live }: { o: Order; lots: LiveLot[]; steps: Step[]; live?: boolean }) {
  const beats = useMemo(() => beatsOf(o, lots, steps), [o, lots, steps]);
  const byKey = useMemo(() => new Map(beats.map((b) => [b.key, b])), [beats]);
  const [played, setPlayed] = useState<string[]>([]);
  const [run, setRun] = useState(0);
  const crowd = useMemo(() => new Crowd(), []);
  const [kitIn, setKitIn] = useState(false);
  useEffect(() => {
    crowd.onArrive = (id) => id === 'messenger' && setKitIn(crowd.bodies.get(id)!.goal.floor === 2);
    crowd.start();
    return () => crowd.stop();
  }, [crowd]);
  useEffect(() => { setPlayed([]); setKitIn(false); crowd.reset(); }, [o.id, run]);
  useEffect(() => {
    const seen = new Set(played);
    const next = beats.find((b) => !seen.has(b.key));
    if (!next) { crowd.rush = 1; return; }
    const last = byKey.get(played[played.length - 1]);
    // A live job opened halfway through catches up faster; a replay plays at the normal pace.
    const behind = live ? beats.length - played.length : 0;
    const pace = behind > 14 ? 0.45 : behind > 6 ? 0.7 : 1;
    crowd.rush = behind > 14 ? 2.4 : behind > 6 ? 1.5 : 1;
    // Reveals and awards happen in the hall, and the payout at the counter, so those wait for people to get there.
    const ready = () => next.k === 'reveal' || next.k === 'award' ? crowd.settled() : next.k === 'accept' || next.k === 'reject' ? crowd.settled('messenger') : true;
    let t = 0, waited = 0;
    const go = () => {
      if (!ready() && waited < 8000) { waited += 150; t = window.setTimeout(go, 150); return; }
      setPlayed((p) => [...p, next.key]);
    };
    t = window.setTimeout(go, last ? HOLD[last.k] * pace : 500);
    return () => clearTimeout(t);
  }, [beats, played, live]);
  const scene = useMemo(() => fold(played.map((k) => byKey.get(k)!).filter(Boolean)), [played, byKey]);
  useEffect(() => {
    for (const id of ROSTER) crowd.aim(id, scene.place[id] ?? 'desk', scene.pose[id], scene.bubble?.who === id);
  }, [scene, crowd]);
  const caughtUp = played.length >= beats.length;
  const rows = (scene.board?.rows ?? []).slice().sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)).slice(0, 3);
  const coins = scene.end === 'accepted' ? Object.entries(scene.won).filter(([id, pay]) => pay > 0 && NAMES[id]) : [];

  return (
    <div className="wr">
      <div className="wr-stage">
        <img className="wr-bg" src="/stage.jpg" alt="The Parallax building: the auction hall, the team's desks and the street counter" />
        {scene.board && (
          <div className="wr-board">
            <b>{scene.board.title} <em>reserve {usd(scene.board.reserve)}</em></b>
            {rows.map((r) => (
              <div key={r.who} className={r.who === scene.board!.winner ? 'win' : ''}>
                <span>{r.outside && <i>market</i>}{name(r.who)}</span>
                <span className="num">{r.price === undefined ? '•••• sealed' : usd(r.price)}</span>
              </div>
            ))}
          </div>
        )}
        {scene.pills.length > 0 && (
          <div className="wr-pills">{scene.pills.slice(-3).map((p) => <span key={p.handle} className={p.entered ? '' : 'out'}>{p.handle} · {usd(p.price)}</span>)}</div>
        )}
        <img className="wr-desk back" src="/stage-desk-back.webp" alt="" />
        <img className="wr-desk front" src="/stage-desk-front.webp" alt="" />
        {ROSTER.map((id) => (
          <Figure key={id} id={id} crowd={crowd} tag={scene.tag[id]} glow={scene.glow.has(id)} bubble={scene.bubble?.who === id ? scene.bubble : undefined} />
        ))}
        <img className="wr-counter" src="/stage-counter.png" alt="" />
        {scene.place.messenger === 'street' && kitIn && !scene.end && <span className="wr-parcel">Your work, boxed</span>}
        {coins.map(([id, pay], i) => <Coin key={`${run}-${id}`} to={goalOf(id, 'desk')} pay={pay} delay={500 + i * 220} />)}
      </div>
      <div className="wr-bar">
        <div className="wr-top">
          {live && !caughtUp ? <span className="chip mono"><i className="dot pulse" />catching up</span>
            : live && !['accepted', 'rejected', 'failed'].includes(o.state) ? <span className="chip mono"><i className="dot pulse" />live</span>
            : <span className="chip mono">replay</span>}
          <span className="mono note">{played.length}/{beats.length}</span>
        </div>
        <p className="now">{scene.caption}</p>
        <ol className="wr-log">{scene.log.slice(-7, -1).reverse().map((c, i) => <li key={scene.log.length - i}>{c}</li>)}</ol>
        <button className="ghost" onClick={() => setRun((r) => r + 1)} disabled={played.length < 2}>Replay from the start</button>
      </div>
    </div>
  );
}
