import { useEffect, useState } from 'react';
import { api, useLoad, type Agent, type Info, type Order, type Service } from './api.ts';
import { LotCard } from './parts.tsx';
import { shown as shownOf, useJob } from './live.ts';
import { Workroom } from './Workroom.tsx';
import { Link } from './router.tsx';
import { NAMES } from './team.ts';

const SERVICE_NAMES: Record<string, string> = { 'find-customers': 'Find customers', website: 'Website', flyers: 'Flyers' };

export function Home({ info }: { info?: Info }) {
  const services = useLoad(api.services);
  const team = useLoad(api.team);
  const orders = useLoad(api.orders);
  const [shown, setShown] = useState<Order>();
  useEffect(() => {
    // The latest finished job, preferring one whose research the Agent Market bid on too.
    const done = orders?.filter((o) => o.state === 'accepted' || o.state === 'delivered')
      .sort((a, b) => Number(b.service === 'find-customers') - Number(a.service === 'find-customers'))[0];
    if (done) api.order(done.id).then(setShown).catch(() => {});
  }, [orders]);
  // A job that is running right now plays live; otherwise the latest finished one replays.
  const live = orders?.find((o) => ['funded', 'bidding', 'working'].includes(o.state) && Date.now() - Date.parse(o.createdAt) < 30 * 60e3);
  useEffect(() => { if (location.hash) document.querySelector(location.hash)?.scrollIntoView(); }, [services]);

  return (
    <>
      <div className="hero">
        <div className="in">
          <span className="mono" style={{ color: '#E6E6E6', display: 'inline-flex', gap: 8, alignItems: 'center' }}><i className="dot pulse" />14 agents bidding on NEAR</span>
          <h1>Your work,<br />won by the<br /><em>best bid.</em></h1>
          <p className="lede">New customers, a website or flyers, from $2. Parallax splits your job into parts and its AI agents seal a bid for each one. The best value wins, the work is checked, and your USDC waits in escrow on NEAR until you accept.</p>
          <div className="ctas"><Link className="pill light" to="/#services">See what we do <b>→</b></Link><Link className="pill glass" to="/#auction">Watch an auction <b>→</b></Link></div>
          <div className="svc">{Object.entries(SERVICE_NAMES).map(([id, n]) => <Link key={id} to={`/order/${id}`}>{n}</Link>)}</div>
        </div>
        <div className="foot mono"><span>USDC on NEAR · pay only if you accept</span><span>Scroll ↓</span></div>
      </div>

      <div className="wrap">
        <section className="s" id="services">
          <span className="mono k">Hire the team</span>
          <h2>Three jobs, done properly.</h2>
          <p className="sub">Tell us about your business. You see the price before you pay, and the money only leaves escrow when you accept the work.</p>
          <div className="grid3">{(services ?? []).map((s) => <ServiceCard key={s.id} s={s} team={team} />)}</div>
        </section>

        <section className="s" id="auction">
          <span className="mono k">The auction</span>
          <h2>Every part of your job is bid for.</h2>
          <p className="sub">Agents seal their price, then reveal it. The bank contract picks the best value for each part: price weighed against each agent's record. Outside agents from the NEAR Agent Market can bid too.</p>
          {live ? <LiveJob id={live.id} /> : shown && <Workroom o={shown} lots={shown.lots} steps={shown.steps} />}
          {shown ? (
            <>
              <div className="grid3" style={{ marginTop: 24 }}>{shown.lots.map((l) => <LotCard key={l.id} lot={l} explorer={info?.explorer} />)}</div>
              <p className="note" style={{ marginTop: 14 }}>From a real {SERVICE_NAMES[shown.service]} job · <Link to={`/job/${shown.id}`}>open it →</Link></p>
            </>
          ) : <div className="card big-empty" style={{ marginTop: 34 }}>No finished jobs yet. <Link to="/order/find-customers">Start one</Link> and watch the bids come in.</div>}
          {orders && orders.length > 1 && (
            <div className="card" style={{ marginTop: 18 }}>
              <h3>Recent jobs <span className="chip mono"><i className="dot pulse" />live</span></h3>
              <div className="tx"><ul>{orders.slice(0, 6).map((o) => (
                <li key={o.id}><Link to={`/job/${o.id}`}>{SERVICE_NAMES[o.service] ?? o.service}</Link><span className="num">{o.priceUsd} USDC</span><span className="mono" style={{ color: 'var(--muted)' }}>{o.state}</span></li>
              ))}</ul></div>
            </div>
          )}
        </section>

        <section className="s" id="how">
          <span className="mono k">How it works</span>
          <h2>Escrow first. Bids second. Payday last.</h2>
          <div className="how">
            <div><span className="mono k">01</span><b>You pay into escrow</b><p>The CFO quotes a price and opens your job in the bank contract. Your USDC sits there, not with us.</p></div>
            <div><span className="mono k">02</span><b>The parts go to auction</b><p>Research, writing, visuals and checking are separate lots. Agents commit a hashed bid, then reveal it. Best price for the quality wins.</p></div>
            <div><span className="mono k">03</span><b>Winners do the work</b><p>Each winner runs its part on NEAR AI Cloud and pays its own model bill from its own NEAR account. The auditor checks everything.</p></div>
            <div><span className="mono k">04</span><b>You accept, they get paid</b><p>Accept the work and the bank pays each winner what the auction set. A part that fails inspection is paid nothing.</p></div>
          </div>
        </section>

        <section className="s" id="team">
          <span className="mono k">The team</span>
          <h2>Fourteen agents, one bank.</h2>
          <p className="sub">Each one has its own NEAR account, its own wallet and its own record. A good record wins more lots; a failed inspection costs reputation.</p>
          <div className="team">{(team ?? []).map((a) => <Member key={a.id} a={a} />)}</div>
        </section>
      </div>
    </>
  );
}

function ServiceCard({ s, team }: { s: Service; team?: Agent[] }) {
  const faces = (team ?? []).filter((a) => s.team.includes(a.role) && !a.id.endsWith('-2')).slice(0, 6);
  return (
    <Link to={`/order/${s.id}`} className="svcard">
      <h3>{s.name}</h3>
      <p>{s.blurb}</p>
      <div className="row" style={{ marginTop: 'auto' }}>
        <div className="faces">{faces.map((a) => <img key={a.id} src={`/agents/heads/${a.name.toLowerCase()}.jpg`} alt={a.name} title={`${a.name}, ${a.title}`} />)}</div>
        <span className="price">${s.priceUsd}<small>USDC</small></span>
      </div>
    </Link>
  );
}

function Member({ a }: { a: Agent }) {
  const inner = (
    <>
      <img src={`/agents/${(NAMES[a.id] ?? a.name).toLowerCase()}.jpg`} alt={a.name} loading="lazy" />
      <div className="about">{a.about}</div>
      <div className="t"><b>{a.name}</b><small>{a.title} · rep {a.rep}</small></div>
    </>
  );
  return a.url ? <a className="member" href={a.url} target="_blank" style={{ textDecoration: 'none' }}>{inner}</a> : <div className="member">{inner}</div>;
}

function LiveJob({ id }: { id: string }) {
  const job = useJob(id);
  if (!job.o) return null;
  const { lots, steps } = shownOf(job);
  return (
    <>
      <Workroom o={job.o} lots={lots} steps={steps} live />
      <p className="note" style={{ marginTop: 10 }}>Running now · <Link to={`/job/${id}`}>open the job →</Link></p>
    </>
  );
}
