import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Parallax: research checked from two angles',
  description: 'An AI agency that checks every answer from two angles before it reaches you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="nav">
          <div className="wrap">
            <Link href="/" className="brand">
              <Mark size={26} />
              Parallax
            </Link>
            <nav>
              <Link href="/#hire">Hire</Link>
              <Link href="/jobs">Jobs</Link>
              <Link href="/books">Books</Link>
              <a href="https://github.com/neromtoobad/parallax" target="_blank" rel="noreferrer">
                GitHub
              </a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="wrap muted" style={{ padding: '60px 24px 40px', fontSize: 13 }}>
          Parallax · built for neatHack 2026 · traced with neatlogs · checkpoints on Entire
        </footer>
      </body>
    </html>
  );
}
