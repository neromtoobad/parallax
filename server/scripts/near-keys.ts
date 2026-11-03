// Builds PARALLAX_NEAR_KEYS for hosting: the CFO's function-call key and each agent's key, read from the
// near-cli keychain (~/.near-credentials/<net>). Only these accounts sign on the server; the owner's and the
// bank's keys are never included. Writes a private file (mode 600) outside the repo and prints account
// names only, never a key. Paste the file's contents into the host's secret settings.
//
//   PARALLAX_NEAR_NET=mainnet node scripts/near-keys.ts [out file]   default ~/.parallax-<net>-keys.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NEAR } from '../src/near/chain.ts';

if (!NEAR) throw new Error('no NEAR deployment: set PARALLAX_NEAR_NET and check deployments/near-<net>.json');
const dir = join(homedir(), '.near-credentials', NEAR.network);
const out = process.argv[2] ?? join(homedir(), `.parallax-${NEAR.network}-keys.json`);
if (out.startsWith(new URL('../../', import.meta.url).pathname)) throw new Error('write it outside the repository');

const keys: Record<string, string> = {};
const read = (file: string) => (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { private_key: string }).private_key;
// the CFO: only its function-call key on the bank
if (existsSync(join(dir, `${NEAR.cfo}.bank-key.json`))) keys[NEAR.cfo] = read(`${NEAR.cfo}.bank-key.json`);
else console.log(`  missing: ${NEAR.cfo}.bank-key.json (deploy.sh makes it)`);
// every agent under team.<root>, the second agents included
const team = `.${NEAR.team[Object.keys(NEAR.team)[0]].split('.').slice(1).join('.')}`;
for (const f of readdirSync(dir).filter((f) => f.endsWith(`${team}.json`))) keys[f.slice(0, -5)] = read(f);

writeFileSync(out, JSON.stringify(keys), { mode: 0o600 });
console.log(`wrote ${Object.keys(keys).length} keys to ${out} (mode 600):\n  ${Object.keys(keys).sort().join('\n  ')}`);
