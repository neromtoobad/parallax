// Pay from any chain through NEAR Intents (1Click). A customer picks a token on the chain they hold it on;
// 1Click opens a deposit address and, once the deposit lands, swaps it and sends exactly the job's price as
// USDC on NEAR straight to the bank with ft_transfer_call and the message `job:<id>` (its customRecipientMsg),
// so the escrow is funded by the swap itself, with no account of ours in between. The bank names the job's
// customer when it refunds, never the sender (the Intents contract), and EXACT_OUTPUT leaves no change.
// This runs on mainnet only: 1Click delivers mainnet USDC, and NEAR Intents has no testnet.
//
// `payQuote` stays a dry price check. A partner key (ONECLICK_JWT, from partners.near-intents.org) is sent when set.
const API = process.env.ONECLICK_API ?? 'https://1click.chaindefuser.com/v0';
const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export type PayAsset = { assetId: string; chain: string; symbol: string; decimals: number; price: number };
export type PayQuote = { from: PayAsset; amountIn: string; amountInUsd: number; amountOutUsd: number; minutes: number; fee: string };

const headers = () => ({ 'content-type': 'application/json', ...(process.env.ONECLICK_JWT ? { 'X-API-Key': process.env.ONECLICK_JWT } : {}) });
export const oneClickReady = () => !!process.env.PARALLAX_MAINNET_ACCOUNT;

let assets: { at: number; list: PayAsset[] } | undefined;
/** The tokens a customer can pay from: stablecoins and majors on the chains people hold them on. */
export async function payAssets(): Promise<PayAsset[]> {
  if (assets && Date.now() - assets.at < 3600_000) return assets.list;
  const r = await fetch(`${API}/tokens`, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`1Click tokens: ${r.status}`);
  const all: any[] = await r.json();
  const want = new Set(['USDC', 'USDT', 'ETH', 'SOL', 'BTC']);
  const chains = new Set(['eth', 'base', 'arb', 'sol', 'btc', 'near']);
  const list = all.filter((t) => want.has(t.symbol) && chains.has(t.blockchain) && t.assetId !== NEAR_USDC)
    .map((t) => ({ assetId: t.assetId, chain: t.blockchain, symbol: t.symbol, decimals: t.decimals, price: t.price }));
  assets = { at: Date.now(), list };
  return list;
}

/** What to send from `assetId` so that `usd` arrives as USDC on NEAR. `refundTo` is the customer's address on that chain. */
export async function payQuote(assetId: string, usd: number, refundTo: string): Promise<PayQuote> {
  const to = process.env.PARALLAX_MAINNET_ACCOUNT;
  if (!to) throw new Error('paying from another chain needs PARALLAX_MAINNET_ACCOUNT');
  const from = (await payAssets()).find((a) => a.assetId === assetId);
  if (!from) throw new Error('that token is not offered');
  const r = await fetch(`${API}/quote`, {
    method: 'POST', headers: headers(), signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100,
      originAsset: assetId, depositType: 'ORIGIN_CHAIN',
      destinationAsset: NEAR_USDC, amount: String(Math.round(usd * 1e6)),
      recipient: to, recipientType: 'DESTINATION_CHAIN',
      refundTo, refundType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.quote) throw new Error(`1Click: ${d.message ?? r.status}`);
  const q = d.quote;
  return {
    from, amountIn: q.amountInFormatted, amountInUsd: Number(q.amountInUsd), amountOutUsd: Number(q.amountOutUsd),
    minutes: Math.ceil(Number(q.timeEstimate ?? 60) / 60), fee: process.env.ONECLICK_JWT ? 'partner rate' : 'includes a 0.25% fee for unkeyed quotes',
  };
}

export type Deposit = {
  assetId: string; chain: string; symbol: string; address: string; memo?: string; amountIn: string; amountInUsd: number;
  refundTo: string; deadline: string; quoteId?: string; status: string; updatedAt: string; txs?: { chain: string; hash: string }[];
};

/**
 * A real 1Click quote (dry: false): a deposit address for `assetId` that pays `usd` USDC into the bank's escrow
 * for job `jobId`. Nothing moves until the customer sends to that address.
 */
export async function openDeposit(bank: string, usdc: string, jobId: string, assetId: string, usd: number, refundTo: string, minutes = 25): Promise<Deposit> {
  if (`nep141:${usdc}` !== NEAR_USDC) throw new Error('paying from another chain works on mainnet only (NEAR Intents has no testnet)');
  if (!/^[a-z0-9]{8,16}$/.test(jobId)) throw new Error('bad job id');
  if (!refundTo || refundTo.length > 120 || /\s/.test(refundTo)) throw new Error('give the address on that chain that a refund should go to');
  const from = (await payAssets()).find((a) => a.assetId === assetId);
  if (!from) throw new Error('that token is not offered');
  const r = await fetch(`${API}/quote`, {
    method: 'POST', headers: headers(), signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 100,
      originAsset: assetId, depositType: 'ORIGIN_CHAIN', depositMode: 'SIMPLE',
      destinationAsset: NEAR_USDC, amount: String(Math.round(usd * 1e6)),
      recipient: bank, recipientType: 'DESTINATION_CHAIN', customRecipientMsg: `job:${jobId}`,
      refundTo, refundType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + minutes * 60_000).toISOString(),
      referral: 'parallax',
    }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.quote?.depositAddress) throw new Error(/refundTo/i.test(String(d.message)) ? `that isn't an address on ${from.chain} that 1Click can refund to` : `1Click: ${d.message ?? r.status}`);
  const q = d.quote;
  return {
    assetId, chain: from.chain, symbol: from.symbol, address: q.depositAddress, memo: q.depositMemo || undefined,
    amountIn: q.amountInFormatted, amountInUsd: Number(q.amountInUsd), refundTo, deadline: new Date(Date.now() + minutes * 60_000).toISOString(), // ours: the job's escrow closes before 1Click's address does
    quoteId: d.correlationId ?? d.quoteId, status: 'PENDING_DEPOSIT', updatedAt: new Date().toISOString(),
  };
}

/** Where a deposit is: PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED or FAILED. */
export async function depositStatus(address: string, memo?: string): Promise<{ status: string; txs: { chain: string; hash: string }[] }> {
  const q = new URLSearchParams({ depositAddress: address, ...(memo ? { depositMemo: memo } : {}) });
  const r = await fetch(`${API}/status?${q}`, { headers: headers(), signal: AbortSignal.timeout(10_000) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`1Click status: ${d.message ?? r.status}`);
  const sd = d.swapDetails ?? {};
  const txs = [
    ...(sd.originChainTxHashes ?? []).map((t: any) => ({ chain: 'origin', hash: t.hash ?? String(t) })),
    ...(sd.destinationChainTxHashes ?? []).map((t: any) => ({ chain: 'near', hash: t.hash ?? String(t) })),
  ];
  return { status: String(d.status ?? 'UNKNOWN'), txs };
}

/** Tell 1Click the deposit's transaction hash so it starts at once instead of waiting to notice it. */
export async function submitDeposit(address: string, txHash: string, memo?: string) {
  await fetch(`${API}/deposit/submit`, {
    method: 'POST', headers: headers(), signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ txHash, depositAddress: address, ...(memo ? { memo } : {}) }),
  }).catch(() => undefined);
}
