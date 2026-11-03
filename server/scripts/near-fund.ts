// Fund the bank on NEAR testnet from the owner's account: draw test USDC from the faucet (20 an hour),
// then deposit it into the bank, where it lands in OPERATING for the CFO to put to work.
//
//   node scripts/near-fund.ts [usd]      deposit `usd` (default: everything the owner holds)
import { NEAR, call, payBank, usdcOf, txUrl } from '../src/near/chain.ts';

if (!NEAR) throw new Error('no NEAR deployment');
const owner = NEAR.owner;
if (NEAR.usdcFaucet) {
  try {
    const r = await call(owner, NEAR.usdc, 'faucet', {}, { tgas: 30 });
    console.log(`faucet: +20 USDC to ${owner}  ${txUrl(r.hash)}`);
  } catch (e: any) {
    console.log(`faucet: ${e.message}`);
  }
}
const have = await usdcOf(owner);
const usd = Math.min(have, Number(process.argv[2] ?? have));
if (usd <= 0) throw new Error(`${owner} holds no USDC`);
const r = await payBank(owner, usd, 'deposit');
console.log(`deposited ${usd} USDC into ${NEAR.bank} (OPERATING)  ${txUrl(r.hash)}`);
