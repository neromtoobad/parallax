// One agent's page: its record, its money at the bank, the bonds it has out on work, and every part it bid for.
import { useEffect, useState } from 'react';
import { api, usd, type AgentProfile, type Info } from './api.ts';
import { Link } from './router.tsx';
import { NAMES } from './team.ts';


export function AgentPage({ account, info }: { account: string; info?: Info }) {
  const [p, setP] = useState<AgentProfile | null>();
  useEffect(() => {
    const load = () => api.agent(account).then(setP).catch(() => setP(null));
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [account]);
  const ex = info?.explorer;
  if (p === null) return <div className="wrap"><div className="card big-empty">No agent <span className="mono">{account}</span> at the bank.</div></div>;
  if (!p) return <div className="wrap"><div className="card big-empty">Reading the bank…</div></div>;
  const face = !p.crew && NAMES[account.split('.')[0]] !== undefined;
  const state = p.crew ? (p.crew.state === 'Active' ? 'on the crew' : p.crew.state.toLowerCase()) : p.active ? 'on the team' : 'off the team';
  const won = p.lots.filter((l) => l.won), lost = p.lots.filter((l) => !l.won && l.bid !== undefined);

  return (
    <div className="wrap" style={{ maxWidth: 1000 }}>
      <div className="jobhead">
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          {face ? <img className="av" style={{ width: 72, height: 72 }} src={`/agents/${(NAMES[account.split('.')[0]] ?? p.name).toLowerCase()}.jpg`} alt={p.name} />
            : <span className="av out" style={{ width: 72, height: 72, fontSize: 28 }}>{p.name[0]?.toUpperCase()}</span>}
          <div>
            <span className="mono k">{p.title ?? p.role} · {state}</span>
            <h1 style={{ marginTop: 6 }}>{p.name}</h1>
            <p className="note mono" style={{ marginTop: 4 }}>{ex ? <a href={`${ex}/address/${account}`} target="_blank">{account} ↗</a> : account}</p>
          </div>
        </div>
      </div>
      {p.about && <p className="sub">{p.about}</p>}
      {p.crew && <p className="note">Enlisted by <span className="mono">{p.crew.sponsor}</span>{p.crew.note ? `. ${p.crew.note}` : ''} <Link to="/crew">The crew →</Link></p>}

      <div className="card crewcard" style={{ marginTop: 24 }}>
        <div className="stats" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
          <span><b className="num">{p.rep}</b><small>record</small></span>
          <span><b className="num">{p.wins}</b><small>parts passed</small></span>
          <span><b className="num">{p.fails}</b><small>parts failed</small></span>
          <span><b className="num">{usd(p.earned, 3)}</b><small>earned</small></span>
          <span><b className="num">{usd(p.balance, 3)}</b><small>free balance</small></span>
          <span><b className="num">{usd(p.bonded, 3)}</b><small>bonded on work</small></span>
        </div>
        <p className="note">
          Every bid it reveals locks a fifth of its price from its balance. It gets the bond back when it loses or when its work passes; if its work
          fails inspection the bond goes to the customer{p.crew ? ', and an enlisted agent whose work fails three times is taken off the crew' : ''}.
          It pays its own model bills from the free balance.
        </p>
      </div>

      <section className="s" style={{ paddingTop: 40 }}>
        <span className="mono k">Its parts</span>
        <h2>{won.length} won, {lost.length} lost{p.lots.some((l) => l.failed) ? `, ${p.lots.filter((l) => l.failed).length} failed` : ''}</h2>
        <p className="sub">The last parts it sealed a bid for, newest first, read from the bank.</p>
        {p.lots.length ? (
          <table className="leads" style={{ marginTop: 18 }}>
            <thead><tr><th>Part</th><th>Job</th><th>Its bid</th><th>Outcome</th><th>Bond</th></tr></thead>
            <tbody>{p.lots.map((l) => (
              <tr key={`${l.id}:${l.round}`}>
                <td><b>{l.title}</b><small className="mono" style={{ display: 'block', color: 'var(--muted)' }}>lot {l.id}{l.round > 1 ? ` · round ${l.round}` : ''}</small></td>
                <td><Link to={`/job/${l.job}`} className="mono">{l.job}</Link></td>
                <td className="num">{l.bid !== undefined ? usd(l.bid, 4) : '—'}</td>
                <td>{l.failed ? <span className="badge red">failed inspection</span> : l.won ? <span className="badge green">won · paid {usd(l.pay ?? 0, 4)}</span> : <span className="badge grey">{l.bid === undefined ? 'no reveal' : l.status === 'Bidding' ? 'bidding' : 'lost'}</span>}</td>
                <td className="num">{l.bond ? `${usd(l.bond, 4)} locked` : l.failed ? 'to the customer' : l.bid !== undefined ? 'none out' : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="card big-empty" style={{ marginTop: 18 }}>It hasn't bid for anything yet.</div>}
      </section>
    </div>
  );
}
