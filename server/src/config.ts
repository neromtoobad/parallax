// Settings read once at start. Demo mode (PARALLAX_DRY=1) runs everything in memory: no chain, no model
// bills, canned model output. Without it the server needs deployments/near-<net>.json and the agents' keys.
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Stand-in model answers while the chain is real: for testnet runs before there's a NEAR AI key. */
export const CANNED = process.env.PARALLAX_CANNED_AI === '1';
export const DRY = process.env.PARALLAX_DRY === '1';
export const PORT = Number(process.env.PORT ?? 8790);
export const DATA_DIR = process.env.PARALLAX_DATA ?? join(import.meta.dirname, '..', 'data');
/** Other networks' data beside this one (/data/testnet next to /data/mainnet), read only for records the proof checks
 * against hashes and signatures on chain: attestation reports, crew specs and reviews, board briefs and screens. */
export const ARCHIVE_DIRS: string[] = process.env.PARALLAX_DATA_ARCHIVE !== undefined
  ? process.env.PARALLAX_DATA_ARCHIVE.split(',').filter(Boolean)
  : (() => { try { const up = dirname(DATA_DIR); return readdirSync(up, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== basename(DATA_DIR) && ['testnet', 'mainnet'].includes(d.name)).map((d) => join(up, d.name)).filter(existsSync); } catch { return []; } })();
/** Where the built site lives, served by this process in production. */
export const WEB_DIR = process.env.PARALLAX_WEB ?? join(import.meta.dirname, '..', '..', 'web', 'dist');
/** The public origin, for links in deliveries (a built website's address). */
export const ORIGIN = process.env.PARALLAX_ORIGIN ?? `http://localhost:${PORT}`;
/** The model every agent calls on NEAR AI Cloud, and the one for pictures. */
export const MODEL = process.env.PARALLAX_MODEL ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017'; // the TEE build
export const IMAGE_MODEL = process.env.PARALLAX_IMAGE_MODEL ?? 'black-forest-labs/FLUX.2-klein-4B';
