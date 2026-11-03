// Runs one order end to end and prints what happened: node scripts/demo-job.ts [service]
// With PARALLAX_DRY=1 nothing touches the chain or a paid model (map lookups and page reads are real).
import { bus } from '../src/bus.ts';
import { accept, fund, getOrder, quote } from '../src/orders.ts';
import { findService } from '../src/services/index.ts';

const svc = findService(process.argv[2] ?? 'find-customers');
if (!svc) throw new Error('services: find-customers, website, flyers');
bus.on('event', (e: any) => {
  if (e.type === 'lot') console.log('  lot  ', JSON.stringify(e.data));
  if (e.type === 'step') console.log('  step ', `${e.data.agent.padEnd(12)} ${e.data.kind.padEnd(6)} ${e.data.text}`);
  if (e.type === 'order') console.log('order ', e.data.state, e.data.error ?? '');
});
const o = await quote(svc.id, svc.example);
console.log(`quoted ${o.id}: ${svc.name}, ${o.priceUsd} USDC`);
await fund(o, true);
for (let i = 0; i < 600 && !['delivered', 'failed'].includes(getOrder(o.id)!.state); i++) await new Promise((r) => setTimeout(r, 500));
const done = getOrder(o.id)!;
if (done.state === 'delivered') await accept(done);
const d = done.delivery;
console.log('\n', done.state, d?.summary ?? done.error);
if (d?.leads) console.log((d.leads as any[]).map((l) => `  ${l.fit}  ${l.name} — ${l.why}`).join('\n'));
if (d?.site) console.log('  site at', d.site.path);
if (d?.flyers) console.log('  flyers', d.flyers.map((f) => `${f.name} ${Math.round(f.svg.length / 1024)} KB`).join(', '));
console.log('  spent', done.receipt.reduce((t, r) => t + r.usd, 0).toFixed(4), 'USDC on', done.receipt.length, 'calls');
process.exit(0);
