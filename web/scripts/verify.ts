// The proof page's checks from a terminal: every auction on bank.parallax.testnet rebuilt from NEAR testnet itself.
// Needs node 22.18 or newer, no install and no keys:
//   node web/scripts/verify.ts            every check, then the tally
//   node web/scripts/verify.ts --tamper   change one revealed bid by $0.000001 first, to watch a check fail
import { load, verify } from '../src/proof.ts';

const tamper = process.argv.includes('--tamper');
const p = await verify(await load((s) => process.stderr.write(`${s}\n`)), tamper);
for (const c of p.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}: ${c.detail}`);
for (const j of p.jobs) {
  console.log(`\njob ${j.job.id} · ${j.outcome}`);
  for (const r of j.rounds) for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} lot ${r.lot.id} ${c.what}: ${c.detail}`);
  for (const c of j.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.what}: ${c.detail}`);
}
console.log(`\n${p.passed} of ${p.total} checks pass, from ${p.txs} bank transactions${tamper ? ' (one bid tampered with)' : ''}`);
process.exit(p.passed === p.total ? 0 : 1);
