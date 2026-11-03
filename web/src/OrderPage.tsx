import { useEffect, useState } from 'react';
import { api, useLoad, type Info, type Order } from './api.ts';
import { go, Link } from './router.tsx';
import { drawTestUsdc, payJob, usdcBalance, useWallet } from './wallet.ts';

export function OrderPage({ id, info }: { id: string; info?: Info }) {
  const services = useLoad(api.services);
  const s = services?.find((x) => x.id === id);
  const [input, setInput] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Order>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [payer, setPayer] = useState<'house' | 'own'>('house');
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
      const who = own ? wallet.account ?? (await wallet.connect()) : undefined;
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
              </div>
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
