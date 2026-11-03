import { useEffect, useState } from 'react';
import { api, useEvents, usd, type Event, type Info, type Order, type Step } from './api.ts';
import { Face, LotCard, type LiveLot } from './parts.tsx';
import { Link } from './router.tsx';
import { nameOf } from './team.ts';

const NAMES: Record<string, string> = { 'find-customers': 'Find customers', website: 'Website', flyers: 'Flyers' };
const FLOW = ['funded', 'bidding', 'working', 'delivered', 'accepted'] as const;
const FLOW_LABEL: Record<string, string> = { funded: 'Paid into escrow', bidding: 'Auction', working: 'Work', delivered: 'Delivered', accepted: 'Accepted · paid out' };
const KIND: Record<string, string> = { start: 'started', done: 'done', note: 'note', search: 'searched', pass: 'passed it', fail: 'failed it', error: 'error', retry: 'retrying', hire: 'hired' };

/** The lots as the event stream tells it, phase by phase. */
function applyLot(lots: LiveLot[], d: any): LiveLot[] {
  if (d.phase === 'plan') return d.lots.map((p: any, i: number) => ({ id: -1 - i, title: p.title, roles: p.roles, reserve: p.reserve, status: 'bidding', bids: [], sealed: [], quotes: [] }));
  const at = lots.findIndex((l) => l.id === d.lot) >= 0 ? lots.findIndex((l) => l.id === d.lot) : lots.findIndex((l) => l.title === d.title && l.id < 0);
  if (at < 0) return lots;
  const l = { ...lots[at] }, next = [...lots];
  next[at] = l;
  switch (d.phase) {
    case 'open': Object.assign(l, { id: d.lot, status: 'bidding', ...(d.round > 1 ? { round: d.round, bids: [], sealed: [], quotes: [], winner: undefined, pay: undefined } : {}) }); break;
    case 'commit': l.sealed = [...(l.sealed ?? []), d.agent]; break;
    case 'quote': l.quotes = [...(l.quotes ?? []), { handle: d.agent, price: d.price, quality: d.quality, entered: d.entered, why: d.why ?? '' }]; break;
    case 'reveal': l.bids = [...l.bids, { agent: d.agent, role: d.role, price: d.price }]; break;
    case 'award': Object.assign(l, { status: 'awarded', winner: d.role === 'outside' ? `outside:${d.winner}` : d.winner, bid: d.bid, pay: d.pay, tx: d.tx }); break;
    case 'void': l.status = 'void'; break;
    case 'pass-inspection': l.status = 'passed'; break;
    case 'fail-inspection': l.status = 'failed'; break;
  }
  return next;
}

export function JobPage({ id, info }: { id: string; info?: Info }) {
  const [o, setO] = useState<Order>();
  const [lots, setLots] = useState<LiveLot[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api.order(id).then((x) => { setO(x); if (x.lots.length && !['bidding'].includes(x.state)) setLots([]); }).catch(() => setMissing(true));
  useEffect(() => { void load(); }, [id]);
  useEvents(id, (e: Event) => {
    if (e.type === 'lot') setLots((l) => applyLot(l, e.data));
    if (e.type === 'step') setSteps((s) => (s.some((x) => x.at === e.data.at && x.text === e.data.text) ? s : [...s, e.data]));
    if (e.type === 'order' || e.type === 'bill') void load();
  });
  if (missing) return <div className="wrap"><p className="big-empty">No job with that number. <Link to="/">Home</Link></p></div>;
  if (!o) return null;

  const shownLots: LiveLot[] = lots.length && (o.state === 'bidding' || o.state === 'working' || !o.lots.length) ? lots : o.lots;
  const shownSteps = o.steps.length >= steps.length ? o.steps : steps;
  const stage = FLOW.indexOf(o.state as any);
  const spent = o.receipt.reduce((t, r) => t + r.usd, 0);
  const paidOut = o.lots.filter((l) => l.status === 'passed').reduce((t, l) => t + (l.pay ?? 0), 0);
  const accept = async () => { setBusy(true); try { setO(await api.accept(o.id)); } catch (e: any) { alert(e.message); } setBusy(false); };

  return (
    <div className="wrap">
      <div className="jobhead">
        <div>
          <span className="mono k">Job {o.id} · {o.priceUsd} USDC in escrow</span>
          <h1 style={{ marginTop: 10 }}>{NAMES[o.service] ?? o.service}{o.input?.business ? <span style={{ color: 'var(--muted)' }}> for {o.input.business.split(',')[0]}</span> : null}</h1>
          <div className="states">
            {FLOW.map((s, i) => <span key={s} className={o.state === 'failed' ? '' : i < stage ? 'done' : i === stage ? 'on' : ''}>{FLOW_LABEL[s]}</span>)}
            {o.state === 'failed' && <span className="on" style={{ background: 'var(--red)' }}>Stopped</span>}
          </div>
        </div>
        {(o.state === 'bidding' || o.state === 'working' || o.state === 'funded') && <span className="chip mono"><i className="dot pulse" />live</span>}
      </div>

      {o.state === 'delivered' && (
        <div className="acc">
          <div><b style={{ fontSize: 20 }}>Delivered and checked.</b><p>Accept it and the bank pays each winner from your escrow. {o.delivery?.check.notes[0] ?? ''}</p></div>
          <button className="pill light" onClick={accept} disabled={busy}>{busy ? 'Accepting…' : 'Accept the work'} <b>→</b></button>
        </div>
      )}
      {o.state === 'failed' && <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 20 }}><b>The job stopped.</b> <span className="note">{o.error} Lots that fail inspection are paid nothing; the escrow goes back to you.</span></div>}

      <div className="cols">
        <div>
          <div className="lots">{shownLots.map((l) => <LotCard key={`${l.id}-${l.title}`} lot={l} explorer={info?.explorer} />)}
            {!shownLots.length && <div className="card big-empty">The CFO is splitting the job into lots…</div>}
          </div>
          {o.delivery && <div style={{ marginTop: 20 }}><Delivery o={o} /></div>}
        </div>
        <div style={{ display: 'grid', gap: 20 }}>
          <div className="card">
            <h3>The work <small className="note">{shownSteps.length} steps</small></h3>
            <div className="feed">
              {shownSteps.map((s, i) => (
                <div key={i} className={`st ${s.kind}`}>
                  <Face account={s.account} size={34} />
                  <div><b>{nameOf(s.account)}</b><small>{s.agent === 'cfo' ? '' : `${s.agent} · `}{KIND[s.kind] ?? s.kind}</small><p>{s.text}</p></div>
                </div>
              ))}
              {!shownSteps.length && <p className="note">The winners start as soon as the auction closes.</p>}
            </div>
          </div>
          <div className="card tx">
            <h3>The money</h3>
            <ul>
              <li><span>Customer paid into escrow</span><b className="num">{o.priceUsd} USDC</b></li>
              <li><span>Winners' pay (auction)</span><b className="num">{usd(o.lots.reduce((t, l) => t + (l.pay ?? 0), 0))} USDC</b></li>
              <li><span>Model calls, paid by the agents{info?.mode === 'demo' ? ' (demo)' : ''}</span><b className="num">{usd(spent)} USDC</b></li>
              {o.state === 'accepted' && <li><span>Paid out to winners</span><b className="num">{usd(paidOut)} USDC</b></li>}
            </ul>
            {o.txs.length > 0 && <><h3 style={{ marginTop: 16 }}>On NEAR</h3><ul>{o.txs.map((t) => <li key={t.hash}><span>{t.what}</span><a href={t.url} target="_blank">{t.hash.slice(0, 8)}… ↗</a></li>)}</ul></>}
            {o.receipt.length > 0 && <><h3 style={{ marginTop: 16 }}>Receipt</h3><ul>{o.receipt.map((r, i) => (
              <li key={i}><span>{nameOf(r.account ?? r.agent)} · {r.reason}</span><span className="num">{usd(r.usd, 5)}{r.settledTx && info?.explorer ? <> · <a href={`${info.explorer}/txns/${r.settledTx}`} target="_blank">paid ↗</a></> : null}</span></li>
            ))}</ul></>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Delivery({ o }: { o: Order }) {
  const d = o.delivery!;
  return (
    <div className="card">
      <h3>What you get <span className={`badge ${d.check.pass ? 'green' : 'red'}`}>{d.check.pass ? 'auditor passed' : 'auditor failed'}</span></h3>
      <p style={{ marginBottom: 16 }}>{d.summary}</p>
      {d.leads && <Leads o={o} />}
      {d.site && <>
        <iframe className="frame" src={d.site.path} title="The website" />
        <p style={{ marginTop: 12 }}><a className="ghost" href={d.site.path} target="_blank">Open the site ↗</a></p>
      </>}
      {d.flyers && <div className="flyers">{d.flyers.slice().reverse().map((f) => <Flyer key={f.name} f={f} />)}</div>}
    </div>
  );
}

function Leads({ o }: { o: Order }) {
  const d = o.delivery!;
  const first = d.leads![0];
  const fill = (s: string) => s.replace(/\{\{name\}\}/g, first?.name ?? '').replace(/\{\{opener\}\}/g, first?.opener ?? '');
  const csv = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([d.csv!], { type: 'text/csv' })); a.download = `leads-${o.id}.csv`; a.click(); };
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table className="leads"><thead><tr><th>Fit</th><th>Business</th><th>Reach them</th><th>Why, and the first line</th></tr></thead><tbody>
          {d.leads!.map((l) => (
            <tr key={l.osm}>
              <td><span className="fit">{[1, 2, 3, 4, 5].map((n) => <i key={n} className={n <= l.fit ? 'on' : ''} />)}</span></td>
              <td><b>{l.name}</b><div className="note">{l.address || l.kind} · <a href={l.osm} target="_blank">map</a></div></td>
              <td className="note">{l.email && <div><a href={`mailto:${l.email}`}>{l.email}</a></div>}{l.phone && <div>{l.phone}</div>}{l.website && <div><a href={l.website.startsWith('http') ? l.website : `https://${l.website}`} target="_blank">website</a></div>}</td>
              <td>{l.why}<div className="note" style={{ marginTop: 4 }}>“{l.opener}”</div></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {d.email && <>
        <h3 style={{ marginTop: 20 }}>The email <small className="note">shown for {first?.name}</small></h3>
        <div className="mail"><b>{fill(d.email.subject)}</b>{'\n\n'}{fill(d.email.body)}</div>
      </>}
      <p style={{ marginTop: 14 }}><button className="ghost" onClick={csv}>Download the list (CSV)</button></p>
    </>
  );
}

function Flyer({ f }: { f: { name: string; svg: string; w: number; h: number } }) {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(f.svg)}`;
  const png = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = f.w * 2; c.height = f.h * 2;
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `${f.name}.png`; a.click();
    };
    img.src = url;
  };
  return (
    <div>
      <img src={url} alt={f.name} />
      <p style={{ marginTop: 10, display: 'flex', gap: 8 }}><button className="ghost" onClick={png}>PNG</button><a className="ghost" href={url} download={`${f.name}.svg`}>SVG</a><span className="note" style={{ alignSelf: 'center' }}>{f.name === 'flyer-a5' ? 'A5, to print' : 'Square, to post'}</span></p>
    </div>
  );
}
