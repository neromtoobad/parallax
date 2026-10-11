'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, usd, type JobView } from '@/lib/api';

const SERVICES = [
  {
    id: 'company-brief',
    name: 'Company brief',
    blurb: 'Before a sales call, pitch or partnership chat: who they are, how big, who runs it, how they’re funded, and what to do with that.',
    unit: 'per brief',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'Linear, or linear.app' },
      { name: 'purpose', label: 'What is it for?', placeholder: 'Sales call with their Head of Ops next week' },
    ],
  },
  {
    id: 'lead-list',
    name: 'Lead list',
    blurb: 'Companies that fit your ideal customer, each with the right person to contact. A lead ships only if both angles hold up.',
    unit: 'per list',
    fields: [
      { name: 'icp', label: 'Who are you looking for?', placeholder: 'Fintech startups in Nigeria' },
      { name: 'titles', label: 'Who should we contact?', placeholder: 'CEO or Head of Partnerships' },
      { name: 'count', label: 'How many leads?', placeholder: '5', type: 'number' },
    ],
  },
] as const;

export function Hire() {
  const router = useRouter();
  const [svc, setSvc] = useState<(typeof SERVICES)[number]['id']>('company-brief');
  const [form, setForm] = useState<Record<string, string>>({});
  const [quoted, setQuoted] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const s = SERVICES.find((x) => x.id === svc)!;

  async function getQuote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      setQuoted(await api<JobView>('/quote', { method: 'POST', body: JSON.stringify({ service: svc, input: form }) }));
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

  return (
    <div className="grid2" style={{ alignItems: 'start' }}>
      <form className="card pad" onSubmit={getQuote}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          {SERVICES.map((x) => (
            <button
              type="button"
              key={x.id}
              className={x.id === svc ? 'btn' : 'btn ghost'}
              style={{ height: 34, fontSize: 13.5 }}
              onClick={() => {
                setSvc(x.id);
                setQuoted(null);
                setForm({});
              }}
            >
              {x.name}
            </button>
          ))}
        </div>
        <p className="muted" style={{ margin: '12px 0 4px', fontSize: 14 }}>
          {s.blurb}
        </p>
        {s.fields.map((f) => (
          <div key={f.name}>
            <label className="lbl" htmlFor={f.name}>
              {f.label}
            </label>
            <input
              id={f.name}
              className="input"
              type={'type' in f ? f.type : 'text'}
              min={1}
              max={25}
              placeholder={f.placeholder}
              value={form[f.name] ?? ''}
              onChange={(e) => {
                setForm({ ...form, [f.name]: e.target.value });
                setQuoted(null);
              }}
              required={f.name !== 'count'}
            />
          </div>
        ))}
        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn" disabled={busy}>
            {busy && !quoted ? 'Asking the CFO…' : 'Get a quote'}
          </button>
          {err && <span style={{ color: 'var(--conflict)', fontSize: 13 }}>{err}</span>}
        </div>
      </form>

      <div className={`card pad ${quoted ? 'fade-in' : ''}`} style={{ minHeight: 260, display: 'flex', flexDirection: 'column' }}>
        <div className="eyebrow">The CFO’s quote</div>
        {!quoted ? (
          <p className="muted" style={{ marginTop: 14 }}>
            Fill in the brief. The CFO prices it from what similar jobs actually cost, measured call by call, and sets a hard budget the team can’t go past.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '14px 0 4px' }}>
              <span style={{ fontSize: 44, fontWeight: 650, letterSpacing: '-0.03em' }}>{usd(quoted.quote?.priceUsd)}</span>
              <span className="muted">{s.unit}</span>
            </div>
            <table className="t" style={{ marginTop: 8 }}>
              <tbody>
                <tr>
                  <td className="muted">Expected cost to us</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {usd(quoted.quote?.estCostUsd, 4)}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Hard budget (the team stops here)</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {usd(quoted.quote?.budgetUsd, 4)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 13, margin: '12px 0 18px' }}>
              Based on {quoted.quote?.basis}.
            </p>
            <div style={{ marginTop: 'auto' }}>
              <button className="btn" onClick={accept} disabled={busy}>
                {busy ? 'Starting…' : 'Accept and start'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
