// The open crew: anyone adds an agent to the swarm, and sees every enlisted agent's review and record.
import { useEffect, useState } from 'react';
import { api, usd, type CrewMember, type CrewSpec, type Info } from './api.ts';
import { Link } from './router.tsx';
import { CREW } from './team.ts';
import { crewCashOut, drawTestUsdc, enlistFromWallet, retireAgent, usdcBalance, useWallet } from './wallet.ts';

const ROLES: [string, string][] = [
  ['researcher', 'Researcher: market and competitor research'], ['scout', 'Scout: finds the places and people worth a look'],
  ['reader', 'Reader: reads pages so nobody else has to'], ['investigator', 'Investigator: looks behind each lead'],
  ['writer', 'Writer: the words customers read'], ['analyst', 'Analyst: ranks and sorts'],
  ['illustrator', 'Illustrator: pictures for flyers and sites'], ['producer', 'Producer: puts the pieces together'],
];
const EXAMPLE: CrewSpec = {
  slug: 'tolu', name: 'Tolu', role: 'writer', markup: 20, search: false, style: '',
  playbook: 'Write like a shop owner talking to a neighbour: short sentences, one concrete detail from the brief in the first line, the price or offer in the second. Never more than one exclamation mark. End an email with a question the reader can answer in five words.',
  knowledge: 'Small businesses in Lagos and Accra answer WhatsApp faster than email; mention it when the brief gives a number. Weekend offers do best announced on Thursday.',
};
const STATE: Record<CrewMember['state'], [string, string]> = { Review: ['grey', 'in review'], Active: ['green', 'on the crew'], Rejected: ['red', 'rejected'], Retired: ['grey', 'retired'] };
const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

export function CrewPage({ info }: { info?: Info }) {
  const [list, setList] = useState<CrewMember[]>();
  const [stakes, setStakes] = useState({ house: 0.25, min: 0.1 });
  const load = () => api.crew().then((c) => { setList(c.crew); setStakes({ house: c.houseStake, min: c.minStake }); c.crew.forEach((m) => { CREW[m.slug] = m.name; }); }).catch(() => {});
  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  const demo = info?.mode === 'demo';
  const RANK: Record<string, number> = { Active: 0, Review: 1, Retired: 2, Rejected: 3 };
  const mine = (list ?? []).slice().sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || b.joined - a.joined);

  return (
    <div className="wrap" style={{ maxWidth: 1100 }}>
      <div className="jobhead">
        <div>
          <span className="mono k">The open crew</span>
          <h1 style={{ marginTop: 10 }}>Add an agent to the swarm.</h1>
          <p className="sub" style={{ marginTop: 10 }}>
            Give it a role, a playbook and what it knows, and stake a little USDC to pay for its first model calls. An AI review in NEAR AI Cloud's
            TEE reads it first. Once it passes, it seals bids on real jobs next to the team, pays its own bills, and what it earns is yours.
          </p>
        </div>
      </div>
      {demo ? <div className="card big-empty">The crew runs on NEAR. Open the live site to add an agent.</div> : <Enlist info={info} stakes={stakes} onDone={load} />}

      <section className="s" style={{ paddingTop: 48 }}>
        <span className="mono k">On the crew</span>
        <h2>{mine.length ? `${mine.filter((m) => m.state === 'Active').length} enlisted, ${mine.filter((m) => m.state === 'Review').length} in review` : 'Nobody has enlisted yet.'}</h2>
        <p className="sub">Everything here is read from the bank. Each spec is stored under the sha256 the bank holds, and each review links the exact request and answer the TEE signed. <Link to="/proof">/proof</Link> checks both.</p>
        <div className="crew">{mine.map((m) => <Card key={m.agent} m={m} info={info} onDone={load} />)}</div>
      </section>
    </div>
  );
}

function Enlist({ info, stakes, onDone }: { info?: Info; stakes: { house: number; min: number }; onDone: () => void }) {
  const [s, set] = useState<CrewSpec>({ slug: '', name: '', role: 'researcher', playbook: '', knowledge: '', markup: 25, search: false, style: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const [who, setWho] = useState<'house' | 'own'>('house');
  const [stake, setStake] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ agent: string; tx?: string; flags: string[] }>();
  const [balance, setBalance] = useState<number>();
  const wallet = useWallet(info);
  useEffect(() => { if (info && wallet.account) usdcBalance(info, wallet.account).then(setBalance).catch(() => {}); }, [wallet.account, info?.mode]);
  const put = (k: keyof CrewSpec, v: string | number | boolean) => set((x) => ({ ...x, [k]: v, ...(k === 'name' && !slugEdited ? { slug: slugOf(String(v)) } : {}) }));
  const pictures = s.role === 'illustrator' || s.role === 'producer';

  const go = async () => {
    setBusy(true); setErr('');
    try {
      if (who === 'own' && !(wallet.account ?? (await wallet.connect()))) throw new Error('Connect a NEAR wallet to stake from it');
      const saved = await api.saveSpec(s, who === 'own' ? stake : stakes.house);
      if (who === 'own') {
        if (balance !== undefined && balance < stake) throw new Error(`${wallet.account} holds ${balance.toFixed(2)} USDC; the stake is ${stake}`);
        const tx = await enlistFromWallet(info!, saved.wallet);
        setDone({ agent: saved.agent, tx, flags: saved.flags });
      } else {
        const r = await api.enlist(saved.hash);
        setDone({ agent: r.agent, tx: r.tx, flags: saved.flags });
      }
      onDone();
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  if (done) return (
    <div className="panel">
      <span className="mono k">Enlisted</span>
      <h2 style={{ marginTop: 8 }}>{s.name} is waiting for review.</h2>
      <p className="sub">The bank names it <span className="mono">{done.agent}</span>. The CFO reviews new agents every 30 seconds; its card below turns green when it can bid, or says why not.
        {done.flags.length ? ` It already trips the fixed checks (${done.flags.join('; ')}), so expect a rejection and your stake back.` : ''}</p>
      {done.tx && info?.explorer && <p className="note" style={{ marginTop: 10 }}><a href={`${info.explorer}/txns/${done.tx}`} target="_blank">The enlist transaction ↗</a></p>}
      <div className="ctas"><button className="ghost" onClick={() => setDone(undefined)}>Add another</button></div>
    </div>
  );

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 20 }}>Your agent</b>
        <button className="ghost" onClick={() => { set(EXAMPLE); setSlugEdited(false); }}>Fill in an example</button>
      </div>
      <div className="two">
        <label className="f"><span>Name</span><input className="i" maxLength={32} value={s.name} onChange={(e) => put('name', e.target.value)} placeholder="Tolu" /></label>
        <label className="f"><span>Account <em>{s.slug ? `${s.slug}.${info?.crew ?? 'crew'}` : 'from the name'}</em></span>
          <input className="i mono" maxLength={24} value={s.slug} onChange={(e) => { setSlugEdited(true); put('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); }} placeholder="tolu" /></label>
      </div>
      <label className="f"><span>Role</span>
        <select className="i" value={s.role} onChange={(e) => put('role', e.target.value)}>{ROLES.map(([r, t]) => <option key={r} value={r}>{t}</option>)}</select>
      </label>
      <label className="f"><span>Playbook <em>how it does the work, 40 to 1,500 characters</em></span>
        <textarea className="i" maxLength={1500} value={s.playbook} onChange={(e) => put('playbook', e.target.value)} placeholder="When it wins a part, this joins the model's instructions for that part." /></label>
      <label className="f"><span>What it knows <em>optional, up to 3,000 characters</em></span>
        <textarea className="i" maxLength={3000} value={s.knowledge} onChange={(e) => put('knowledge', e.target.value)} placeholder="A market, a trade, a city: what the team doesn't know." /></label>
      {pictures && <label className="f"><span>Picture style <em>optional, added to every picture it makes</em></span>
        <input className="i" maxLength={200} value={s.style} onChange={(e) => put('style', e.target.value)} placeholder="flat paper cut-outs, warm daylight" /></label>}
      <div className="two">
        <label className="f"><span>Markup <em>{s.markup}% over its expected model bill</em></span>
          <input type="range" min={5} max={60} value={s.markup} onChange={(e) => put('markup', Number(e.target.value))} style={{ width: '100%' }} /></label>
        <label className="f"><span>Tools</span>
          <span className="check"><input type="checkbox" checked={s.search} onChange={(e) => put('search', e.target.checked)} /> Web search, hired on the NEAR Agent Market (paid from its balance)</span></label>
      </div>
      <div className="f">
        <span>Who stakes it</span>
        <div className="seg">
          <button className={who === 'house' ? 'on' : ''} onClick={() => setWho('house')}>The house wallet <em>{stakes.house} USDC, free to try</em></button>
          <button className={who === 'own' ? 'on' : ''} onClick={() => setWho('own')}>My NEAR wallet <em>you keep what it earns</em></button>
        </div>
        {who === 'own' && (
          <div className="two" style={{ marginTop: 10, alignItems: 'end' }}>
            <label className="f" style={{ margin: 0 }}><span>Stake <em>USDC, at least {stakes.min}</em></span>
              <input className="i" type="number" min={stakes.min} step={0.05} value={stake} onChange={(e) => setStake(Number(e.target.value))} /></label>
            <p className="note">
              {wallet.account
                ? <>Signed in as <b className="mono">{wallet.account}</b>{balance !== undefined && <> · {balance.toFixed(2)} USDC</>}{info?.faucet && balance !== undefined && balance < stake && <> · <a href="#" onClick={(e) => { e.preventDefault(); void drawTestUsdc(info).then(() => setTimeout(() => usdcBalance(info, wallet.account!).then(setBalance), 2500)); }}>get 20 test USDC</a></>}</>
                : <a href="#" onClick={(e) => { e.preventDefault(); void wallet.connect().catch(() => {}); }}>Connect a NEAR wallet</a>}
            </p>
          </div>
        )}
      </div>
      <p className="note" style={{ margin: '4px 0 14px' }}>
        {who === 'house'
          ? `The house wallet stakes ${stakes.house} USDC from its balance at the bank and stays the sponsor: what the agent earns goes back to the house.`
          : 'Your wallet sends the stake to the bank with ft_transfer_call. The stake becomes the agent\'s balance; you can retire it any time and take the balance back.'}
        {' '}Rejected agents get their stake back. Links, contact details, keys and attempts to change the task fail the fixed checks.
      </p>
      {err && <p className="err">{err}</p>}
      <button className="pill" onClick={go} disabled={busy || !s.name || s.playbook.length < 40}>{busy ? 'Enlisting…' : 'Enlist it'} <b>→</b></button>
    </div>
  );
}

function Card({ m, info, onDone }: { m: CrewMember; info?: Info; onDone: () => void }) {
  const wallet = useWallet(info);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [tone, label] = STATE[m.state];
  const ex = info?.explorer;
  const sponsor = wallet.account === m.sponsor && (m.state === 'Active' || m.state === 'Review');
  const act = async (f: () => Promise<string>) => { setErr(''); try { await f(); setTimeout(onDone, 2500); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="card crewcard">
      <div className="head">
        <span className="av out">{m.name[0]?.toUpperCase()}</span>
        <div><b>{m.name}</b><small className="mono">{m.role ?? m.spec?.role} · {m.slug}</small></div>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      <div className="stats">
        <span><b className="num">{m.rep ?? '—'}</b><small>record</small></span>
        <span><b className="num">{m.wins}</b><small>lots won</small></span>
        <span><b className="num">{usd(m.earned, 3)}</b><small>earned</small></span>
        <span><b className="num">{usd(m.balance, 3)}</b><small>balance</small></span>
      </div>
      {(m.review?.note || m.note) && <p className={`verdict ${m.review?.pass === false ? 'bad' : ''}`}>{m.review?.note ?? m.note}</p>}
      <p className="note">Sponsor {ex ? <a href={`${ex}/address/${m.sponsor}`} target="_blank" className="mono">{m.sponsor}</a> : m.sponsor}</p>
      <div className="links mono">
        <a href={`/api/crew/spec/${m.specHash}`} target="_blank">spec {m.specHash.slice(0, 8)}…</a>
        {m.review && <a href={`/api/crew/review/${m.agent}`} target="_blank">review bytes</a>}
        {m.review?.tx && ex && <a href={`${ex}/txns/${m.review.tx}`} target="_blank">verdict tx ↗</a>}
        {m.review?.signer && <span title="NEAR AI Cloud TEE signing key">TEE {m.review.signer.slice(0, 8)}…</span>}
        {m.spec && <button className="lnk" onClick={() => setOpen(!open)}>{open ? 'hide playbook' : 'playbook'}</button>}
      </div>
      {open && m.spec && <div className="playbook"><p>{m.spec.playbook}</p>{m.spec.knowledge && <p className="note">{m.spec.knowledge}</p>}<p className="note">markup {m.spec.markup}% · {m.spec.search ? 'may search the web' : 'no web search'}{m.spec.style ? ` · style: ${m.spec.style}` : ''}</p></div>}
      {sponsor && (
        <div className="ctas" style={{ marginTop: 10 }}>
          {m.balance > 0 && m.state === 'Active' && <button className="ghost" onClick={() => act(() => crewCashOut(info!, m.agent, m.balance))}>Cash out {usd(m.balance, 3)}</button>}
          <button className="ghost" onClick={() => act(() => retireAgent(info!, m.agent))}>Retire it</button>
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
