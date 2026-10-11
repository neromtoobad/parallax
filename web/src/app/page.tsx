import { Hire } from '@/components/Hire';
import { Lenses } from '@/components/Lenses';

const STEPS = [
  { who: 'Lead', color: 'var(--ink)', text: 'Reads your brief and turns it into a work order: which company, what you need it for, what you’ll want to know.' },
  { who: 'CFO', color: '#2f8a4c', text: 'Quotes from what past jobs really cost, measured call by call, and sets a hard budget the team can’t go past.' },
  { who: 'Records', color: 'var(--records)', text: 'Pulls the structured view: company database, people database, funding, headcount.' },
  { who: 'Field', color: 'var(--field)', text: 'Reads the open web on its own, without seeing what Records found, and searches again for anything still missing.' },
  { who: 'Arbiter', color: '#7a4fc2', text: 'Lines the two angles up. Where they disagree it goes looking for a tiebreaker and records why it chose.' },
  { who: 'Verifier', color: '#0f7c80', text: 'Throws out any web claim whose quote isn’t on the page or doesn’t say what was claimed. Rejects drafts that guess.' },
];

export default function Home() {
  return (
    <main>
      <section className="wrap" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1fr)', gap: 40, alignItems: 'center', padding: '64px 24px 40px' }}>
        <div>
          <div className="eyebrow">An AI research agency</div>
          <h1>
            Every answer,
            <br />
            checked from <span className="records">two</span> <span className="field">angles</span>.
          </h1>
          <p className="lede">
            One source can’t tell you it’s wrong. Two independent ones that disagree can. Parallax’s agents research your question from the company database and from the open web separately, settle every disagreement, and check each claim at its source before anything reaches you.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 26 }}>
            <a className="btn" href="#hire">
              Hire the team
            </a>
            <a className="btn ghost" href="/books">
              See the books
            </a>
          </div>
        </div>
        <Lenses />
      </section>

      <section className="wrap" style={{ padding: '30px 24px' }}>
        <div className="eyebrow">How a job runs</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginTop: 14 }}>
          {STEPS.map((s, i) => (
            <div key={s.who} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="mono muted">0{i + 1}</span>
                <span style={{ fontWeight: 640, color: s.color }}>{s.who}</span>
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{s.text}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="hire" className="wrap" style={{ padding: '50px 24px 20px', scrollMarginTop: 70 }}>
        <div className="eyebrow">Hire the team</div>
        <h2 style={{ margin: '8px 0 18px' }}>What do you need to know?</h2>
        <Hire />
      </section>
    </main>
  );
}
