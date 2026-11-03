// A full round on NEAR testnet, without a model call: open a job (default: a 3 USDC website) for the owner as customer, fund it,
// let the team bid for its lots, award them, file and inspect the work, deliver, and accept. Prints who
// won what and what each agent was paid. Uses the owner's test USDC (faucet, or a withdrawal from OPERATING).
import { NEAR, call, payBank, usdcOf, txUrl, view } from '../src/near/chain.ts';
import { bus } from '../src/bus.ts';
import { auction, closeLots } from '../src/lots.ts';

const n = NEAR!, owner = n.owner, id = `e2e-${Date.now().toString(36)}`, service = process.argv[2] ?? 'website', price = Number(process.argv[3] ?? 3);
bus.on('event', (e: any) => e.type === 'lot' && console.log('  lot', JSON.stringify(e.data)));
if ((await usdcOf(owner)) < price) {
  await call(owner, n.usdc, 'faucet', {}, { tgas: 30 }).catch(async () => call(owner, n.bank, 'owner_withdraw', { from: 'Operating', to: owner, amount: String(Math.round((price - (await usdcOf(owner))) * 1e6) + 1) }));
}
const team = Object.values(n.team);
const before = Object.fromEntries(await Promise.all(team.map(async (a) => [a, await usdcOf(a)])));
console.log(`job ${id}: opening`, txUrl((await call(n.cfo, n.bank, 'open_job', { id, customer: owner, amount: String(price * 1e6), bond: '0', spec_hash: 'e2e', fund_secs: 600, deliver_secs: 3600 })).hash));
console.log('funding', txUrl((await payBank(owner, price, `job:${id}`)).hash));
const lots = await auction(id, service, price, process.argv[4]); // a brief lets Agent Market agents quote
await closeLots(id, lots, { steps: [], receipt: [] }, true);
console.log('submit', txUrl((await call(n.cfo, n.bank, 'submit_job', { id, deliverable_hash: 'e2e-deliverable' })).hash));
console.log('accept', txUrl((await call(owner, n.bank, 'accept', { id }, { tgas: 300 })).hash));
await new Promise((r) => setTimeout(r, 4000));
for (const a of team) { const d = (await usdcOf(a)) - before[a]; if (Math.abs(d) > 1e-9) console.log(`  ${a} +${d.toFixed(6)} USDC`); }
console.log('bank', (await view<any>(n.bank, 'overview')).buckets, 'contributors', await usdcOf(n.contributors));
process.exit(0);
