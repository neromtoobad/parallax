/**
 * Hero diagram: two independent views of the same company. Facts both lenses see sit in the overlap;
 * one-sided facts sit in a single lens; a conflict sits on the edge until the Arbiter settles it.
 */
const ROWS = [
  { label: 'Founded', a: '2019', b: '2019', state: 'agree' },
  { label: 'CEO', a: 'K. Saarinen', b: 'K. Saarinen', state: 'agree' },
  { label: 'Employees', a: '291', b: '~250', state: 'conflict' },
  { label: 'Raised', a: '$233M', b: '—', state: 'one' },
] as const;

export function Lenses() {
  return (
    <div className="card" style={{ padding: 22, position: 'relative', overflow: 'hidden' }}>
      <svg viewBox="0 0 420 210" width="100%" style={{ display: 'block' }} aria-hidden>
        <defs>
          <clipPath id="lensA">
            <circle cx="160" cy="105" r="92" />
          </clipPath>
        </defs>
        <circle cx="160" cy="105" r="92" fill="var(--records-soft)" stroke="var(--records)" strokeWidth="1.5" />
        <circle cx="260" cy="105" r="92" fill="var(--field-soft)" stroke="var(--field)" strokeWidth="1.5" fillOpacity="0.85" />
        <circle cx="260" cy="105" r="92" fill="#e3ecdf" clipPath="url(#lensA)" />
        <circle cx="160" cy="105" r="92" fill="none" stroke="var(--records)" strokeWidth="1.5" />
        <text x="96" y="40" fontSize="12" fill="var(--records)" fontFamily="var(--mono)">RECORDS</text>
        <text x="270" y="40" fontSize="12" fill="var(--field)" fontFamily="var(--mono)">FIELD</text>
        <text x="210" y="100" fontSize="13" textAnchor="middle" fill="var(--agree)" fontWeight="600">verified</text>
        <text x="210" y="118" fontSize="11" textAnchor="middle" fill="var(--agree)">by both</text>
        <text x="110" y="112" fontSize="11" textAnchor="middle" fill="var(--records)">database</text>
        <text x="110" y="126" fontSize="11" textAnchor="middle" fill="var(--records)">only</text>
        <text x="312" y="112" fontSize="11" textAnchor="middle" fill="var(--field)">web</text>
        <text x="312" y="126" fontSize="11" textAnchor="middle" fill="var(--field)">only</text>
      </svg>
      <table className="t" style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>Fact</th>
            <th className="records">Records</th>
            <th className="field">Field</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className="mono">{r.a}</td>
              <td className="mono">{r.b}</td>
              <td style={{ textAlign: 'right' }}>
                {r.state === 'agree' && <span className="pill agree">agree</span>}
                {r.state === 'conflict' && <span className="pill conflict">tiebreak</span>}
                {r.state === 'one' && <span className="pill records">one angle</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
