// The services Parallax sells. Each has a list price, the roles on its team (its lots come from these),
// the form a customer fills in, and run(): the steps the lots' winners carry out.
import type { Job } from '../job.ts';
import { NEAR } from '../near/chain.ts';
import type { Role } from '../wallets.ts';
import { findCustomers } from './find-customers.ts';
import { board } from './board.ts';
import { factcheck } from './factcheck.ts';
import { flyers } from './flyers.ts';
import { website } from './website.ts';
import { jingle } from './jingle.ts';
import { storybook } from './storybook.ts';
import { brandkit } from './brandkit.ts';
import { deck } from './deck.ts';
import { comic } from './comic.ts';
import { arcade } from './arcade.ts';

export type Field = { key: string; label: string; hint?: string; long?: boolean; optional?: boolean };
export type Check = { pass: boolean; notes: string[] };
export type Delivery = {
  summary: string;
  check: Check;
  // What the customer gets; each service fills in its own part.
  leads?: unknown[]; email?: { subject: string; body: string }; csv?: string;
  site?: { path: string; html: string };
  files?: { name: string; data?: Buffer; sha256?: string }[]; // saved beside the page, served at /sites/<id>/<name>
  audio?: { path: string; sha256: string; seconds: number; wav?: Buffer; score?: unknown };
  flyers?: { name: string; svg: string; w: number; h: number }[];
  doc?: { title: string; markdown: string };
  factcheck?: { issues: { claim: string; problem: string; fix: string }[]; verdict: string };
};
export type Service = {
  id: string;
  name: string;
  blurb: string;
  priceUsd: number;
  team: Role[];
  /** The service's own split into lots, when the usual one (research, writing, visuals, checking) doesn't fit. */
  groups?: { title: string; roles: Role[] }[];
  fields: Field[];
  example: Record<string, string>;
  run(job: Job, input: Record<string, string>): Promise<Delivery>;
};

export const SERVICES: Service[] = [findCustomers, website, flyers, jingle, storybook, brandkit, deck, comic, arcade];
// Mainnet runs on a small float, so its list prices are lower; testnet keeps the full ones.
const MAINNET_PRICES: Record<string, number> = { flyers: 1, 'find-customers': 2, website: 3, jingle: 2, storybook: 2, 'brand-kit': 2, 'pitch-deck': 3, comic: 2, arcade: 2 };
if (NEAR?.network === 'mainnet') for (const s of SERVICES) s.priceUsd = MAINNET_PRICES[s.id] ?? s.priceUsd;
// Board jobs and sub-jobs aren't on the menu: they come in through the bank, priced by whoever posts them.
export const findService = (id: string) => SERVICES.find((s) => s.id === id) ?? [board, factcheck].find((s) => s.id === id);
