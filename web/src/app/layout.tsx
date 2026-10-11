import type { Metadata } from 'next';
import { Bricolage_Grotesque, Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import { NavShadow } from '@/components/NavShadow';
import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display', weight: ['600', '700', '800'] });

export const metadata: Metadata = {
  title: 'Parallax: the research agency that checks its work',
  description: 'Hire a team of AI agents for sales, market and due-diligence research. Every answer is checked from two angles before it reaches you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <header className="nav" id="top-nav">
          <NavShadow />
          <div className="wrap">
            <Link href="/" className="brand">
              <Mark size={28} />
              Parallax
            </Link>
            <nav>
              <Link href="/#services">Services</Link>
              <Link href="/#team">The team</Link>
              <Link href="/#proof">Proof</Link>
              <Link href="/jobs">Jobs</Link>
              <Link href="/books">Books</Link>
            </nav>
            <div className="right">
              <a className="btn ghost sm" href="https://github.com/neromtoobad/parallax" target="_blank" rel="noreferrer">
                GitHub
              </a>
              <Link className="btn sm" href="/#services">
                Hire the team
              </Link>
            </div>
          </div>
        </header>
        {children}
        <footer style={{ borderTop: '1px solid var(--line)', marginTop: 40 }}>
          <div className="wrap" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', padding: '28px 24px 40px', fontSize: 13.5 }}>
            <div className="brand" style={{ fontSize: 16 }}>
              <Mark size={22} /> Parallax
            </div>
            <div className="muted">Every answer, checked from two angles. Built for neatHack 2026 · traced with neatlogs · checkpoints on Entire · planned with cfo.ai</div>
          </div>
        </footer>
      </body>
    </html>
  );
}
