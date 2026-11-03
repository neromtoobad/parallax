// A small history router: the path, and links that don't reload the page.
import { useEffect, useState, type AnchorHTMLAttributes } from 'react';

export function go(to: string) {
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (!to.includes('#')) window.scrollTo(0, 0);
}
export function usePath() {
  const [p, set] = useState(location.pathname);
  useEffect(() => { const f = () => set(location.pathname); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  return p;
}
export function Link({ to, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={to} {...rest} onClick={(e) => {
    if (e.metaKey || e.ctrlKey || to.startsWith('http') || to.startsWith('#')) return;
    e.preventDefault(); go(to);
  }} />;
}
