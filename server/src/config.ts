// Settings read once at start. Demo mode (PARALLAX_DRY=1) runs everything in memory: no chain, no model
// bills, canned model output. Without it the server needs deployments/near-<net>.json and the agents' keys.
import { join } from 'node:path';

export const DRY = process.env.PARALLAX_DRY === '1';
export const PORT = Number(process.env.PORT ?? 8790);
export const DATA_DIR = process.env.PARALLAX_DATA ?? join(import.meta.dirname, '..', 'data');
/** Where the built site lives, served by this process in production. */
export const WEB_DIR = process.env.PARALLAX_WEB ?? join(import.meta.dirname, '..', '..', 'web', 'dist');
/** The public origin, for links in deliveries (a built website's address). */
export const ORIGIN = process.env.PARALLAX_ORIGIN ?? `http://localhost:${PORT}`;
/** The model every agent calls on NEAR AI Cloud, and the one for pictures. */
export const MODEL = process.env.PARALLAX_MODEL ?? 'deepseek/deepseek-v4.1-flash';
export const IMAGE_MODEL = process.env.PARALLAX_IMAGE_MODEL ?? 'black-forest-labs/FLUX.2-klein-4B';
