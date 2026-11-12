import { useState } from 'react';
import { api, usd, type Info, type Order } from './api.ts';
import { Face, LotCard } from './parts.tsx';
import { shown, useJob } from './live.ts';
import { Workroom } from './Workroom.tsx';
import { Link } from './router.tsx';
import { nameOf } from './team.ts';
import { acceptJob, rejectJob, useWallet } from './wallet.ts';

const NAMES: Record<string, string> = { 'find-customers': 'Find customers', website: 'Website', flyers: 'Flyers', jingle: 'Jingle', storybook: 'Storybook', 'brand-kit': 'Brand kit', 'pitch-deck': 'Pitch deck', board: 'Board job', factcheck: 'Fact check' };
const FLOW = ['funded', 'bidding', 'working', 'delivered', 'accepted'] as const;
const FLOW_LABEL: Record<string, string> = { funded: 'Paid into escrow', bidding: 'Auction', working: 'Work', delivered: 'Delivered', accepted: 'Accepted · paid out' };
const KIND: Record<string, string> = { start: 'started', done: 'done', note: 'note', search: 'searched', pass: 'passed it', fail: 'failed it', error: 'error', retry: 'retrying', hire: 'hired' };

export function JobPage({ id, info }: { id: string; info?: Info }) {
  const job = useJob(id);
  const { o, missing, setO } = job;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wallet = useWallet(info);
  if (missing) return <div className="wrap"><p className="big-empty">No job with that number. <Link to="/">Home</Link></p></div>;
  if (!o) return null;

  const { lots: shownLots, steps: shownSteps, receipt: shownReceipt } = shown(job);
  const stage = FLOW.indexOf(o.state as any);
  const spent = o.receipt.reduce((t, r) => t + r.usd, 0);
  const paidOut = o.lots.filter((l) => l.status === 'passed').reduce((t, l) => t + (l.pay ?? 0), 0);
  const ownWallet = !!info && info.mode !== 'demo' && o.customer !== info.house;
  const mine = ownWallet && wallet.account === o.customer;
  const decide = async (yes: boolean) => {
    setBusy(true); setErr('');
    try {
      if (ownWallet) {
        if (!mine) { await wallet.connect(); throw new Error(`Sign in as ${o.customer} to ${yes ? 'accept' : 'reject'} this job`); }
        const tx = await (yes ? acceptJob : rejectJob)(info!, o.id);
        setO(await (yes ? api.accept : api.reject)(o.id, tx));
      } else setO(await api.accept(o.id));
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

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
      {o.parent && (
        <p className="note hired">
          Hired by <Link to={`/agent/${o.parent.by}`}>{nameOf(o.parent.by)}</Link> for its part of job <Link to={`/job/${o.parent.id}`} className="mono">{o.parent.id}</Link>,
          paid from its own balance. It is the customer here: it accepts the work, and the bank pays the winner from its escrow.
        </p>
      )}
      {o.subs?.length ? (
        <p className="note hired">
          {o.subs.map((s, i) => <span key={s.id}>{i ? '; ' : ''}<Link to={`/agent/${s.by}`}>{nameOf(s.by)}</Link> hired a {s.title.toLowerCase()} for {usd(s.amount, 4)} USDC from its own balance: job <Link to={`/job/${s.id}`} className="mono">{s.id}</Link></span>)}.
        </p>
      ) : null}

      {o.state === 'delivered' && !o.parent && (
        <div className="acc">
          <div>
            <b style={{ fontSize: 20 }}>Delivered and checked.</b>
            <p>Accept it and the bank pays each winner from your escrow.{ownWallet ? ' Reject it and the bank refunds the full price.' : ''} {o.delivery?.check.notes[0] ?? ''}</p>
            {err && <p className="err">{err}</p>}
          </div>
          <div className="ctas" style={{ margin: 0 }}>
            <button className="pill light" onClick={() => decide(true)} disabled={busy}>{busy ? 'Waiting for the bank…' : ownWallet ? 'Accept from my wallet' : 'Accept the work'} <b>→</b></button>
            {ownWallet && <button className="ghost" onClick={() => decide(false)} disabled={busy}>Reject and refund</button>}
          </div>
        </div>
      )}
      {o.state === 'rejected' && <div className="card" style={{ marginBottom: 20 }}><b>Rejected.</b> <span className="note">The bank refunded the full price to {o.customer}. Nobody was paid for this job.</span></div>}
      {o.state === 'failed' && <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 20 }}><b>The job stopped.</b> <span className="note">{o.error} Lots that fail inspection are paid nothing; the escrow goes back to you.</span></div>}

      <div className="jobwr"><Workroom o={o} lots={shownLots} steps={shownSteps} live /></div>

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
            {shownReceipt.length > 0 && <><h3 style={{ marginTop: 16 }}>Receipt</h3><ul>{shownReceipt.map((r, i) => (
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
      <h3>What you get {d.factcheck ? <span className="badge green">checked by the winner</span>
        : <span className={`badge ${d.check.pass ? 'green' : 'red'}`}>{d.check.pass ? 'auditor passed' : 'auditor failed'}</span>}</h3>
      <p style={{ marginBottom: 16 }}>{d.summary}</p>
      {d.leads && <Leads o={o} />}
      {d.site && <>
        <iframe className="frame" src={d.site.path} title={NAMES[o.service] ?? 'The work'} />
        <p style={{ marginTop: 12 }}><a className="ghost" href={d.site.path} target="_blank">{o.service === 'website' ? 'Open the site' : `Open the ${(NAMES[o.service] ?? 'work').toLowerCase()}`} ↗</a></p>
      </>}
      {d.audio && <p className="note" style={{ marginTop: 8 }}>Played from the producer's TEE-signed score, so anyone can render it again and get the same file · <a href={d.audio.path} download>WAV, {Math.round(d.audio.seconds)} s</a> · sha256 <span className="mono">{d.audio.sha256.slice(0, 16)}…</span></p>}
      {d.files && d.files.some((f) => f.name.endsWith('.svg')) && <p className="note" style={{ marginTop: 8 }}>Files: {d.files.filter((f) => f.name.endsWith('.svg')).map((f, i) => <span key={f.name}>{i ? ' · ' : ''}<a href={`/sites/${o.id}/${f.name}`} download>{f.name}</a></span>)}</p>}
      {d.doc && <Doc doc={d.doc} />}
      {d.factcheck && (
        <div className="doc">
          {d.factcheck.issues.length ? <ol>{d.factcheck.issues.map((i, n) => <li key={n}><b>{i.claim}</b> {i.problem} <i>Fix:</i> {i.fix}</li>)}</ol> : <p>Nothing to fix.</p>}
          {d.factcheck.verdict && <p className="note">{d.factcheck.verdict}</p>}
        </div>
      )}
      {d.flyers && <div className="flyers">{d.flyers.slice().reverse().map((f) => <Flyer key={f.name} f={f} />)}</div>}
    </div>
  );
}

/** A board job's document: Markdown shown as plain blocks (headings, lists, paragraphs), never as raw HTML. */
function Doc({ doc }: { doc: { title: string; markdown: string } }) {
  // a heading line that runs straight into text is its own block
  const blocks = doc.markdown.replace(/\r/g, '').replace(/^(#{1,3}\s+.*)\n(?!\n)/gm, '$1\n\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const inline = (t: string) => t.split(/(\*\*[^*]+\*\*)/g).map((x, i) => (x.startsWith('**') && x.endsWith('**') ? <b key={i}>{x.slice(2, -2)}</b> : x));
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([doc.markdown], { type: 'text/markdown' })); a.download = `${doc.title.replace(/[^\w]+/g, '-').toLowerCase()}.md`; a.click(); };
  return (
    <div className="doc">
      {blocks.map((b, i) => {
        const h = b.match(/^(#{1,3})\s+(.*)$/);
        if (h && !b.includes('\n')) return h[1].length === 1 ? <h2 key={i}>{h[2]}</h2> : <h3 key={i}>{h[2]}</h3>;
        const lines = b.split('\n');
        if (lines.length > 1 && lines.every((l) => l.trim().startsWith('|'))) {
          const rows = lines.filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l)).map(cells);
          return <div key={i} style={{ overflowX: 'auto' }}><table className="leads"><thead><tr>{rows[0].map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, n) => <td key={n}>{inline(c)}</td>)}</tr>)}</tbody></table></div>;
        }
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) return <ul key={i}>{lines.map((l, k) => <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>)}</ul>;
        return <p key={i}>{lines.map((l, k) => <span key={k}>{k > 0 && <br />}{inline(l.replace(/^#{1,3}\s+/, ''))}</span>)}</p>;
      })}
      <p style={{ marginTop: 12 }}><button className="ghost" onClick={download}>Download as Markdown</button></p>
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
