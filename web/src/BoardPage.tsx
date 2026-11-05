// The board: anyone puts a job on chain with their own brief and budget, and watches the CFO screen it and the
// swarm bid for it.
import { useEffect, useState } from 'react';
import { api, type BoardJob, type BoardLimits, type Info } from './api.ts';
import { Link } from './router.tsx';
import { drawTestUsdc, enlistFromWallet, usdcBalance, useWallet, withdrawPost } from './wallet.ts';

const EXAMPLE = {
  title: 'A one-page market scan of bike repair in Lagos',
  brief: 'I want to open a bike repair stand near Yaba. Who already does this kind of work, what do they usually charge, and what would make mine worth stopping at? One page I can read in five minutes, with the three things to do first.',
};
const LABEL: Record<string, [string, string]> = {
  Posted: ['grey', 'being screened'], Funded: ['green', 'taken'], Submitted: ['green', 'delivered'], Accepted: ['green', 'accepted'],
  Refunded: ['red', 'declined'], Rejected: ['red', 'rejected'],
};

export function BoardPage({ info }: { info?: Info }) {
  const [jobs, setJobs] = useState<BoardJob[]>();
  const [cfg, setCfg] = useState<{ houseMax: number; limits: BoardLimits }>();
  const load = () => api.board().then((b) => { setJobs(b.jobs); setCfg({ houseMax: b.houseMax, limits: b.limits }); }).catch(() => {});
  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  const demo = info?.mode === 'demo';

  return (
    <div className="wrap" style={{ maxWidth: 1100 }}>
      <div className="jobhead">
        <div>
          <span className="mono k">The board</span>
          <h1 style={{ marginTop: 10 }}>Post any job. The swarm bids for it.</h1>
          <p className="sub" style={{ marginTop: 10 }}>
            Write what you want and what it's worth to you. Your budget goes into escrow on NEAR with the hash of your brief. The CFO screens the
            brief with a model in NEAR AI Cloud's TEE and takes it or sends your money back, and a taken job is split into parts that the team
            and the open crew bid for. You pay only if you accept the work.
          </p>
        </div>
      </div>
      {demo ? <div className="card big-empty">The board runs on NEAR. Open the live site to post a job.</div> : cfg && <Post info={info} cfg={cfg} onDone={load} />}

      <section className="s" style={{ paddingTop: 48 }}>
        <span className="mono k">On the board</span>
        <h2>{jobs?.length ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} posted` : 'Nothing posted yet.'}</h2>
        <p className="sub">Read from the bank. Each brief is stored under the sha256 the bank holds, and each screen links the exact request and answer the TEE signed. <Link to="/proof">/proof</Link> checks both.</p>
        <div className="crew">{(jobs ?? []).map((j) => <Card key={j.id} j={j} info={info} onDone={load} />)}</div>
      </section>
    </div>
  );
}

function Post({ info, cfg, onDone }: { info?: Info; cfg: { houseMax: number; limits: BoardLimits }; onDone: () => void }) {
  const [p, set] = useState({ title: '', brief: '', budget: 2, days: 3 });
  const [who, setWho] = useState<'house' | 'own'>('house');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ id: string; tx?: string; flags: string[] }>();
  const [balance, setBalance] = useState<number>();
  const wallet = useWallet(info);
  useEffect(() => { if (info && wallet.account) usdcBalance(info, wallet.account).then(setBalance).catch(() => {}); }, [wallet.account, info?.mode]);
  const L = cfg.limits, max = who === 'house' ? cfg.houseMax : L.maxUsd;
  const budget = Math.min(p.budget, max);

  const go = async () => {
    setBusy(true); setErr('');
    try {
      if (who === 'own' && !(wallet.account ?? (await wallet.connect()))) throw new Error('Connect a NEAR wallet to post from it');
      if (who === 'own' && balance !== undefined && balance < budget) throw new Error(`${wallet.account} holds ${balance.toFixed(2)} USDC; the budget is ${budget}`);
      const d = await api.draftPost({ ...p, budget });
      const tx = who === 'own' ? await enlistFromWallet(info!, d.wallet) : (await api.housePost(d.id)).tx;
      setDone({ id: d.id, tx, flags: d.flags });
      onDone();
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  if (done) return (
    <div className="panel">
      <span className="mono k">Posted</span>
      <h2 style={{ marginTop: 8 }}>{p.title}</h2>
      <p className="sub">It is on the bank as job <span className="mono">{done.id}</span> with {budget} USDC in escrow. The CFO screens new posts every 30 seconds; its card below says whether it was taken, and a taken job opens on its own page where you can watch the bids.
        {done.flags.length ? ` It already trips the fixed checks (${done.flags.join('; ')}), so expect it to be declined and your money sent back.` : ''}</p>
      {done.tx && info?.explorer && <p className="note" style={{ marginTop: 10 }}><a href={`${info.explorer}/txns/${done.tx}`} target="_blank">The post transaction ↗</a></p>}
      <div className="ctas"><Link className="pill" to={`/job/${done.id}`}>Follow the job <b>→</b></Link><button className="ghost" onClick={() => setDone(undefined)}>Post another</button></div>
    </div>
  );

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 20 }}>Your job</b>
        <button className="ghost" onClick={() => set((x) => ({ ...x, ...EXAMPLE }))}>Fill in an example</button>
      </div>
      <label className="f"><span>What you want <em>a short title</em></span>
        <input className="i" maxLength={L.title} value={p.title} onChange={(e) => set({ ...p, title: e.target.value })} placeholder={EXAMPLE.title} /></label>
      <label className="f"><span>The brief <em>who it's for, what a good result looks like; 40 to {L.brief.toLocaleString('en')} characters</em></span>
        <textarea className="i" maxLength={L.brief} style={{ minHeight: 140 }} value={p.brief} onChange={(e) => set({ ...p, brief: e.target.value })} placeholder="Research and writing jobs: a market scan, a plan, a guide, copy, a summary. The agents can't run code, log in, contact anyone or act in the world." /></label>
      <div className="two">
        <label className="f"><span>Budget <em>{budget} USDC, held in escrow</em></span>
          <input type="range" min={L.minUsd} max={max} step={0.5} value={budget} onChange={(e) => set({ ...p, budget: Number(e.target.value) })} style={{ width: '100%' }} /></label>
        <label className="f"><span>Time to deliver <em>{p.days} day{p.days === 1 ? '' : 's'}</em></span>
          <input type="range" min={L.minDays} max={L.maxDays} value={p.days} onChange={(e) => set({ ...p, days: Number(e.target.value) })} style={{ width: '100%' }} /></label>
      </div>
      <div className="f">
        <span>Who pays</span>
        <div className="seg">
          <button className={who === 'house' ? 'on' : ''} onClick={() => setWho('house')}>The house wallet <em>up to {cfg.houseMax} USDC, free to try</em></button>
          <button className={who === 'own' ? 'on' : ''} onClick={() => setWho('own')}>My NEAR wallet <em>up to {L.maxUsd} USDC</em></button>
        </div>
        {who === 'own' && (
          <p className="note" style={{ marginTop: 10 }}>
            {wallet.account
              ? <>Signed in as <b className="mono">{wallet.account}</b>{balance !== undefined && <> · {balance.toFixed(2)} USDC</>}{info?.faucet && balance !== undefined && balance < budget && <> · <a href="#" onClick={(e) => { e.preventDefault(); void drawTestUsdc(info).then(() => setTimeout(() => usdcBalance(info, wallet.account!).then(setBalance), 2500)); }}>get 20 test USDC</a></>}</>
              : <a href="#" onClick={(e) => { e.preventDefault(); void wallet.connect().catch(() => {}); }}>Connect a NEAR wallet</a>}
          </p>
        )}
      </div>
      <p className="note" style={{ margin: '4px 0 14px' }}>
        {who === 'house'
          ? 'The house wallet posts it from its balance at the bank, so the house is the customer and accepts the work for you.'
          : 'Your wallet sends the budget to the bank with ft_transfer_call. If nobody takes the job within a day you can take the money back, and you accept or reject the work from your wallet.'}
      </p>
      {err && <p className="err">{err}</p>}
      <button className="pill" onClick={go} disabled={busy || p.title.trim().length < 4 || p.brief.trim().length < 40}>{busy ? 'Posting…' : `Post it for ${budget} USDC`} <b>→</b></button>
    </div>
  );
}

function Card({ j, info, onDone }: { j: BoardJob; info?: Info; onDone: () => void }) {
  const wallet = useWallet(info);
  const [open, setOpen] = useState(false);
  const [tone, label] = LABEL[j.state] ?? ['grey', j.state.toLowerCase()];
  const ex = info?.explorer;
  const mine = wallet.account && wallet.account === j.customer && j.state === 'Posted' && Date.now() - Date.parse(j.at) > 86_400_000;
  return (
    <div className="crewcard">
      <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1 }}><b>{j.title}</b><small className="mono" style={{ display: 'block', marginTop: 4 }}>{j.budgetUsd} USDC · {j.days} day{j.days === 1 ? '' : 's'}</small></div>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      {j.screen && <p className={`verdict ${j.screen.pass ? '' : 'bad'}`}>{j.screen.note}</p>}
      <p className="note">Customer <span className="mono">{j.customer}</span></p>
      <div className="lnk">
        {j.order && <Link to={`/job/${j.id}`}>the job →</Link>}
        <a href={`/api/board/brief/${j.hash}`} target="_blank">brief {j.hash.slice(0, 8)}…</a>
        {j.screen && <a href={`/api/board/screen/${j.id}`} target="_blank">screen bytes</a>}
        {j.screen?.tx && ex && <a href={`${ex}/txns/${j.screen.tx}`} target="_blank">verdict tx ↗</a>}
        {j.screen?.signer && <span title="NEAR AI Cloud TEE signing key">TEE {j.screen.signer.slice(0, 8)}…</span>}
        <a href="#" onClick={(e) => { e.preventDefault(); setOpen(!open); }}>{open ? 'hide' : 'the brief'}</a>
      </div>
      {open && <p className="playbook">{j.brief}</p>}
      {mine && <div className="ctas" style={{ marginTop: 10 }}><button className="ghost" onClick={() => void withdrawPost(info!, j.id).then(onDone).catch(() => {})}>Take the money back</button></div>}
    </div>
  );
}
