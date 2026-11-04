// The customer's own NEAR wallet (HOT, Meteor, MyNearWallet, Intear and others, through NEAR Connect):
// pay a job into escrow, then accept or reject the work. The bank only takes these from the customer.
import { useEffect, useState } from 'react';
import { NearConnector, type NearWalletBase } from '@hot-labs/near-connect';
import type { Info } from './api.ts';

const TGAS = 1_000_000_000_000n;
let connector: NearConnector | undefined;
let net: 'mainnet' | 'testnet' | undefined;
const listeners = new Set<(a?: string) => void>();
let account: string | undefined;
const tell = (a?: string) => { account = a; listeners.forEach((f) => f(a)); };

function get(network: 'mainnet' | 'testnet') {
  if (!connector || net !== network) {
    net = network;
    connector = new NearConnector({ network, footerBranding: null });
    connector.on('wallet:signIn', (t) => tell(t.accounts[0]?.accountId));
    connector.on('wallet:signOut', () => tell(undefined));
    connector.getConnectedWallet().then(({ accounts }) => tell(accounts[0]?.accountId)).catch(() => {});
  }
  return connector;
}
const networkOf = (info?: Info) => (info?.mode === 'mainnet' ? 'mainnet' : 'testnet');

/** The signed-in account, kept in step with the wallet. */
export function useWallet(info?: Info) {
  const [a, set] = useState<string | undefined>(account);
  useEffect(() => {
    if (!info || info.mode === 'demo') return;
    get(networkOf(info));
    listeners.add(set);
    set(account);
    return () => { listeners.delete(set); };
  }, [info?.mode]);
  return {
    account: a,
    connect: async () => { const w = await get(networkOf(info)).connect(); const [x] = await w.getAccounts(); tell(x?.accountId); return x?.accountId; },
    disconnect: async () => { await get(networkOf(info)).disconnect().catch(() => {}); tell(undefined); },
  };
}

async function send(info: Info, receiverId: string, methodName: string, args: object, gasT: number, deposit = '0'): Promise<string> {
  const w: NearWalletBase = await get(networkOf(info)).wallet();
  const r: any = await w.signAndSendTransaction({
    receiverId,
    actions: [{ type: 'FunctionCall', params: { methodName, args, gas: (BigInt(gasT) * TGAS).toString(), deposit } }],
  });
  return r?.transaction?.hash ?? r?.transaction_outcome?.id ?? '';
}

/** Pay the job's price into escrow: a USDC transfer to the bank that names the job. */
export const payJob = (info: Info, job: string, usd: number) =>
  send(info, info.usdc!, 'ft_transfer_call', { receiver_id: info.bank, amount: String(Math.round(usd * 1e6)), msg: `job:${job}` }, 80, '1');
export const acceptJob = (info: Info, job: string) => send(info, info.bank!, 'accept', { id: job }, 150);
export const rejectJob = (info: Info, job: string) => send(info, info.bank!, 'reject', { id: job }, 60);
/** Enlist an agent: the stake goes to the bank by ft_transfer_call, as the server spelled it out. */
export const enlistFromWallet = (info: Info, w: { receiverId: string; method: string; deposit: string; args: Record<string, unknown> }) =>
  send(info, w.receiverId, w.method, w.args, 80, w.deposit);
/** A sponsor takes its agent off the crew (its balance comes back), or takes some of what it earned. */
export const retireAgent = (info: Info, agent: string) => send(info, info.bank!, 'retire', { agent }, 60);
export const crewCashOut = (info: Info, agent: string, usd: number) => send(info, info.bank!, 'crew_cash_out', { agent, amount: String(Math.round(usd * 1e6)) }, 60);
/** Testnet only: 20 test USDC an hour from the token's faucet (it registers the account too). */
export const drawTestUsdc = (info: Info) => send(info, info.usdc!, 'faucet', {}, 30);

/** The account's USDC, read straight from the token. */
export async function usdcBalance(info: Info, who: string): Promise<number> {
  const rpc = info.mode === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com';
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: info.usdc, method_name: 'ft_balance_of', args_base64: btoa(JSON.stringify({ account_id: who })) } }),
  }).then((x) => x.json());
  const bytes = r?.result?.result;
  return bytes ? Number(JSON.parse(String.fromCharCode(...bytes))) / 1e6 : 0;
}
