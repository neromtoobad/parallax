// Who signed a NEAR AI Cloud answer: Ethereum-style personal_sign recovery (EIP-191), with keccak-256 and
// secp256k1 written out here so the proof page and web/scripts/verify.ts need no packages. The bank's
// `deliver` does the same recovery on chain with env::ecrecover; this lets anyone repeat it.

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (x: bigint, n: number) => (n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK : x);

function permute(a: bigint[]) {
  for (const rc of RC) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    a[0] ^= rc;
  }
}

/** keccak-256 (Ethereum's, not SHA3-256: padding byte 0x01). */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      a[i] ^= lane;
    }
    permute(a);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((a[i] >> BigInt(8 * k)) & 0xffn);
  return out;
}

// secp256k1, in Jacobian coordinates so a recovery needs one inversion per point, not one per step.
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Pt = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n, 1n];
type Pt = [bigint, bigint, bigint]; // X, Y, Z; Z = 0 is the point at infinity

const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function inv(a: bigint, m: bigint) {
  let [x, y, r0, r1] = [1n, 0n, mod(a, m), m];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [x, y] = [y, x - q * y]; }
  return mod(x, m);
}
function pow(b: bigint, e: bigint, m: bigint) {
  let r = 1n;
  for (b = mod(b, m); e; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
}
function dbl([x, y, z]: Pt): Pt {
  if (!z || !y) return [0n, 1n, 0n];
  const s = mod(4n * x * y * y), m = mod(3n * x * x);
  const x3 = mod(m * m - 2n * s);
  return [x3, mod(m * (s - x3) - 8n * y ** 4n), mod(2n * y * z)];
}
function add(p: Pt, q: Pt): Pt {
  if (!p[2]) return q;
  if (!q[2]) return p;
  const z1z1 = mod(p[2] * p[2]), z2z2 = mod(q[2] * q[2]);
  const u1 = mod(p[0] * z2z2), u2 = mod(q[0] * z1z1);
  const s1 = mod(p[1] * q[2] * z2z2), s2 = mod(q[1] * p[2] * z1z1);
  if (u1 === u2) return s1 === s2 ? dbl(p) : [0n, 1n, 0n];
  const h = mod(u2 - u1), r = mod(s2 - s1), hh = mod(h * h), hhh = mod(h * hh);
  const x3 = mod(r * r - hhh - 2n * u1 * hh);
  return [x3, mod(r * (u1 * hh - x3) - s1 * hhh), mod(h * p[2] * q[2])];
}
function mul(p: Pt, k: bigint): Pt {
  let r: Pt = [0n, 1n, 0n];
  for (let i = 255; i >= 0; i--) {
    r = dbl(r);
    if ((k >> BigInt(i)) & 1n) r = add(r, p);
  }
  return r;
}
function affine([x, y, z]: Pt): [bigint, bigint] {
  const zi = inv(z, P), zi2 = mod(zi * zi);
  return [mod(x * zi2), mod(y * zi2 * zi)];
}

const big = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const bytes = (n: bigint, len = 32) => Uint8Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * (len - 1 - i))) & 0xffn));
export const hexToBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The address (0x + 40 hex, lowercase) that made a 65-byte r‖s‖v signature over a 32-byte hash, or undefined. */
export function recoverAddress(hash: Uint8Array, signature: string): string | undefined {
  const sig = hexToBytes(signature);
  if (sig.length !== 65) return undefined;
  const r = big(sig.slice(0, 32)), s = big(sig.slice(32, 64)), v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if (v > 1 || !r || r >= N || !s || s >= N) return undefined;
  const y2 = mod(r ** 3n + 7n);
  let y = pow(y2, (P + 1n) / 4n, P);
  if (mod(y * y) !== y2) return undefined;
  if (Number(y & 1n) !== v) y = P - y;
  const e = big(hash), ri = inv(r, N);
  const q = add(mul([r, y, 1n], mod(s * ri, N)), mul(G, mod(-e * ri, N)));
  if (!q[2]) return undefined;
  const [qx, qy] = affine(q);
  const pub = new Uint8Array(64);
  pub.set(bytes(qx), 0);
  pub.set(bytes(qy), 32);
  return `0x${toHex(keccak256(pub).slice(12))}`;
}

/** The hash personal_sign signs: keccak256("\x19Ethereum Signed Message:\n" + length + text). */
export function personalHash(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak256(all);
}

/** The signer of a NEAR AI Cloud signature: { text, signature } → its address. */
export const signerOf = (text: string, signature: string) => recoverAddress(personalHash(text), signature);
