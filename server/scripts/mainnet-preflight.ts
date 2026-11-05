// Before a mainnet deploy: checks everything contracts/near/deploy.sh will need, reading only. Nothing is
// signed or sent. Prints what's ready, what's missing, and the exact deploy command.
//
//   node scripts/mainnet-preflight.ts parallax.near
//   SIGN=ledger node scripts/mainnet-preflight.ts parallax.near      the root signs on a Ledger
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? process.env.ROOT;
if (!ROOT) { console.error('usage: node scripts/mainnet-preflight.ts <root account, e.g. parallax.near>'); process.exit(2); }
const RPC = process.env.NEAR_RPC ?? 'https://free.rpc.fastnear.com';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const REPO = new URL('../../', import.meta.url).pathname;
const ROLES = ['scout', 'researcher', 'writer', 'illustrator', 'reader', 'analyst', 'messenger', 'auditor', 'producer', 'investigator'];
const AGENTS = [...ROLES, 'researcher-2', 'writer-2', 'illustrator-2', 'auditor-2'].map((r) => `${r}.team.${ROOT}`);
const ACCOUNTS = ['bank', 'cfo', 'contributors', 'compute', 'team'].map((a) => `${a}.${ROOT}`).concat(AGENTS);
const NEED_NEAR = 6.49 + 0.1; // deploy.sh's lean mainnet plan for 14 agents, plus a little for retries

let blocking = 0;
const ok = (s: string) => console.log(`  ok    ${s}`);
const warn = (s: string) => console.log(`  note  ${s}`);
const bad = (s: string) => { blocking++; console.log(`  NO    ${s}`); };

async function query(params: object): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }) });
  return r.json();
}
const account = async (id: string) => (await query({ request_type: 'view_account', account_id: id })).result as { amount: string; locked: string; storage_usage: number } | undefined;
async function view<T>(contract: string, method: string, args: object = {}): Promise<T | undefined> {
  const d = await query({ request_type: 'call_function', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return d.result ? JSON.parse(Buffer.from(d.result.result).toString()) : undefined;
}
const near = (yocto: string | bigint) => Number(BigInt(yocto) / 10n ** 18n) / 1e6;
const has = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };

console.log(`\nMainnet preflight for ${ROOT} (reads only, via ${RPC})\n`);

console.log('Root account');
const root = await account(ROOT);
if (!root) bad(`${ROOT} doesn't exist on mainnet yet. Create it in a wallet (MyNearWallet, Meteor or HOT) and fund it with about ${NEED_NEAR} NEAR`);
else {
  // what the account can spend: its balance minus what its own storage locks (1 NEAR per 100 KB)
  const free = near(root.amount) - root.storage_usage / 1e5;
  (free >= NEED_NEAR ? ok : bad)(`${ROOT} has ${free.toFixed(2)} NEAR free; the deploy needs about ${NEED_NEAR}`);
}
const keyFile = join(homedir(), '.near-credentials', 'mainnet', `${ROOT}.json`);
if (process.env.SIGN === 'ledger') warn(`the root signs on a Ledger (SIGN=ledger): keep it plugged in with the NEAR app open`);
else (existsSync(keyFile) ? ok : bad)(existsSync(keyFile) ? `the root's key is in ~/.near-credentials/mainnet` : `no key for ${ROOT} in ~/.near-credentials/mainnet: import it with \`near account import-account\`, or use SIGN=ledger`);

console.log('\nAccounts the deploy creates');
const taken = (await Promise.all(ACCOUNTS.map(async (a) => ((await account(a)) ? a : null)))).filter(Boolean) as string[];
if (!taken.length) ok(`all ${ACCOUNTS.length} are free`);
else warn(`${taken.length} already exist and will be skipped: ${taken.join(', ')}`);
if (taken.includes(`bank.${ROOT}`)) warn(`bank.${ROOT} exists: the deploy won't redeploy it. Check it's the bank you mean`);

console.log('\nUSDC on NEAR');
const meta = await view<{ symbol: string; decimals: number }>(USDC, 'ft_metadata');
(meta?.symbol === 'USDC' && meta.decimals === 6 ? ok : bad)(`token ${USDC.slice(0, 10)}…: ${meta ? `${meta.symbol}, ${meta.decimals} decimals` : 'unreadable'}`);
const bounds = await view<{ min: string }>(USDC, 'storage_balance_bounds');
if (bounds) ok(`registering an account costs ${(Number(bounds.min) / 1e24).toFixed(5)} NEAR`);
const policy = JSON.parse(readFileSync(join(REPO, 'contracts/near/policy-mainnet.json'), 'utf8'));
const week = (Number(policy.reserve_floor) + Number(policy.epoch_tool_budget)) / 1e6; // reserve floor + a week of top-ups
const usdc = root ? Number((await view<string>(USDC, 'ft_balance_of', { account_id: ROOT })) ?? 0) / 1e6 : 0;
(usdc >= 3 ? ok : warn)(`${ROOT} holds ${usdc} USDC. After the deploy, deposit about 3 into the bank to start (${week} covers a full week of top-ups); not needed to deploy`);

console.log('\nBuild and tools');
const wasm = join(REPO, 'contracts/near/target/near/parallax_near.wasm');
if (existsSync(wasm)) {
  const kb = statSync(wasm).size / 1000;
  ok(`bank contract built: ${kb.toFixed(0)} KB, about ${(kb / 100).toFixed(1)} NEAR of storage (bank.${ROOT} starts with 4.1)`);
} else warn('contract not built yet; deploy.sh builds it (cargo near build)');
(has('near', ['--version']) ? ok : bad)('near-cli-rs');
(has('cargo', ['near', '--version']) ? ok : bad)('cargo-near');
(existsSync(join(REPO, 'deployments/near-mainnet.json')) ? warn : ok)(existsSync(join(REPO, 'deployments/near-mainnet.json'))
  ? 'deployments/near-mainnet.json exists already: deploy.sh leaves it as it is'
  : 'deployments/near-mainnet.json will be written by deploy.sh');

console.log('\nRunning on mainnet afterwards (set on the server; values are not shown)');
const env = (k: string, what: string) => (process.env[k] ? ok : warn)(`${k} ${process.env[k] ? 'is set' : 'is not set'}: ${what}`);
env('NEARAI_API_KEY', 'agents need it to call models');
env('PARALLAX_NEAR_KEYS', "the agents' and CFO's keys when hosted (locally they come from ~/.near-credentials/mainnet)");
env('PARALLAX_MARKET_HIRE', 'hiring Agent Market agents (with MARKET_PAYER, MARKET_PAYER_KEY)');
env('PARALLAX_MAINNET_ACCOUNT', 'where paying from another chain (1Click) delivers');

console.log(blocking
  ? `\n${blocking} thing${blocking === 1 ? '' : 's'} to fix before deploying.\n`
  : `\nReady. To see the plan and cost again, then deploy (it asks you to type ${ROOT} first):\n  cd contracts/near && NET=mainnet ROOT=${ROOT} PLAN_ONLY=1 ./deploy.sh\n  cd contracts/near && NET=mainnet ROOT=${ROOT}${process.env.SIGN === 'ledger' ? ' SIGN=ledger' : ''} ./deploy.sh\n`);
process.exit(blocking ? 1 : 0);
