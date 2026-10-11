import Link from 'next/link';
import { HeroReplay } from '@/components/HeroReplay';
import { Proof } from '@/components/Proof';
import { ServicesGrid } from '@/components/ServicesGrid';
import { CAST, sprite } from '@/lib/cast';

const TEAM: { id: keyof typeof CAST; line: string }[] = [
  { id: 'lead', line: 'Reads your brief, works out what you actually need to know, and writes the work order.' },
  { id: 'cfo', line: 'Quotes from what similar jobs really cost, sets a hard cap, and stops the job before it goes over.' },
  { id: 'records', line: 'Company and people databases: headcount, funding, founders, who holds which role today.' },
  { id: 'field', line: 'The open web, on its own. Never sees what Records found, and searches again for anything missing.' },
  { id: 'arbiter', line: 'Lines the two angles up. When they disagree, finds a tiebreaker and writes down why.' },
  { id: 'verifier', line: 'Plain code, no opinions. A claim counts only if its quote is really on the page and really says it.' },
  { id: 'writer', line: 'Writes from verified facts only. A line that guesses or invents a number gets sent back.' },
];

const STEPS = [
  { who: 'lead', t: 'You brief the team', d: 'Pick a service, tell us what it’s for. The Lead turns it into a work order.' },
  { who: 'cfo', t: 'The CFO quotes', d: 'A price from real past costs and a hard budget. Nothing runs until you accept.' },
  { who: 'records', t: 'Two angles, separately', d: 'Records reads the databases. Field reads the web. Neither sees the other’s answer.' },
  { who: 'arbiter', t: 'Disagreements get settled', d: 'The Arbiter runs a tiebreak search and picks the stronger source, with a reason.' },
  { who: 'verifier', t: 'Every claim gets checked', d: 'Quotes must be on the page. Numbers must match. Failures fall back or get dropped.' },
  { who: 'writer', t: 'You get the work', d: 'Delivered with sources, checks and the money trail. Crashes resume, never repeat.' },
] as const;

export default function Home() {
  return (
    <main>
      <section className="wrap" style={{ paddingTop: 54, textAlign: 'center' }}>
        <span className="eyebrow">
          <span className="dot" style={{ color: 'var(--records)' }} />
          an ai research agency
          <span className="dot" style={{ color: 'var(--field)' }} />
        </span>
        <h1 className="display" style={{ maxWidth: 980, marginInline: 'auto' }}>
          Research you can <span className="tc-records">actually</span> <span className="tc-field">trust</span>.
        </h1>
        <p className="lede" style={{ marginInline: 'auto' }}>
          Hire a team of AI agents for sales, market and due-diligence research. Two of them look at every question from different angles, and nothing reaches you until it’s been checked at its source.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 28 }}>
          <Link className="btn" href="#services">
            Hire the team
          </Link>
          <Link className="btn ghost" href="/jobs">
            Watch a live job
          </Link>
        </div>
      </section>

      <section className="wrap" style={{ marginTop: 34 }}>
        <HeroReplay />
      </section>

      <section id="services" className="section" style={{ scrollMarginTop: 70 }}>
        <div className="wrap">
          <span className="eyebrow">services</span>
          <h2 className="display">Three departments. One standard.</h2>
          <p className="lede">Every job is quoted up front, capped by a hard budget, and checked from two angles before it’s delivered. You pay for verified work.</p>
          <ServicesGrid />
        </div>
      </section>

      <section id="team" className="section band" style={{ scrollMarginTop: 70 }}>
        <div className="wrap">
          <span className="eyebrow">the team</span>
          <h2 className="display">Seven agents. Each one checks the last.</h2>
          <p className="lede">They work out of a small observatory: two telescopes on the same star. That’s the idea. One viewpoint can’t tell you how far away something is. Two can.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14, marginTop: 34 }}>
            {TEAM.map((m) => (
              <div key={m.id} className="card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style={{ background: `color-mix(in srgb, ${CAST[m.id].color} 10%, #fff)`, height: 190, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingTop: 12 }}>
                  <img src={sprite(m.id, 'talk')} alt={CAST[m.id].name} style={{ height: 176, width: 'auto' }} />
                </div>
                <div style={{ padding: '14px 14px 16px' }}>
                  <div style={{ fontWeight: 700, color: CAST[m.id].color }}>{CAST[m.id].name}</div>
                  <div style={{ fontSize: 13.5, color: 'var(--ink-2)', marginTop: 4 }}>{m.line}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <span className="eyebrow">how a job runs</span>
          <h2 className="display">From brief to verified, without you watching.</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginTop: 30 }}>
            {STEPS.map((s, i) => (
              <div key={s.t} className="card" style={{ padding: 18, position: 'relative', overflow: 'hidden', minHeight: 210 }}>
                <span className="mono muted">0{i + 1}</span>
                <h3 style={{ marginTop: 6 }}>{s.t}</h3>
                <p style={{ fontSize: 13.5, color: 'var(--ink-2)', margin: '6px 0 0', paddingRight: 56 }}>{s.d}</p>
                <img src={sprite(s.who, 'idle')} alt="" style={{ position: 'absolute', right: 6, bottom: 0, height: 120, width: 'auto', opacity: 0.95 }} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="proof" className="section band" style={{ scrollMarginTop: 70 }}>
        <div className="wrap">
          <span className="eyebrow">proof, not promises</span>
          <h2 className="display">We test the team like a product.</h2>
          <p className="lede">The same fixed jobs run on every version of the team, with known right answers, every run traced end to end. Here’s what changed as we fixed what the traces showed us.</p>
          <Proof />
        </div>
      </section>

      <section className="section">
        <div className="wrap" style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: 'clamp(4px, 2vw, 22px)', height: 'clamp(150px, 24vw, 280px)' }}>
            {TEAM.map((m) => (
              <img key={m.id} src={sprite(m.id, 'done')} alt={CAST[m.id].name} style={{ height: '100%', width: 'auto' }} />
            ))}
          </div>
          <h2 className="display" style={{ marginTop: 10 }}>What do you need to know?</h2>
          <p className="lede" style={{ marginInline: 'auto' }}>Quoted before it starts. Capped while it runs. Checked before it ships.</p>
          <div style={{ marginTop: 22 }}>
            <Link className="btn" href="#services">
              Hire the team
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
