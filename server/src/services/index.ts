// The services Parallax sells. Each has a list price, the roles on its team (its lots come from these),
// the form a customer fills in, and run(): the steps the lots' winners carry out.
import type { Job } from '../job.ts';
import { NEAR } from '../near/chain.ts';
import type { Role } from '../wallets.ts';
import { findCustomers } from './find-customers.ts';
import { flyers } from './flyers.ts';
import { website } from './website.ts';

export type Field = { key: string; label: string; hint?: string; long?: boolean; optional?: boolean };
export type Check = { pass: boolean; notes: string[] };
export type Delivery = {
  summary: string;
  check: Check;
  // What the customer gets; each service fills in its own part.
  leads?: unknown[]; email?: { subject: string; body: string }; csv?: string;
  site?: { path: string; html: string };
  flyers?: { name: string; svg: string; w: number; h: number }[];
};
export type Service = {
  id: string;
  name: string;
  blurb: string;
  priceUsd: number;
  team: Role[];
  fields: Field[];
  example: Record<string, string>;
  run(job: Job, input: Record<string, string>): Promise<Delivery>;
};

export const SERVICES: Service[] = [findCustomers, website, flyers];
// Mainnet runs on a small float, so its list prices are lower; testnet keeps the full ones.
const MAINNET_PRICES: Record<string, number> = { flyers: 1, 'find-customers': 2, website: 3 };
if (NEAR?.network === 'mainnet') for (const s of SERVICES) s.priceUsd = MAINNET_PRICES[s.id] ?? s.priceUsd;
export const findService = (id: string) => SERVICES.find((s) => s.id === id);
