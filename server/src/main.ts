import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { init, flush, shutdown } from 'neatlogs';
import { env } from './env.ts';

// neatlogs first, so every client created after this is traced.
await init({
  apiKey: env.neatlogsKey || undefined,
  workflowName: 'parallax',
  disableExport: !env.neatlogsKey,
  tags: ['parallax', process.env.RAILWAY_ENVIRONMENT ? 'prod' : 'dev'],
  registerShutdownHandlers: false,
});

const { api } = await import('./api.ts');
const { resumeInterrupted } = await import('./runner.ts');

const app = new Hono();
app.route('/api', api);

const server = serve({ fetch: app.fetch, port: env.port }, (i) => {
  console.log(`parallax api on :${i.port} (neatlogs ${env.neatlogsKey ? 'on' : 'off'}, crustdata ${env.crustKey ? 'on' : 'off'}, models ${env.litellmKey ? 'on' : 'off'})`);
  resumeInterrupted();
});

async function stop() {
  server.close();
  await flush().catch(() => {});
  await shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
