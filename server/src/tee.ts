// TEE proof for model calls. NEAR AI Cloud runs the team's model in a TEE and signs, for every chat
// completion, "model:sha256(request body):sha256(answer body)" with a key that lives only inside it. We
// keep that signature on the call's receipt line, after checking the hashes are of the exact bytes we
// sent and got. The bank's `deliver` recovers the signer of each one and takes the work only from a key
// it has approved for that model. A key is approved once, with the hash of its attestation report (an
// Intel TDX quote whose report_data names the key, plus NVIDIA GPU evidence); the report is kept in
// DATA_DIR/attestations under its own sha256 (the hash the bank holds) and served at /api/attestation/<sha256>;
// reports approved elsewhere can ship in deployments/attestations. /proof fetches each by its hash on the bank.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ARCHIVE_DIRS, DATA_DIR, DRY, IMAGE_MODEL, MODEL } from './config.ts';
import { NEARAI, nearaiKey } from './nearai.ts';
import { NEAR, call, sha256, view } from './near/chain.ts';
import { signerOf } from '../../web/src/ecrecover.ts';

export type TeeSig = { text: string; signature: string; signer: string };

const dir = () => join(DATA_DIR, 'attestations');
const approved = new Map<string, string>(); // address -> model, as the bank has it

/** NEAR AI's signature for one completion, checked against the bytes we sent and received. */
export async function teeSignature(id: string, model: string, request: string, answer: string): Promise<TeeSig | undefined> {
  const key = nearaiKey();
  if (!key || !id) return undefined;
  const want = `${model}:${sha256(request)}:${sha256(answer)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${NEARAI}/signature/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, {
        headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        const d: any = await r.json();
        if (d.text !== want) return undefined; // not over what we sent and got: no proof rather than a wrong one
        const signer = signerOf(d.text, d.signature);
        if (!signer || signer !== String(d.signing_address).toLowerCase()) return undefined;
        await ensureApproved(signer, model);
        return { text: d.text, signature: d.signature, signer };
      }
    } catch { /* try again */ }
    await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
  }
  return undefined;
}

/** A saved attestation report by its sha256: the exact bytes whose hash the bank holds. */
export function attestationFile(hash: string): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
  for (const d of [dir(), ...ARCHIVE_DIRS.map((a) => join(a, 'attestations')), new URL('../../deployments/attestations', import.meta.url).pathname]) {
    const f = join(d, `${hash}.json`);
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  return undefined;
}

const pending = new Map<string, Promise<void>>();
/** First time we see a signer: fetch its attestation report, check it names this key, and have the CFO approve it. */
function ensureApproved(address: string, model: string): Promise<void> {
  if (DRY || !NEAR || approved.get(address) === model) return Promise.resolve();
  let p = pending.get(address);
  if (!p) {
    p = approve(address, model).finally(() => pending.delete(address));
    pending.set(address, p);
  }
  return p;
}

async function approve(address: string, model: string) {
  if (!approved.size) for (const [a, s] of await view<[string, { model: string; active: boolean }][]>(NEAR!.bank, 'list_signers')) if (s.active) approved.set(a, s.model);
  if (approved.get(address) === model) return;
  const nonce = randomBytes(32).toString('hex');
  const r = await fetch(`${NEARAI}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, {
    headers: { authorization: `Bearer ${nearaiKey()}` }, signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`attestation report: ${r.status}`);
  const raw = await r.text();
  const m = (JSON.parse(raw).model_attestations ?? []).find((x: any) => String(x.signing_address).toLowerCase() === address);
  if (!m || m.model_name !== model) throw new Error(`the attestation report doesn't name ${address} for ${model}`);
  // The TDX quote's report_data (bytes 568..632 of a v4 quote) is the address, zero padding, then our nonce.
  const reportData = Buffer.from(m.intel_quote, 'hex').subarray(568, 632).toString('hex');
  if (reportData !== address.slice(2) + '0'.repeat(24) + nonce) throw new Error("the TDX quote doesn't bind this key and our nonce");
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${sha256(raw)}.json`), raw);
  await call(NEAR!.cfo, NEAR!.bank, 'approve_signer', { address, model, report: sha256(raw) });
  approved.set(address, model);
  console.log(`tee: approved ${address} for ${model}`);
}

/** At start: make sure the current keys of the chat and picture models are approved, so no delivery waits for it. */
export async function warmTee() {
  if (DRY || !NEAR || !nearaiKey()) return;
  for (const model of [MODEL, IMAGE_MODEL]) {
    try {
      const r = await fetch(`${NEARAI}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${randomBytes(32).toString('hex')}`, {
        headers: { authorization: `Bearer ${nearaiKey()}` }, signal: AbortSignal.timeout(60_000),
      });
      const d: any = await r.json();
      for (const m of d.model_attestations ?? []) await ensureApproved(String(m.signing_address).toLowerCase(), model);
    } catch (e: any) {
      console.log(`tee: could not approve the ${model} key yet:`, String(e?.message ?? e).slice(0, 120));
    }
  }
}
