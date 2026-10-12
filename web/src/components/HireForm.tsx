'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, usd, type JobView } from '@/lib/api';
import { DEPTS, serviceById } from '@/lib/catalog';
import { CAST, sprite } from '@/lib/cast';

export function HireForm({ id }: { id: string }) {
  const s = serviceById(id)!;
  const router = useRouter();
  const [form, setForm] = useState<Record<string, string>>({});
  const [quoted, setQuoted] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function getQuote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      // ?tag=demo (or any tag) marks test and demo runs, so the books keep them apart from client revenue.
      const tag = new URLSearchParams(window.location.search).get('tag') || undefined;
      setQuoted(await api<JobView>('/quote', { method: 'POST', body: JSON.stringify({ service: s.id, input: form, tag }) }));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!quoted) return;
    setBusy(true);
    try {
      await api(`/jobs/${quoted.id}/accept`, { method: 'POST' });
      router.push(`/jobs/${quoted.id}`);
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  }

  const q = quoted?.quote;
  return (
    <main className="wrap" style={{ padding: '40px 24px 20px' }}>
      <Link href="/#services" className="muted" style={{ fontSize: 14 }}>
        ← All services
      </Link>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 22, marginTop: 18, alignItems: 'start' }} className="hire-grid">
        <div>
          <span className="eyebrow" style={{ color: DEPTS[s.dept].color }}>
            {DEPTS[s.dept].name} · {s.tagline}
          </span>
          <h1 className="display" style={{ fontSize: 'clamp(36px, 5vw, 58px)', margin: '10px 0 12px' }}>
            {s.name}
          </h1>
          <p className="lede">{s.blurb}</p>
          <form className="card pad" style={{ marginTop: 22 }} onSubmit={getQuote}>
            {s.fields.map((f) => (
              <div key={f.name}>
                <label className="lbl" htmlFor={f.name}>
                  {f.label}
                </label>
                <input
                  id={f.name}
                  className="input"
                  type={f.type ?? 'text'}
                  min={1}
                  max={25}
                  placeholder={f.placeholder}
                  value={form[f.name] ?? ''}
                  onChange={(e) => {
                    setForm({ ...form, [f.name]: e.target.value });
                    setQuoted(null);
                  }}
                  required={!f.optional && f.type !== 'number'}
                />
              </div>
            ))}
            <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy}>
                {busy && !quoted ? 'Asking the CFO…' : quoted ? 'Re-quote' : 'Get a quote'}
              </button>
              {err && <span style={{ color: 'var(--conflict)', fontSize: 13.5 }}>{err}</span>}
            </div>
          </form>
          <div className="grid2" style={{ marginTop: 16 }}>
            <div className="card" style={{ padding: 16, background: 'var(--records-soft)', borderColor: 'transparent', boxShadow: 'none' }}>
              <div style={{ fontWeight: 700, color: 'var(--records)' }}>Records looks at</div>
              <div style={{ fontSize: 14, color: 'var(--ink-2)' }}>{s.angles[0]}</div>
            </div>
            <div className="card" style={{ padding: 16, background: 'var(--field-soft)', borderColor: 'transparent', boxShadow: 'none' }}>
              <div style={{ fontWeight: 700, color: 'var(--field)' }}>Field looks at</div>
              <div style={{ fontSize: 14, color: 'var(--ink-2)' }}>{s.angles[1]}</div>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 13.5, marginTop: 14 }}>
            <b>You get:</b> {s.deliverable}
          </p>
        </div>

        <div className="card" style={{ overflow: 'hidden', position: 'sticky', top: 84 }}>
          <div style={{ background: 'color-mix(in srgb, var(--cfo) 9%, #fff)', display: 'flex', alignItems: 'flex-end', gap: 14, padding: '18px 20px 0', minHeight: 230 }}>
            <img src={sprite('cfo', quoted ? 'talk' : busy ? 'work' : 'idle')} alt="The CFO" style={{ height: 212, width: 'auto' }} />
            <div className="fade-in" key={quoted ? 'q' : 'n'} style={{ alignSelf: 'center', background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: '12px 14px', fontSize: 14.5, boxShadow: 'var(--shadow)', marginBottom: 30 }}>
              <b style={{ color: 'var(--cfo)' }}>{CAST.cfo.name}</b>{' '}
              {quoted ? `That's ${usd(q?.priceUsd)}. I'll cap the team at ${usd(q?.budgetUsd, 2)} of spend, and nobody goes past it.` : busy ? 'Pulling what similar jobs really cost…' : 'Tell me what you need. I price it from what similar jobs really cost, not a rate card.'}
            </div>
          </div>
          <div style={{ padding: 22 }}>
            <div className="eyebrow">The quote</div>
            {!quoted ? (
              <p className="muted" style={{ marginTop: 10 }}>
                No surprises: the price is fixed before anything runs, and the team works inside a hard budget. If it can’t finish inside it, you only pay for what was verified.
              </p>
            ) : (
              <div className="fade-in">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '10px 0 6px' }}>
                  <span style={{ fontFamily: 'var(--display)', fontSize: 52, fontWeight: 700, letterSpacing: '-0.03em' }}>{usd(q?.priceUsd)}</span>
                  <span className="muted">fixed price</span>
                </div>
                <table className="t">
                  <tbody>
                    <tr>
                      <td className="muted">What we expect it to cost us</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {usd(q?.estCostUsd, 3)}
                      </td>
                    </tr>
                    <tr>
                      <td className="muted">Hard budget (the team stops here)</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {usd(q?.budgetUsd, 3)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="muted" style={{ fontSize: 13, margin: '10px 0 18px' }}>
                  Based on {q?.basis}.
                </p>
                <button className="btn" style={{ width: '100%' }} onClick={accept} disabled={busy}>
                  {busy ? 'Starting the team…' : 'Accept and start'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
