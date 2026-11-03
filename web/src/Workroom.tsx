// The building, live: the auction hall upstairs, the team's desks in the middle, the counter at street level.
// Every lot, sealed bid, reveal, award, work step and payout of one job becomes a beat, and the beats play in
// order, so a finished job replays and a running one plays as the events arrive.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
const HOLD: Record<Beat['k'], number> = { open: 1300, commit: 650, quote: 900, reveal: 750, award: 1700, void: 1200, step: 1700, inspect: 1100, deliver: 1800, accept: 2200, reject: 1600, stop: 1600 };

const ROSTER = Object.keys(NAMES);
// Desk spots on the middle floor, left to right (percent of the stage width), one per agent.
const DESK = [5.5, 11, 17, 23.5, 30.5, 37, 43.5, 50, 56.5, 63, 69.5, 76, 82, 87];
const HALL = [27, 34, 41, 67, 74, 81, 48, 22];
const FLOOR = { hall: 39.4, desk: 65.2, street: 92.5 } as const; // where the feet go, percent from the top
const STAIRS = 90.5;
const name = (id?: string) => (id ? NAMES[id] ?? id.replace(/^outside:/, '') : '');

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

type Place = 'desk' | 'street' | { hall: number };
type Scene = {
  place: Record<string, Place>;
  tag: Record<string, string>; // a small label over a head: a sealed envelope, a price, a lot won
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
  const s: Scene = { place: {}, tag: {}, pills: [], won: {}, glow: new Set(), caption: 'The team is at their desks, waiting for a job.', log: [] };
  const toDesk = (keep?: string) => { for (const [a, p] of Object.entries(s.place)) if (typeof p === 'object' && a !== keep) s.place[a] = 'desk'; };
  for (const b of beats) {
    s.bubble = undefined;
    switch (b.k) {
      case 'open':
        toDesk();
        for (const a of Object.keys(s.tag)) if (!s.tag[a].startsWith('won')) delete s.tag[a];
        s.board = { title: b.title, reserve: b.reserve, rows: [] };
        s.pills = [];
        s.caption = `${b.title} goes to auction. Reserve ${usd(b.reserve)} USDC.`;
        break;
      case 'commit': {
        const slot = Object.values(s.place).filter((p) => typeof p === 'object').length;
        s.place[b.who] = { hall: slot % HALL.length };
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
        s.tag[b.who] = `${usd(b.price)}`;
        s.caption = `${name(b.who)} reveals ${usd(b.price)} USDC. The bank checks it against the hash.`;
        break;
      }
      case 'award':
        if (s.board) s.board.winner = b.who;
        toDesk();
        for (const a of Object.keys(s.tag)) if (!s.tag[a].startsWith('won')) delete s.tag[a];
        if (!b.who.startsWith('outside:')) { s.glow.add(b.who); s.tag[b.who] = `won ${b.title.toLowerCase()}`; s.won[b.who] = (s.won[b.who] ?? 0) + (b.pay ?? 0); }
        s.caption = `${name(b.who)} wins ${b.title.toLowerCase()} for ${usd(b.pay)} USDC, held in escrow until you accept.`;
        break;
      case 'void':
        toDesk();
        s.caption = `Nobody bid under the reserve for ${b.title.toLowerCase()}.`;
        break;
      case 'step':
        if (b.who !== 'cfo' && typeof s.place[b.who] === 'object') s.place[b.who] = 'desk';
        s.bubble = { who: b.who, text: b.text, kind: b.kind, key: b.key };
        s.caption = `${b.who === 'cfo' ? 'The CFO' : name(b.who)}: ${b.text}`;
        break;
      case 'inspect':
        if (b.who && !b.who.startsWith('outside:')) s.tag[b.who] = b.pass ? 'passed ✓' : 'failed ✗';
        if (!b.pass) delete s.won[b.who];
        s.caption = `The auditor ${b.pass ? 'passes' : 'fails'} ${b.title.toLowerCase()}.${b.pass ? '' : ' That part is paid nothing.'}`;
        break;
      case 'deliver':
        s.place.messenger = 'street';
        s.caption = 'Kit brings the finished work down to the counter. The money waits for your answer.';
        break;
      case 'accept':
        s.end = 'accepted';
        s.caption = 'Accepted. The bank pays each winner from escrow, straight to their NEAR account.';
        break;
      case 'reject':
        s.end = 'rejected';
        s.place.messenger = 'desk';
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

const spot = (id: string, p: Place) => {
  if (p === 'street') return { x: 40, y: FLOOR.street, floor: 2 };
  if (typeof p === 'object') return { x: HALL[p.hall], y: FLOOR.hall, floor: 0 };
  return { x: DESK[ROSTER.indexOf(id)] ?? 50, y: FLOOR.desk, floor: 1 };
};

/** One agent. Moving between floors goes by the stairs on the right: across, up or down, then across. */
function Figure({ id, place, tag, glow, bubble }: { id: string; place: Place; tag?: string; glow: boolean; bubble?: Scene['bubble'] }) {
  const to = spot(id, place);
  const [at, setAt] = useState(to);
  const [walking, setWalking] = useState(false);
  const cur = useRef(to);
  useEffect(() => {
    const from = cur.current;
    cur.current = to;
    if (from.x === to.x && from.y === to.y) return;
    const legs = from.floor === to.floor ? [to] : [{ ...from, x: STAIRS }, { ...to, x: STAIRS }, to];
    const timers: number[] = [];
    let t = 0;
    setWalking(true);
    legs.forEach((leg) => { timers.push(window.setTimeout(() => setAt(leg), t)); t += 520; });
    timers.push(window.setTimeout(() => setWalking(false), t));
    return () => timers.forEach(clearTimeout);
  }, [to.x, to.y]);
  const n = NAMES[id];
  const side = at.x < 20 ? ' l' : at.x > 78 ? ' r' : '';
  return (
    <div className={`wr-fig${side}${walking ? ' walk' : ''}${glow ? ' glow' : ''}`} style={{ left: `${at.x}%`, bottom: `${100 - at.y}%`, zIndex: at.floor === 2 ? 3 : 2 }}>
      {bubble && <div className={`wr-bub ${bubble.kind}`} key={bubble.key}>{bubble.text.length > 90 ? `${bubble.text.slice(0, 88)}…` : bubble.text}</div>}
      {!bubble && tag && <span className={`wr-tag${tag === 'sealed' ? ' sealed' : tag.startsWith('won') || tag.startsWith('passed') ? ' won' : tag.startsWith('failed') ? ' bad' : ''}`}>{tag === 'sealed' ? 'sealed bid' : tag}</span>}
      <img src={`/agents/cut/${n.toLowerCase()}.png`} alt={n} draggable={false} />
      <small>{n}</small>
    </div>
  );
}

export function Workroom({ o, lots, steps, live }: { o: Order; lots: LiveLot[]; steps: Step[]; live?: boolean }) {
  const beats = useMemo(() => beatsOf(o, lots, steps), [o, lots, steps]);
  const byKey = useMemo(() => new Map(beats.map((b) => [b.key, b])), [beats]);
  const [played, setPlayed] = useState<string[]>([]);
  const [run, setRun] = useState(0);
  useEffect(() => setPlayed([]), [o.id, run]);
  useEffect(() => {
    const seen = new Set(played);
    const next = beats.find((b) => !seen.has(b.key));
    if (!next) return;
    const last = byKey.get(played[played.length - 1]);
    const behind = beats.length - played.length;
    const t = window.setTimeout(() => setPlayed((p) => [...p, next.key]), last ? HOLD[last.k] * (behind > 14 ? 0.45 : behind > 6 ? 0.7 : 1) : 500);
    return () => clearTimeout(t);
  }, [beats, played]);
  const scene = useMemo(() => fold(played.map((k) => byKey.get(k)!).filter(Boolean)), [played, byKey]);
  const caughtUp = played.length >= beats.length;
  const rows = (scene.board?.rows ?? []).slice().sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)).slice(0, 4);
  const coins = scene.end === 'accepted' ? Object.entries(scene.won).filter(([, pay]) => pay > 0) : [];

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
        {ROSTER.map((id) => (
          <Figure key={id} id={id} place={scene.place[id] ?? 'desk'} tag={scene.tag[id]} glow={scene.glow.has(id)} bubble={scene.bubble?.who === id ? scene.bubble : undefined} />
        ))}
        <img className="wr-counter" src="/stage-counter.png" alt="" />
        {scene.place.messenger === 'street' && !scene.end && <span className="wr-parcel">Your work, boxed</span>}
        {coins.map(([id, pay], i) => {
          const d = spot(id, 'desk');
          return <span key={`${run}-${id}`} className="wr-coin" style={{ '--x1': `${d.x}%`, '--y1': `${100 - d.y + 16}%`, animationDelay: `${i * 160}ms` } as CSSProperties}>+{usd(pay)}</span>;
        })}
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
