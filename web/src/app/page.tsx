import Link from 'next/link';
import { HeroReplay } from '@/components/HeroReplay';
import { Proof } from '@/components/Proof';
import { ServicesGrid } from '@/components/ServicesGrid';
import { TeamRow } from '@/components/TeamRow';

const STEPS = [
  { n: '01', t: 'Quoted up front', d: 'The CFO prices your job from what similar jobs really cost, and sets a hard budget.' },
  { n: '02', t: 'Researched twice', d: 'One agent reads the databases, another reads the web. Neither sees the other’s answer.' },
  { n: '03', t: 'Checked at the source', d: 'Disagreements get a tiebreak. Every claim must match its source, or it doesn’t ship.' },
];

export default function Home() {
  return (
    <main>
      <section className="wrap hero">
        <span className="eyebrow">an ai research agency</span>
        <h1 className="display">
          Research you can <span className="tc-records">actually</span> <span className="tc-field">trust</span>.
        </h1>
        <p className="lede">Every answer is checked from two angles before it reaches you.</p>
        <div className="hero-ctas">
          <Link className="btn" href="#services">
            Hire the team
          </Link>
          <Link className="btn ghost" href="/jobs">
            See live jobs
          </Link>
        </div>
      </section>

      <section className="wrap" style={{ maxWidth: 1080 }}>
        <HeroReplay />
      </section>

      <section className="section-lg">
        <div className="wrap">
          <div className="steps">
            {STEPS.map((s) => (
              <div key={s.n}>
                <div className="step-n">{s.n}</div>
                <h3 className="step-t">{s.t}</h3>
                <p className="step-d">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="services" className="section-lg band" style={{ scrollMarginTop: 70 }}>
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">services</span>
            <h2 className="display">What can we find out for you?</h2>
          </div>
          <ServicesGrid />
        </div>
      </section>

      <section id="team" className="section-lg" style={{ scrollMarginTop: 70 }}>
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">the team</span>
            <h2 className="display">Seven agents. Each one checks the last.</h2>
          </div>
          <TeamRow />
        </div>
      </section>

      <section id="proof" className="section-lg band" style={{ scrollMarginTop: 70 }}>
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">proof</span>
            <h2 className="display">Tested like a product.</h2>
            <p className="lede">The same jobs, with known right answers, run on every version of the team.</p>
          </div>
          <Proof />
        </div>
      </section>

      <section className="section-lg">
        <div className="wrap" style={{ textAlign: 'center' }}>
          <h2 className="display">What do you need to know?</h2>
          <p className="lede" style={{ marginInline: 'auto' }}>
            Quoted before it starts. Capped while it runs. Checked before it ships.
          </p>
          <div style={{ marginTop: 28 }}>
            <Link className="btn" href="#services">
              Hire the team
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
