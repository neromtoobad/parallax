import { useState } from 'react';
import { api, useLoad, type Info, type Order } from './api.ts';
import { go, Link } from './router.tsx';

export function OrderPage({ id, info }: { id: string; info?: Info }) {
  const services = useLoad(api.services);
  const s = services?.find((x) => x.id === id);
  const [input, setInput] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Order>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (services && !s) return <div className="wrap"><p className="big-empty">No such service. <Link to="/#services">See what we do</Link></p></div>;
  if (!s) return null;

  const ask = async () => {
    setBusy(true); setErr('');
    try { setQuote(await api.quote(s.id, input)); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const pay = async () => {
    setBusy(true); setErr('');
    try { await api.pay(quote!.id); go(`/job/${quote!.id}`); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const demo = info?.mode === 'demo';

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
          {err && <p className="err">{err}</p>}
          <button className="pill" onClick={ask} disabled={busy}>{busy ? 'Getting a price…' : 'Get the price'} <b>→</b></button>
        </div>
      ) : (
        <div className="panel">
          <span className="mono k">Your quote</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, margin: '10px 0 14px' }}><span className="price" style={{ fontSize: 56 }}>{quote.priceUsd}</span><b>USDC</b></div>
          <p className="sub">The CFO {demo ? 'would open' : 'has opened'} job <span className="mono">{quote.id}</span> in the bank contract. Pay it into escrow and the auction starts. The money goes to the winning agents only when you accept the work; a part that fails inspection is paid nothing.</p>
          {quote.txs[0] && <p className="note" style={{ marginTop: 10 }}><a href={quote.txs[0].url} target="_blank">{quote.txs[0].what} ↗</a></p>}
          {err && <p className="err">{err}</p>}
          <div className="ctas">
            <button className="pill" onClick={pay} disabled={busy}>{busy ? 'Paying…' : demo ? `Pay ${quote.priceUsd} USDC (demo)` : `Pay ${quote.priceUsd} test USDC`} <b>→</b></button>
            <button className="ghost" onClick={() => setQuote(undefined)}>Change the brief</button>
          </div>
          <p className="note">{demo ? 'Demo mode: nothing is charged and nothing touches the chain.' : 'Paid from the house test wallet on NEAR testnet, so you can try it without a wallet.'}</p>
        </div>
      )}
    </div>
  );
}
