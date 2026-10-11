'use client';

import { useEffect } from 'react';

/** Adds a hairline under the sticky nav once the page scrolls. */
export function NavShadow() {
  useEffect(() => {
    const nav = document.getElementById('top-nav');
    const on = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return null;
}
