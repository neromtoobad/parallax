// A small, deterministic synthesizer: a score (chords, a melody, a groove) in, a 16-bit stereo WAV out.
// No samples and no randomness that isn't seeded, so the same score always renders the same bytes: anyone
// can take the TEE-signed score from a job's receipts, render it again, and compare the hash.

export const SR = 44100;

export type Note = { t: number; len: number; midi: number; syl?: string }; // t and len in beats
export type Bar = { chord: string };
export type Score = {
  bpm: number;
  key: string; // 'C', 'F#', 'Bb'
  mode: 'major' | 'minor';
  groove: Groove;
  lead: 'bell' | 'flute' | 'pluck' | 'brass' | 'whistle';
  bars: Bar[];
  melody: Note[];
  sections: { name: string; bar: number }[];
};
export type Groove = 'pop' | 'afrobeats' | 'lofi' | 'house' | 'ballad' | 'funk';
export const GROOVES: Groove[] = ['pop', 'afrobeats', 'lofi', 'house', 'ballad', 'funk'];

// ---------------------------------------------------------------- music theory

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function pitchClass(name: string) {
  const m = /^([A-G])([#b]?)/.exec(name.trim());
  if (!m) return 0;
  return (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}
const QUALITY: [RegExp, number[]][] = [
  [/^maj7/, [0, 4, 7, 11]], [/^m7b5/, [0, 3, 6, 10]], [/^(m7|min7)/, [0, 3, 7, 10]], [/^dim/, [0, 3, 6]],
  [/^sus2/, [0, 2, 7]], [/^sus4|^sus/, [0, 5, 7]], [/^add9/, [0, 4, 7, 14]], [/^(m|min)(?!aj)/, [0, 3, 7]],
  [/^7/, [0, 4, 7, 10]], [/^6/, [0, 4, 7, 9]], [/^/, [0, 4, 7]],
];
/** A chord symbol (Am7, F#m, Bbmaj7, Gsus4, C/E) as a root pitch class and intervals. */
export function chord(sym: string): { root: number; iv: number[] } {
  const s = sym.trim().split('/')[0];
  const m = /^([A-G][#b]?)(.*)$/.exec(s);
  if (!m) return { root: 0, iv: [0, 4, 7] };
  const q = QUALITY.find(([r]) => r.test(m[2]))!;
  return { root: pitchClass(m[1]), iv: q[1] };
}
export const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
/** Scale degree (1 = tonic, 8 = tonic an octave up, 0 and below go down) to MIDI, around middle C. */
export function degree(d: number, key: string, mode: 'major' | 'minor', base = 60) {
  const sc = SCALE[mode];
  const i = d - 1, oct = Math.floor(i / 7), step = ((i % 7) + 7) % 7;
  return base + pitchClass(key) + oct * 12 + sc[step];
}
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);

// ---------------------------------------------------------------- the render

/** A seeded PRNG so the noise in the drums is the same every render. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}

type Bus = { l: Float32Array; r: Float32Array };
const bus = (n: number): Bus => ({ l: new Float32Array(n), r: new Float32Array(n) });
function add(b: Bus, i: number, v: number, pan = 0) {
  if (i < 0 || i >= b.l.length) return;
  b.l[i] += v * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2 * 0.7071;
  b.r[i] += v * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2 * 0.7071;
}
const env = (t: number, len: number, a: number, d: number, s: number, r: number) => {
  if (t < 0) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < len) return s;
  const x = t - len; return x < r ? s * (1 - x / r) : 0;
};

/** Renders a score to stereo float buffers, then to WAV bytes. Returns the WAV and each melody note's time in seconds. */
export function render(score: Score): { wav: Buffer; seconds: number; times: { t: number; len: number; midi: number; syl?: string }[] } {
  const spb = 60 / score.bpm; // seconds per beat
  const bars = score.bars.length;
  const total = bars * 4 * spb + 2.5; // tail for the reverb
  const n = Math.ceil(total * SR);
  const dry = bus(n), wet = bus(n);
  const noise = rng(0x9e3779b9 ^ score.bpm ^ (bars << 8));
  const swing = score.groove === 'lofi' || score.groove === 'funk' ? 0.12 : score.groove === 'afrobeats' ? 0.06 : 0;
  const at = (beat: number) => { // swing on the off-eighths
    const frac = beat % 1; const sw = Math.abs(frac - 0.5) < 1e-6 ? swing * spb : 0;
    return Math.round((beat * spb + sw) * SR);
  };

  score.bars.forEach((bar, bi) => {
    const c = chord(bar.chord);
    const t0 = bi * 4;
    // pad: the chord held across the bar, three detuned saws through a soft low-pass
    const padNotes = voice(c, 52);
    const padLevel = score.groove === 'ballad' || score.groove === 'lofi' ? 0.05 : 0.035;
    for (const [k, m] of padNotes.entries()) for (const det of [-0.08, 0.0, 0.08]) {
      saw(wet, at(t0), 4 * spb, hz(m + det), padLevel * 0.7, { a: 0.25, d: 0.4, s: 0.8, r: 0.6, cutoff: 1800, pan: (k - 1) * 0.35 + det * 3 });
      saw(dry, at(t0), 4 * spb, hz(m + det), padLevel * 0.3, { a: 0.25, d: 0.4, s: 0.8, r: 0.6, cutoff: 1800, pan: (k - 1) * 0.35 });
    }
    // bass
    for (const [b, len, oct] of bassLine(score.groove)) bass(dry, at(t0 + b), len * spb, hz(36 + c.root + (c.root > 6 ? -12 : 0) + oct * 12), 0.2);
    // pluck arpeggio on chord tones
    if (score.groove !== 'ballad') {
      const tones = voice(c, 64);
      const step = score.groove === 'house' ? 0.5 : score.groove === 'afrobeats' ? 0.5 : 0.5;
      for (let b = 0, k = 0; b < 4; b += step, k++) {
        if (score.groove === 'afrobeats' && [1, 4, 6].includes(k)) continue; // leave room in the pattern
        const m = tones[[0, 1, 2, 1, 3 % tones.length, 2, 1, 2][k % 8] % tones.length];
        pluck(wet, at(t0 + b), hz(m), 0.09, noise, (k % 2 ? 0.35 : -0.35));
        pluck(dry, at(t0 + b), hz(m), 0.11, noise, (k % 2 ? 0.35 : -0.35));
      }
    } else {
      // ballad: a broken chord on the piano-ish pluck, once per beat
      const tones = voice(c, 60);
      for (let b = 0; b < 4; b++) pluck(wet, at(t0 + b), hz(tones[b % tones.length]), 0.14, noise, 0);
    }
    // drums
    drums(dry, wet, score.groove, t0, at, spb, noise, bi === bars - 1, bi === 0);
  });

  // lead melody
  const times: { t: number; len: number; midi: number; syl?: string }[] = [];
  for (const nt of score.melody) {
    const i = at(nt.t), len = Math.max(0.2, nt.len) * spb * 0.92;
    lead(dry, wet, score.lead, i, len, hz(nt.midi), 0.3);
    times.push({ t: +(nt.t * spb).toFixed(3), len: +(nt.len * spb).toFixed(3), midi: nt.midi, syl: nt.syl });
  }

  // reverb on the wet bus, then the mix
  const rev = reverb(wet);
  const L = new Float32Array(n), R = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    L[i] = dry.l[i] + rev.l[i] * 0.9; R[i] = dry.r[i] + rev.r[i] * 0.9;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = peak > 0 ? 0.89 / peak : 1;
  // a short fade at the end so the tail never clicks
  const fade = Math.round(0.4 * SR);
  for (let i = 0; i < n; i++) { const f = i > n - fade ? (n - i) / fade : 1; L[i] *= g * f; R[i] *= g * f; }
  return { wav: wav(L, R), seconds: +total.toFixed(2), times };
}

/** Each groove's bass pattern in a bar: [beat, length in beats, octave up]. */
function bassLine(g: Groove): [number, number, number][] {
  switch (g) {
    case 'afrobeats': return [[0, 0.75, 0], [0.75, 0.5, 0], [1.5, 0.5, 1], [2.5, 0.75, 0], [3.5, 0.5, 0]];
    case 'house': return [[0.5, 0.4, 0], [1.5, 0.4, 0], [2.5, 0.4, 0], [3.5, 0.4, 1]];
    case 'funk': return [[0, 0.5, 0], [0.75, 0.25, 1], [1.5, 0.5, 0], [2.5, 0.25, 0], [2.75, 0.5, 1], [3.5, 0.5, 0]];
    case 'lofi': return [[0, 1.5, 0], [1.75, 0.75, 0], [3, 1, 0]];
    case 'ballad': return [[0, 2, 0], [2, 2, 0]];
    default: return [[0, 1, 0], [1.5, 0.5, 0], [2, 1, 0], [3, 0.5, 1], [3.5, 0.5, 0]];
  }
}

/** Close voicing of a chord from a floor note up. */
function voice(c: { root: number; iv: number[] }, floor: number) {
  let r = floor + ((c.root - floor) % 12 + 12) % 12;
  if (r - floor > 6) r -= 12;
  return c.iv.slice(0, 4).map((x) => r + (x > 11 ? x - 12 : x));
}

function saw(b: Bus, start: number, len: number, f: number, amp: number, o: { a: number; d: number; s: number; r: number; cutoff: number; pan: number }) {
  const end = Math.round((len + o.r) * SR);
  let ph = 0, lp = 0;
  const k = 1 - Math.exp(-2 * Math.PI * o.cutoff / SR);
  for (let j = 0; j < end; j++) {
    ph += f / SR; if (ph >= 1) ph -= 1;
    lp += k * ((2 * ph - 1) - lp);
    add(b, start + j, lp * amp * env(j / SR, len, o.a, o.d, o.s, o.r), o.pan);
  }
}
function bass(b: Bus, start: number, len: number, f: number, amp: number) {
  const end = Math.round((len + 0.08) * SR);
  let ph = 0;
  for (let j = 0; j < end; j++) {
    ph += f / SR;
    const t = j / SR;
    const x = Math.sin(2 * Math.PI * ph) + 0.25 * Math.sin(4 * Math.PI * ph) + 0.08 * Math.sin(6 * Math.PI * ph);
    add(b, start + j, Math.tanh(x * 1.3) * amp * env(t, len * 0.9, 0.005, 0.12, 0.7, 0.08));
  }
}
/** Karplus-Strong: a burst of noise through a tuned delay line, a guitar-ish pluck. */
function pluck(b: Bus, start: number, f: number, amp: number, noise: () => number, pan: number) {
  const N = Math.max(2, Math.round(SR / f));
  const line = new Float32Array(N);
  for (let i = 0; i < N; i++) line[i] = noise();
  const end = Math.round(1.2 * SR);
  let idx = 0, last = 0;
  for (let j = 0; j < end; j++) {
    const v = line[idx];
    const nv = 0.996 * 0.5 * (v + last);
    last = v; line[idx] = nv; idx = (idx + 1) % N;
    add(b, start + j, v * amp * (1 - j / end), pan);
  }
}
function lead(dry: Bus, wet: Bus, kind: Score['lead'], start: number, len: number, f: number, amp: number) {
  const end = Math.round((len + 0.25) * SR);
  let ph = 0, ph2 = 0;
  for (let j = 0; j < end; j++) {
    const t = j / SR;
    const vib = t > 0.18 ? 1 + 0.006 * Math.sin(2 * Math.PI * 5.4 * t) * Math.min(1, (t - 0.18) * 4) : 1;
    // a little scoop up into each note, like a singer
    const scoop = kind === 'bell' || kind === 'pluck' ? 1 : 1 - 0.03 * Math.exp(-t * 30);
    ph += (f * vib * scoop) / SR; ph2 += (f * 2.0) / SR;
    let x: number, e: number;
    switch (kind) {
      case 'bell': x = Math.sin(2 * Math.PI * ph + 1.6 * Math.exp(-t * 3) * Math.sin(2 * Math.PI * ph * 3.5)); e = env(t, len, 0.003, 0.5, 0.25, 0.3); break;
      case 'pluck': x = Math.sin(2 * Math.PI * ph) * 0.7 + Math.sin(2 * Math.PI * ph2) * 0.3 * Math.exp(-t * 6); e = env(t, len, 0.003, 0.25, 0.35, 0.15); break;
      case 'brass': { const s = 2 * (ph % 1) - 1; x = Math.tanh(s * 2 + Math.sin(2 * Math.PI * ph)) * 0.6; e = env(t, len, 0.04, 0.1, 0.85, 0.12); break; }
      case 'whistle': x = Math.sin(2 * Math.PI * ph); e = env(t, len, 0.03, 0.1, 0.9, 0.12); break;
      default: /* flute: sine with a breathy second partial */ x = Math.sin(2 * Math.PI * ph) + 0.18 * Math.sin(4 * Math.PI * ph) + 0.06 * Math.sin(6 * Math.PI * ph); e = env(t, len, 0.05, 0.12, 0.85, 0.15);
    }
    const v = x * amp * e;
    add(dry, start + j, v * 0.8, 0); add(wet, start + j, v * 0.35, 0);
  }
}

type Hit = 'k' | 's' | 'h' | 'o' | 'c' | 'r'; // kick, snare, hat, open hat, clap, rim/shaker
const PATTERNS: Record<Groove, Partial<Record<Hit, number[]>>> = {
  // sixteenth steps 0..15 in a bar
  pop: { k: [0, 8, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14] },
  afrobeats: { k: [0, 7, 10], s: [6, 14], c: [12], h: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14], r: [3, 7, 11, 15] },
  lofi: { k: [0, 7, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14] },
  house: { k: [0, 4, 8, 12], c: [4, 12], o: [2, 6, 10, 14], h: [0, 4, 8, 12] },
  ballad: { k: [0, 10], s: [8], h: [0, 4, 8, 12] },
  funk: { k: [0, 3, 10], s: [4, 12, 15], h: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
};
function drums(dry: Bus, wet: Bus, g: Groove, t0: number, at: (b: number) => number, spb: number, noise: () => number, last: boolean, first: boolean) {
  const p = PATTERNS[g];
  for (const [hit, steps] of Object.entries(p) as [Hit, number[]][]) for (const st of steps) {
    if (first && hit !== 'h' && st < 8 && g !== 'house') continue; // the first bar breathes in
    const i = at(t0 + st / 4);
    const accent = st % 4 === 0 ? 1 : 0.7;
    switch (hit) {
      case 'k': kick(dry, i, 0.42); break;
      case 's': snare(dry, wet, i, 0.32, noise); break;
      case 'c': clap(dry, wet, i, 0.28, noise); break;
      case 'h': hat(dry, i, 0.06 * accent * (g === 'lofi' ? 0.7 : 1), 0.04, noise); break;
      case 'o': hat(dry, i, 0.07, 0.18, noise); break;
      case 'r': shaker(dry, i, 0.05, noise); break;
    }
  }
  if (last) { // a fill into the end
    for (const st of [12, 13, 14, 15]) snare(dry, wet, at(t0 + st / 4), 0.22 + st * 0.008, noise);
    void spb;
  }
}
function kick(b: Bus, i: number, amp: number) {
  let ph = 0;
  for (let j = 0; j < 0.45 * SR; j++) {
    const t = j / SR, f = 45 + 110 * Math.exp(-t * 28);
    ph += f / SR;
    add(b, i + j, Math.sin(2 * Math.PI * ph) * amp * Math.exp(-t * 7.5) + (j < 60 ? 0.2 * amp * (1 - j / 60) : 0));
  }
}
function snare(dry: Bus, wet: Bus, i: number, amp: number, noise: () => number) {
  let ph = 0, hp = 0, lastN = 0;
  for (let j = 0; j < 0.25 * SR; j++) {
    const t = j / SR; ph += 185 / SR;
    const n = noise(); hp = 0.85 * (hp + n - lastN); lastN = n;
    const v = (Math.sin(2 * Math.PI * ph) * Math.exp(-t * 30) * 0.5 + hp * Math.exp(-t * 16) * 0.6) * amp;
    add(dry, i + j, v, 0.05); add(wet, i + j, v * 0.4, 0.05);
  }
}
function clap(dry: Bus, wet: Bus, i: number, amp: number, noise: () => number) {
  let hp = 0, lastN = 0;
  for (let j = 0; j < 0.22 * SR; j++) {
    const t = j / SR;
    const n = noise(); hp = 0.7 * (hp + n - lastN); lastN = n;
    const bursts = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.6 : 1) : 1;
    const v = hp * Math.exp(-t * 22) * bursts * amp;
    add(dry, i + j, v, -0.1); add(wet, i + j, v * 0.6, 0.1);
  }
}
function hat(b: Bus, i: number, amp: number, decay: number, noise: () => number) {
  let hp = 0, lastN = 0;
  for (let j = 0; j < (decay * 4) * SR; j++) {
    const t = j / SR;
    const n = noise(); hp = 0.55 * (hp + n - lastN); lastN = n;
    add(b, i + j, hp * Math.exp(-t / decay) * amp, 0.3);
  }
}
function shaker(b: Bus, i: number, amp: number, noise: () => number) {
  let hp = 0, lastN = 0;
  for (let j = 0; j < 0.08 * SR; j++) {
    const t = j / SR;
    const n = noise(); hp = 0.6 * (hp + n - lastN); lastN = n;
    add(b, i + j, hp * Math.sin(Math.PI * Math.min(1, t / 0.08)) * amp, -0.35);
  }
}

/** A small Schroeder reverb: four combs into two all-passes, a little different on each side. */
function reverb(b: Bus): Bus {
  const out = bus(b.l.length);
  const side = (inp: Float32Array, o: Float32Array, spread: number) => {
    const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(d + spread), i: 0, lp: 0 }));
    const aps = [225, 556].map((d) => ({ buf: new Float32Array(d + spread), i: 0 }));
    for (let j = 0; j < inp.length; j++) {
      const x = inp[j] * 0.2;
      let s = 0;
      for (const c of combs) {
        const y = c.buf[c.i]; c.lp = y * 0.7 + c.lp * 0.3;
        c.buf[c.i] = x + c.lp * 0.82; c.i = (c.i + 1) % c.buf.length; s += y;
      }
      for (const a of aps) { const y = a.buf[a.i]; const v = -s + y; a.buf[a.i] = s + y * 0.5; a.i = (a.i + 1) % a.buf.length; s = v; }
      o[j] = s;
    }
  };
  side(b.l, out.l, 0); side(b.r, out.r, 23);
  return out;
}

function wav(L: Float32Array, R: Float32Array) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  return buf;
}

// ---------------------------------------------------------------- a written song to a score

export type Line = { text: string; syllables: string[]; degrees: number[]; beats: number[] };
export type Song = {
  title: string; bpm: number; key: string; mode: 'major' | 'minor'; groove: Groove; lead: Score['lead'];
  verseChords: string[]; hookChords: string[]; verse: Line[]; hook: Line[];
};

/**
 * The producer's arrangement: intro (2 bars), verse (4), hook (4), hook again (4), outro (2). Each lyric line
 * is two bars. The melody's durations are fitted to the line, and any note on a beat that clashes with the
 * chord moves to the nearest chord tone, so a sloppy melody from the model still sounds right.
 */
export function arrange(s: Song): Score {
  const four = (c: string[]) => [0, 1, 2, 3].map((i) => c[i % Math.max(1, c.length)] || 'C');
  const v = four(s.verseChords), h = four(s.hookChords);
  const tonic = s.key + (s.mode === 'minor' ? 'm' : '');
  const bars: Bar[] = [h[0], h[1], ...v, ...h, ...h, h[0], tonic].map((chord) => ({ chord }));
  const melody: Note[] = [];
  const place = (lines: Line[], startBar: number) => lines.slice(0, 2).forEach((ln, li) => {
    const syl = ln.syllables.length ? ln.syllables : ln.text.split(/\s+/);
    const count = Math.min(syl.length, 14);
    let beats = (ln.beats ?? []).slice(0, count).map((x) => Math.max(0.5, Math.round((+x || 1) * 2) / 2));
    while (beats.length < count) beats.push(1);
    // fit the line into 7 beats (the 8th is a breath), on the half-beat grid
    const sum = beats.reduce((a, b) => a + b, 0);
    if (sum > 7) beats = beats.map((b) => Math.max(0.5, Math.round((b * 7 / sum) * 2) / 2));
    let t = (startBar + li * 2) * 4;
    const end = t + 8;
    for (let k = 0; k < count && t < end - 0.5; k++) {
      const len = Math.min(beats[k], end - 0.5 - t);
      let midi = degree(Math.max(-3, Math.min(12, Math.round(+ln.degrees?.[k] || 1))), s.key, s.mode, 60);
      const c = chord(bars[Math.floor(t / 4)]?.chord ?? tonic);
      if (Math.abs(t % 1) < 1e-6) midi = nearestChordTone(midi, c);
      melody.push({ t, len, midi, syl: syl[k] });
      t += len;
    }
  });
  place(s.verse, 2);
  place(s.hook, 6);
  place(s.hook, 10);
  return {
    bpm: Math.max(70, Math.min(140, Math.round(+s.bpm || 100))), key: s.key, mode: s.mode, groove: s.groove, lead: s.lead, bars, melody,
    sections: [{ name: 'Intro', bar: 0 }, { name: 'Verse', bar: 2 }, { name: 'Hook', bar: 6 }, { name: 'Hook', bar: 10 }, { name: 'Outro', bar: 14 }],
  };
}
function nearestChordTone(m: number, c: { root: number; iv: number[] }) {
  const pcs = c.iv.map((x) => (c.root + x) % 12);
  for (let d = 0; d <= 6; d++) for (const s of [m - d, m + d]) if (pcs.includes(((s % 12) + 12) % 12)) return s;
  return m;
}
