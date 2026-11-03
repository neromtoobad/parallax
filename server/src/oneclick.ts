// Pay from any chain: a 1Click (NEAR Intents) quote for what a customer would send from their own chain
// and token so that the order's price lands as USDC on NEAR. Quotes are dry (nothing is deposited, no
// deposit address is opened); the escrow itself is still funded with USDC on NEAR.
//
// The recipient is Parallax's mainnet account (PARALLAX_MAINNET_ACCOUNT, set by the owner; never made up
// here). A partner key (ONECLICK_JWT, from partners.near-intents.org) is sent when set.
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
