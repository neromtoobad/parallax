// The CFO's books for pricing: what each role really spent on recent jobs of a service, and the price
// that keeps the bank's margin. Spend is recorded from each job's receipt when the job is delivered.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import type { ReceiptLine } from '../meter.ts';
import type { Role } from '../wallets.ts';
import { SPEND } from './spend.ts';

type Book = Record<string, { role: Role; usd: number }[][]>; // service -> recent jobs -> lines
const file = () => join(DATA_DIR, 'spend.json');
const KEEP = 20;
let book: Book | undefined;
const load = (): Book => (book ??= existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {});

/** Record a delivered job's spend by role. */
export function recordSpend(service: string, receipt: ReceiptLine[]) {
  const b = load();
  const lines = receipt.filter((r) => !r.dry).map((r) => ({ role: r.agent, usd: r.usd }));
  if (!lines.length) return;
  (b[service] ??= []).push(lines);
  b[service] = b[service].slice(-KEEP);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file(), JSON.stringify(b));
}

/** Per-role spend for a service: the average of recent real jobs once there are three, else the estimate. */
export function spendFor(service: string): Partial<Record<Role, number>> {
  const jobs = load()[service] ?? [];
  if (jobs.length < 3) return SPEND[service] ?? {};
  const sum: Partial<Record<Role, number>> = {};
  for (const j of jobs) for (const l of j) sum[l.role] = (sum[l.role] ?? 0) + l.usd;
  const avg: Partial<Record<Role, number>> = { ...SPEND[service] };
  for (const [r, v] of Object.entries(sum)) avg[r as Role] = Math.round((v! / jobs.length) * 1e6) / 1e6;
  return avg;
}

/**
 * The price for a job: the service's list price, raised if real costs ever eat into the margin the bank
 * requires (min_margin_bps), rounded up to the next 50 cents.
 */
export function priceFor(service: string, listUsd: number, minMarginBps = 2000): number {
  const cost = Object.values(spendFor(service)).reduce((t, v) => t + (v ?? 0), 0);
  const floor = cost / (1 - minMarginBps / 1e4) / 0.95;
  return Math.max(listUsd, Math.ceil(floor * 2) / 2);
}
