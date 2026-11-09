import { useEffect, useState } from 'react';
import { api, useLoad, type Info, type Order, type PayAsset } from './api.ts';
import { go, Link } from './router.tsx';
import { drawTestUsdc, payJob, usdcBalance, useWallet } from './wallet.ts';

export function OrderPage({ id, info }: { id: string; info?: Info }) {
  const services = useLoad(api.services);
  const s = services?.find((x) => x.id === id);
  const [input, setInput] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Order>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [payer, setPayer] = useState<'house' | 'own' | 'chain'>('house');
  const [balance, setBalance] = useState<number>();
  const wallet = useWallet(info);
  const demo = info?.mode === 'demo';
  const own = !demo && payer === 'own';
  const refresh = () => { if (info && wallet.account) usdcBalance(info, wallet.account).then(setBalance).catch(() => {}); };
  useEffect(refresh, [wallet.account, info?.mode]);
  if (services && !s) return <div className="wrap"><p className="big-empty">No such service. <Link to="/#services">See what we do</Link></p></div>;
  if (!s) return null;

  const ask = async () => {
    setBusy(true); setErr('');
    try {
      const who = own ? wallet.account ?? (await wallet.connect()) : payer === 'chain' ? wallet.account ?? undefined : undefined;
      if (own && !who) throw new Error('Connect a NEAR wallet to pay from it');
      setQuote(await api.quote(s.id, input, who));
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const pay = async () => {
    setBusy(true); setErr('');
    try {
      if (own) {
        if (wallet.account !== quote!.customer) throw new Error(`Sign in as ${quote!.customer} to pay this job`);
        await payJob(info!, quote!.id, quote!.priceUsd);
        await api.pay(quote!.id, 'own');
      } else await api.pay(quote!.id);
      go(`/job/${quote!.id}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const faucet = async () => {
    setBusy(true); setErr('');
    try { await drawTestUsdc(info!); setTimeout(refresh, 2000); } catch (e: any) { setErr(e.message.includes('one drip') ? 'The faucet gives 20 test USDC once an hour; try again later.' : e.message); }
    setBusy(false);
  };
  const short = own && balance !== undefined && quote && balance < quote.priceUsd;

  return (
    <div className="wrap" style={{ maxWidth: 980 }}>
      <div className="jobhead">
        <div><span className="mono k">{s.name} · ${s.priceUsd} USDC</span><h1 style={{ marginTop: 10 }}>{s.name}</h1><p className="sub" style={{ marginTop: 10 }}>{s.blurb}</p></div>
      </div>
      {!quote ? (
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 20 }}>Tell the team about it</b>
            <button className="ghost" onClick={() => setInput(s.example)}>Fill in an example</button>
          </div>
          {s.fields.map((f) => (
            <label key={f.key} className="f">
              <span>{f.label}{f.optional && <em>optional</em>}</span>
              {f.long
                ? <textarea className="i" placeholder={f.hint} value={input[f.key] ?? ''} onChange={(e) => setInput({ ...input, [f.key]: e.target.value })} />
                : <input className="i" placeholder={f.hint} value={input[f.key] ?? ''} onChange={(e) => setInput({ ...input, [f.key]: e.target.value })} />}
            </label>
          ))}
          {!demo && (
            <div className="f">
              <span>Who pays</span>
              <div className="seg">
                <button className={payer === 'house' ? 'on' : ''} onClick={() => setPayer('house')}>The house wallet <em>free to try</em></button>
                <button className={payer === 'own' ? 'on' : ''} onClick={() => setPayer('own')}>My NEAR wallet <em>{info?.mode === 'mainnet' ? 'real USDC' : 'test USDC'}</em></button>
                {info?.mode === 'mainnet' && <button className={payer === 'chain' ? 'on' : ''} onClick={() => setPayer('chain')}>Another chain <em>via NEAR Intents</em></button>}
              </div>
              {payer === 'chain' && (
                <p className="note" style={{ marginTop: 8 }}>
                  Pay with USDC, USDT, ETH, SOL or BTC from Ethereum, Base, Arbitrum, Solana or Bitcoin. NEAR Intents swaps it and sends exactly the price as USDC into the bank's escrow for this job. The house wallet accepts the work for you{wallet.account ? <>, or you do from <b className="mono">{wallet.account}</b></> : ''}.
                </p>
              )}
              {payer === 'own' && (
                <p className="note" style={{ marginTop: 8 }}>
                  {wallet.account
                    ? <>Signed in as <b className="mono">{wallet.account}</b>{balance !== undefined && <> · {balance.toFixed(2)} USDC</>} · <a href="#" onClick={(e) => { e.preventDefault(); void wallet.disconnect(); }}>sign out</a></>
                    : <a href="#" onClick={(e) => { e.preventDefault(); void wallet.connect().catch(() => {}); }}>Connect a NEAR wallet</a>}
                  {' '}You pay into the bank's escrow, and you accept or reject the work from your wallet.
                </p>
              )}
            </div>
          )}
          {err && <p className="err">{err}</p>}
          <button className="pill" onClick={ask} disabled={busy}>{busy ? 'Getting a price…' : own && !wallet.account ? 'Connect and get the price' : 'Get the price'} <b>→</b></button>
        </div>
      ) : payer === 'chain' && !demo ? (
        <ChainPay quote={quote} onBack={() => setQuote(undefined)} />
      ) : (
        <div className="panel">
          <span className="mono k">Your quote</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, margin: '10px 0 14px' }}><span className="price" style={{ fontSize: 56 }}>{quote.priceUsd}</span><b>USDC</b></div>
          <p className="sub">The CFO {demo ? 'would open' : 'has opened'} job <span className="mono">{quote.id}</span> in the bank contract. Pay it into escrow and the auction starts. The money goes to the winning agents only when you accept the work; a part that fails inspection is paid nothing.</p>
          {quote.txs[0] && <p className="note" style={{ marginTop: 10 }}><a href={quote.txs[0].url} target="_blank">{quote.txs[0].what} ↗</a></p>}
          {err && <p className="err">{err}</p>}
          {short && (
            <p className="note" style={{ marginTop: 10 }}>
              {wallet.account} holds {balance!.toFixed(2)} USDC.{' '}
              {info?.faucet ? <a href="#" onClick={(e) => { e.preventDefault(); void faucet(); }}>Get 20 test USDC from the faucet</a> : 'Add USDC on NEAR to this account first.'}
            </p>
          )}
          <div className="ctas">
            <button className="pill" onClick={pay} disabled={busy || !!short}>
              {busy ? 'Paying…' : demo ? `Pay ${quote.priceUsd} USDC (demo)` : own ? `Pay ${quote.priceUsd} USDC from my wallet` : `Pay ${quote.priceUsd} USDC from the house wallet`} <b>→</b>
            </button>
            <button className="ghost" onClick={() => setQuote(undefined)}>Change the brief</button>
          </div>
          <p className="note">
            {demo ? 'Demo mode: nothing is charged and nothing touches the chain.'
              : own ? `Your wallet sends ${quote.priceUsd} USDC to the bank contract, naming job ${quote.id}. It stays in escrow until you accept.`
              : `The house wallet (${info?.house}) pays and accepts for you, so you can try it without a wallet. The bank tops it up from its own margin, within a weekly cap.`}
          </p>
        </div>
      )}
    </div>
  );
}

const CHAIN: Record<string, string> = { eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', sol: 'Solana', btc: 'Bitcoin', near: 'NEAR' };
const LIVE = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING'];
const SAY: Record<string, string> = {
  PENDING_DEPOSIT: 'Waiting for your deposit', KNOWN_DEPOSIT_TX: 'Deposit seen, waiting for confirmations', PROCESSING: 'Swapping into USDC on NEAR',
  SUCCESS: 'Paid into escrow', INCOMPLETE_DEPOSIT: 'Less than the amount arrived: send the rest or wait for the refund', REFUNDED: 'Refunded to your address', FAILED: 'The swap failed',
};

/** Pay a quoted job from another chain: a real 1Click deposit address, then its status until the escrow is funded. */
function ChainPay({ quote, onBack }: { quote: Order; onBack: () => void }) {
  const assets = useLoad(api.payAssets);
  const [assetId, setAssetId] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [o, setO] = useState<Order>(quote);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [hash, setHash] = useState('');
  const d = o.intents;
  useEffect(() => {
    if (!d || !LIVE.includes(d.status)) return;
    const t = setInterval(() => api.order(o.id).then((x) => { setO(x); if (x.state !== 'quoted') go(`/job/${x.id}`); }).catch(() => {}), 6000);
    return () => clearInterval(t);
  }, [d?.status, o.id]);
  const list = (assets ?? []).slice().sort((a, b) => (a.symbol + a.chain).localeCompare(b.symbol + b.chain));
  const pick: PayAsset | undefined = list.find((a) => a.assetId === assetId);
  const open = async () => {
    setBusy(true); setErr('');
    try { setO(await api.payFromChain(o.id, assetId, refundTo)); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const sent = async () => { if (hash.trim()) { try { setO(await api.sentDeposit(o.id, hash.trim())); setHash(''); } catch (e: any) { setErr(e.message); } } };
  return (
    <div className="panel">
      <span className="mono k">Your quote · pay from another chain</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, margin: '10px 0 14px' }}><span className="price" style={{ fontSize: 56 }}>{o.priceUsd}</span><b>USDC into escrow</b></div>
      {!d ? (
        <>
          <p className="sub">The CFO has opened job <span className="mono">{o.id}</span> in the bank contract. Choose what you pay with. NEAR Intents opens a deposit address for it; when your deposit lands, it swaps and sends exactly {o.priceUsd} USDC to the bank with this job's name, and the auction starts.</p>
          {o.txs[0] && <p className="note" style={{ marginTop: 10 }}><a href={o.txs[0].url} target="_blank">{o.txs[0].what} ↗</a></p>}
          <label className="f" style={{ marginTop: 16 }}>
            <span>Pay with</span>
            <select className="i" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">{assets ? 'Choose a token' : 'Loading tokens…'}</option>
              {list.map((a) => <option key={a.assetId} value={a.assetId}>{a.symbol} on {CHAIN[a.chain] ?? a.chain}</option>)}
            </select>
          </label>
          <label className="f">
            <span>Your {pick ? `${CHAIN[pick.chain] ?? pick.chain} ` : ''}address for a refund</span>
            <input className="i mono" placeholder="if the swap can't complete, it goes back here" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} />
          </label>
          {err && <p className="err">{err}</p>}
          <div className="ctas">
            <button className="pill" onClick={open} disabled={busy || !assetId || !refundTo.trim()}>{busy ? 'Opening a deposit address…' : 'Get a deposit address'} <b>→</b></button>
            <button className="ghost" onClick={onBack}>Change the brief</button>
          </div>
          <p className="note">Nothing is charged until you send. The address is good for about 25 minutes; the job waits 30.</p>
        </>
      ) : (
        <>
          <p className="sub">Send exactly <b className="mono">{d.amountIn} {d.symbol}</b> on {CHAIN[d.chain] ?? d.chain} (about ${d.amountInUsd.toFixed(2)}) to:</p>
          <p className="mono" style={{ fontSize: 18, wordBreak: 'break-all', margin: '12px 0', padding: 14, background: 'var(--paper, #F2F1E9)', borderRadius: 10 }}>{d.address}</p>
          {d.memo && <p className="note">With the memo <b className="mono">{d.memo}</b>.</p>}
          <p className="note">Before {new Date(d.deadline).toLocaleTimeString()}. A refund goes to <span className="mono">{d.refundTo}</span>.</p>
          <p style={{ marginTop: 14 }}><b>{SAY[d.status] ?? d.status}</b>{LIVE.includes(d.status) && <span className="note"> · checking every few seconds</span>}</p>
          {(d.txs ?? []).map((t) => <p key={t.hash} className="note mono">{t.chain === 'near' ? 'NEAR' : CHAIN[d.chain] ?? d.chain}: {t.hash.slice(0, 18)}…</p>)}
          {d.status === 'PENDING_DEPOSIT' && (
            <div className="f" style={{ marginTop: 12 }}>
              <span>Sent it? Paste the transaction hash to speed it up <em>optional</em></span>
              <div style={{ display: 'flex', gap: 8 }}><input className="i mono" value={hash} onChange={(e) => setHash(e.target.value)} /><button className="ghost" onClick={sent}>Tell 1Click</button></div>
            </div>
          )}
          {err && <p className="err">{err}</p>}
          {o.state !== 'quoted' && <button className="pill" onClick={() => go(`/job/${o.id}`)}>Watch the team work <b>→</b></button>}
        </>
      )}
    </div>
  );
}
