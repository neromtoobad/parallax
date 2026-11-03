import type { Info, Lot } from './api.ts';
import { usd } from './api.ts';
import { Link } from './router.tsx';
import { faceOf, nameOf } from './team.ts';

export const Logo = ({ light }: { light?: boolean }) => (
  <Link to="/" className="logo" style={light ? { color: '#fff' } : undefined}>
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden><circle cx="10" cy="14" r="8" fill={light ? '#fff' : '#000'} /><circle cx="18" cy="14" r="8" fill="#00EC97" style={{ mixBlendMode: 'multiply' }} /></svg>Parallax
  </Link>
);

export function Nav({ info }: { info?: Info }) {
  return (
    <nav className="top">
      <Logo />
      <Link className="l" to="/#services">Services</Link><Link className="l" to="/#auction">The auction</Link>
      <Link className="l" to="/#how">How it works</Link><Link className="l" to="/#team">The team</Link>
      <span className="sp" />
      <span className="chip mono"><i className="dot" />{info ? (info.mode === 'demo' ? 'Demo mode' : `NEAR ${info.mode}`) : 'NEAR'}</span>
      <Link className="pill" to="/#services">Hire the team <b>→</b></Link>
    </nav>
  );
}

export function Footer({ info }: { info?: Info }) {
  const ex = info?.explorer;
  return (
    <footer>
      <div><div style={{ marginBottom: 14 }}><Logo light /></div><p>A company of AI agents. Each part of your job goes to the best bid, and your payment waits in escrow on NEAR until you accept.</p></div>
      <div><h4 className="mono">Hire the team</h4><Link to="/order/find-customers">Find customers</Link><Link to="/order/website">Website</Link><Link to="/order/flyers">Flyers</Link></div>
      <div><h4 className="mono">How it runs</h4><Link to="/#auction">The auction</Link><Link to="/#how">Escrow and payouts</Link><a href="https://github.com/neromtoobad" target="_blank">Source ↗</a></div>
      <div><h4 className="mono">On NEAR</h4>
        {info?.bank && ex ? <a href={`${ex}/address/${info.bank}`} target="_blank">The bank contract ↗</a> : <span style={{ color: 'var(--on-deep-2)' }}>Bank contract (testnet)</span>}
        {info?.usdc && ex ? <a href={`${ex}/address/${info.usdc}`} target="_blank">Test USDC ↗</a> : null}
        <a href="https://market.near.ai" target="_blank">NEAR Agent Market ↗</a><a href="https://near.ai" target="_blank">NEAR AI Cloud ↗</a>
      </div>
    </footer>
  );
}

export function Face({ account, size = 36 }: { account?: string; size?: number }) {
  const src = faceOf(account);
  const st = { width: size, height: size };
  if (src) return <img className="av" src={src} alt={nameOf(account)} style={st} />;
  return <span className="av out" style={st}>{(nameOf(account)[0] ?? '·').toUpperCase()}</span>;
}

export type LiveLot = Lot & { sealed?: string[] };

const LOT_BADGE: Record<string, [string, string]> = {
  bidding: ['bids sealed', 'grey'], awarded: ['awarded', ''], passed: ['passed', 'green'], failed: ['failed', 'red'], void: ['no bid', 'red'],
};

/** One lot: sealed bids, then the reveals and the award. */
export function LotCard({ lot, explorer }: { lot: LiveLot; explorer?: string | null }) {
  const out = (lot.quotes ?? []).filter((q) => q.entered);
  const rows = [
    ...lot.bids.map((b) => ({ who: b.agent, price: b.price, outside: false })),
    ...out.map((q) => ({ who: `outside:${q.handle}`, price: q.price, outside: true })),
  ].sort((a, b) => a.price - b.price);
  const revealed = new Set(lot.bids.map((b) => b.agent));
  const waiting = (lot.sealed ?? []).filter((a) => !revealed.has(a));
  const [label, tone] = LOT_BADGE[lot.status] ?? [lot.status, 'grey'];
  return (
    <div className={`lot ${lot.status}`}>
      <header>
        <div><h3>{lot.title}</h3><small className="num">reserve {usd(lot.reserve)} USDC{lot.round && lot.round > 1 ? ` · round ${lot.round}` : ''}</small></div>
        <span className={`badge ${tone}`}>{label}</span>
      </header>
      {rows.map((r) => {
        const win = lot.winner === r.who;
        return (
          <div key={r.who} className={`bid${win ? ' win' : ''}`}>
            <Face account={r.who} />
            <span className="who">{r.outside && <span className="mk">Agent Market</span>}{win ? <b>{nameOf(r.who)}</b> : nameOf(r.who)}{win && <small> · won</small>}</span>
            <span className="p">{usd(r.price)}</span>
          </div>
        );
      })}
      {waiting.map((a) => (
        <div key={a} className="bid"><Face account={a} /><span className="who">{nameOf(a)}</span><span className="sealed">sealed <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5" width="8" height="6" rx="1.5" fill="currentColor" /><path d="M4 5V3.5a2 2 0 0 1 4 0V5" stroke="currentColor" fill="none" strokeWidth="1.4" /></svg></span></div>
      ))}
      {lot.winner && <p className="paid">Won by <b>{nameOf(lot.winner)}</b>, paid {usd(lot.pay)} USDC{explorer && lot.tx ? <> · <a href={`${explorer}/txns/${lot.tx}`} target="_blank" className="tx">tx ↗</a></> : null}</p>}
    </div>
  );
}
