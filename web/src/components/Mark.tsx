/** Two overlapping lenses: the database view and the web view. Where they overlap is what we deliver. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="12" cy="16" r="9" fill="var(--records)" opacity="0.9" />
      <circle cx="20" cy="16" r="9" fill="var(--field)" opacity="0.9" style={{ mixBlendMode: 'multiply' }} />
      <path d="M16 8.6a9 9 0 0 1 0 14.8a9 9 0 0 1 0-14.8z" fill="var(--ink)" />
    </svg>
  );
}
