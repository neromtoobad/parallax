import { useEffect, useState } from 'react';
import { Face } from './parts.tsx';
import { load, NET, units, verify, type Check, type Proof, type Raw, type Round } from './proof.ts';
import { nameOf } from './team.ts';

const host = (u: string) => new URL(u).host;

export function ProofPage() {
  const [raw, setRaw] = useState<Raw>();
  const [proof, setProof] = useState<Proof>();
  const [tamper, setTamper] = useState(false);
  const [status, setStatus] = useState('Starting');
  const [err, setErr] = useState('');
  const run = () => { setRaw(undefined); setProof(undefined); setErr(''); load(setStatus).then(setRaw).catch((e) => setErr(e.message)); };
  useEffect(run, []);
  useEffect(() => { if (raw) verify(raw, tamper).then(setProof); }, [raw, tamper]);

  const all = proof?.passed === proof?.total;
  return (
    <div className="wrap proof">
      <div className="jobhead">
        <div>
          <span className="mono k">Proof · NEAR testnet</span>
          <h1 style={{ marginTop: 10 }}>Don't take our word for it.</h1>
          <p className="sub" style={{ marginTop: 14 }}>
            None of these checks ask our server anything. Your browser reads the bank contract and every transaction it
            took part in straight from NEAR, rebuilds each auction from the bids the agents revealed, and checks the
            winner, the pay and every USDC payout against what the contract recorded.
          </p>
        </div>
      </div>

      <div className={`acc tally${proof && !all ? ' bad' : ''}`}>
        <div>
          {proof ? (
            <>
              <b className="big num">{proof.passed} of {proof.total} checks pass</b>
              <p>From {proof.txs} transactions to <a href={`${NET.explorer}/address/${NET.bank}`} target="_blank">{NET.bank} ↗</a>{tamper ? '. One revealed bid has been changed by $0.000001 on this page, and the check on it fails.' : ''}</p>
            </>
          ) : err ? <><b className="big">Couldn't reach NEAR</b><p>{err}</p></> : <><b className="big">Checking…</b><p>{status}</p></>}
        </div>
        <div className="row">
          <button className="ghost light" disabled={!raw} onClick={() => setTamper(!tamper)}>{tamper ? 'Undo the change' : 'Tamper with one bid'}</button>
          <button className="ghost light" onClick={run}>Run again</button>
        </div>
      </div>

      <div className="how">
        <div><span className="mono k">1</span><b>Sealed bids</b><p>Each agent sent sha256(lot:agent:price:salt) before bidding closed. Its reveal must hash to exactly that.</p></div>
        <div><span className="mono k">2</span><b>The award</b><p>Best price for quality wins, quality coming from each agent's record. A team winner is paid the second-best price.</p></div>
        <div><span className="mono k">3</span><b>Payouts</b><p>On acceptance, each winner's pay, the margin and the contributors' share must match the USDC that moved.</p></div>
        <div><span className="mono k">4</span><b>Records</b><p>Every agent's record is replayed from its passes, fails and unrevealed bids, then compared with the contract.</p></div>
      </div>

      <div className="card src">
        <span><b>Contract state</b>{host(NET.rpc)}</span>
        <span><b>Transactions</b>{host(NET.index)}</span>
        <span><b>Hashing</b>your browser's WebCrypto</span>
        <span><b>In a terminal</b><code>node web/scripts/verify.ts</code></span>
      </div>

      {proof && (
        <>
          <Checks list={proof.checks} />
          {proof.jobs.map((j) => {
            const mine = [...j.rounds.flatMap((r) => r.checks), ...j.checks];
            const ok = mine.filter((c) => c.ok).length;
            return (
              <section key={j.job.id} className="pjob">
                <header>
                  <div><span className="mono k">Job {j.job.id}</span><h2>{units(j.job.amount)} · {j.outcome}</h2></div>
                  <span className={`badge ${ok === mine.length ? 'green' : 'red'}`}>{ok} of {mine.length} pass</span>
                </header>
                <div className="grid3">{j.rounds.map((r) => <RoundCard key={`${r.lot.id}-${r.n}`} r={r} />)}</div>
                <Checks list={j.checks} />
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function RoundCard({ r }: { r: Round }) {
  const w = r.bids.find((b) => b.win);
  return (
    <div className="lot passed">
      <header>
        <div><h3>{r.lot.title}</h3><small className="num">lot {r.lot.id} · reserve {units(r.lot.reserve)}{r.n > 1 ? ` · round ${r.n}` : ''}</small></div>
        <span className={`badge ${r.checks.every((c) => c.ok) ? 'green' : 'red'}`}>{r.checks.every((c) => c.ok) ? 'checks out' : 'mismatch'}</span>
      </header>
      {r.bids.map((b) => (
        <div key={b.seller} className={`bid${b.win ? ' win' : ''}`}>
          <Face account={b.seller} />
          <span className="who">{b.win ? <b>{nameOf(b.seller)}</b> : nameOf(b.seller)}<small> · {b.outside ? `quality ${b.q}` : `record ${b.rep}`}</small></span>
          <span className="p">{units(b.price)}</span>
        </div>
      ))}
      {w && <p className="paid">{nameOf(w.seller)} paid <b>{units(r.pay)}</b>: {r.payNote}</p>}
      <Checks list={r.checks} />
    </div>
  );
}

function Checks({ list }: { list: Check[] }) {
  if (!list.length) return null;
  return (
    <ul className="checks">
      {list.map((c, i) => (
        <li key={i} className={c.ok ? '' : 'bad'}>
          <i>{c.ok ? '✓' : '✗'}</i>
          <span><b>{c.what}</b> {c.detail}{c.tx ? <> <a href={`${NET.explorer}/txns/${c.tx}`} target="_blank">tx ↗</a></> : null}</span>
        </li>
      ))}
    </ul>
  );
}
