// The proof page's checks from a terminal: every auction on the bank rebuilt from NEAR itself.
// Needs node 22.18 or newer, no install and no keys:
//   node web/scripts/verify.ts            every check on the testnet bank (bank.parallax.testnet), then the tally
//   node web/scripts/verify.ts --mainnet  the same on the mainnet bank (bank.useparallax.near)
//   node web/scripts/verify.ts --tamper   change one revealed bid by $0.000001 first, to watch a check fail
//   PARALLAX_BANK=bank.x.testnet PARALLAX_USDC=usdc.x.testnet PARALLAX_REPORTS=http://localhost:8790/api/attestation PARALLAX_CREW=http://localhost:8790/api/crew PARALLAX_BOARD=http://localhost:8790/api/board …   another bank
import { NET, load, setNet, verify } from '../src/proof.ts';

if (process.argv.includes('--mainnet'))
  setNet({ mode: 'mainnet', bank: 'bank.useparallax.near', usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', explorer: 'https://nearblocks.io' });

NET.bank = process.env.PARALLAX_BANK ?? NET.bank;
NET.usdc = process.env.PARALLAX_USDC ?? NET.usdc;
NET.reports = process.env.PARALLAX_REPORTS ?? NET.reports;
NET.crew = process.env.PARALLAX_CREW ?? NET.crew;
NET.board = process.env.PARALLAX_BOARD ?? NET.board;

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
