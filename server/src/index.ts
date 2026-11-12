// The Parallax server: the API the site uses, a live event stream, the websites the team builds, and
// the built site itself.
import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { relative } from 'node:path';
import { CANNED, DRY, MODEL, PORT, WEB_DIR } from './config.ts';
import { backlog, bus, type Event } from './bus.ts';
import { accept, demoPayer, finishOpenLots, fund, getOrder, listOrders, payFromChain, quote, rejected, resumeDeposits, sitePath, type Order } from './orders.ts';
import { payAssets, submitDeposit } from './oneclick.ts';
import { startTreasury } from './cfo/loop.ts';
import { SERVICES } from './services/index.ts';
import { ROSTER } from './wallets.ts';
import { FEATURES, NEAR, ROOM_MIN, accountUrl, bankRoom, has, view } from './near/chain.ts';
import { registerSearch, searchOn } from './market.ts';
import { accountOf } from './wallets.ts';
import { attestationFile, warmTee } from './tee.ts';
import { HOUSE_MAX, LIMITS, boardView, briefFile, draft, postForVisitor, screenOf } from './board.ts';
import { profile } from './profile.ts';
import { HOUSE_STAKE, MIN_STAKE, agentId, crew, crewView, enlistForVisitor, parseSpec, redFlags, reviewOf, saveSpec, specFile, walletCall } from './crew.ts';

registerSearch();
startTreasury();
resumeDeposits();
void finishOpenLots().catch((e) => console.warn('[finishOpenLots]', String(e?.message ?? e).slice(0, 160)));
void warmTee();
// The crew: keep the roster fresh (lots read enlisted agents' specs from it) and review whoever is waiting.
if (!DRY && NEAR?.crew) {
  const tick = () => import('./crew.ts').then((m) => m.reviewPending()).catch((e) => console.log('crew:', String(e?.message ?? e).slice(0, 120)));
  void crew(true).catch(() => {}).then(tick);
  setInterval(tick, 30_000).unref();
}
// The board: screen every post waiting on the bank, then take it to auction or send its money back.
if (!DRY && NEAR?.house && has('board')) {
  const tick = () => import('./board.ts').then((m) => m.screenPosted()).catch((e) => console.log('board:', String(e?.message ?? e).slice(0, 120)));
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 30_000).unref();
}
const app = new Hono();

/** What the site may see of an order: the brief stays with the customer if the order is private. */
const view_ = (o: Order) => ({ ...o, input: o.private ? undefined : o.input, brief: o.private ? undefined : o.brief });

// The attestation report behind an approved TEE signer, by the sha256 the bank holds for it.
app.get('/api/attestation/:hash', (c) => {
  const raw = attestationFile(c.req.param('hash'));
  if (!raw) return c.json({ error: 'no report with that hash' }, 404);
  return c.body(raw, 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' });
});
// The open crew (RULES.md 28–31).
app.get('/api/board', async (c) => c.json({ houseMax: HOUSE_MAX, limits: LIMITS, jobs: DRY || !has('board') ? [] : await boardView() }));
// A brief's exact text, under the sha256 the bank holds.
app.get('/api/board/brief/:hash', (c) => {
  const t = briefFile(c.req.param('hash'));
  return t === undefined ? c.json({ error: 'no brief with that hash' }, 404) : c.body(t, 200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' });
});
// A screen with the exact request and answer its TEE signature is over.
app.get('/api/board/screen/:id', (c) => {
  const r = screenOf(c.req.param('id'));
  return r ? c.json(r, 200, { 'access-control-allow-origin': '*' }) : c.json({ error: 'not screened yet' }, 404);
});
app.post('/api/board/draft', async (c) => {
  if (DRY || !NEAR?.house) return c.json({ error: 'the board runs on chain only' }, 400);
  if (!has('board')) return c.json({ error: 'This bank has no board.' }, 400);
  if ((await bankRoom()) < ROOM_MIN) return c.json({ error: 'The bank is out of room on chain for new jobs until it is topped up with NEAR. Try again later.' }, 503);
  const d = draft(await c.req.json().catch(() => ({})));
  if (!d.post) return c.json({ error: d.problems.join('; ') }, 400);
  return c.json({ id: d.post.id, hash: d.post.hash, flags: d.flags, wallet: d.wallet, budget: d.post.budgetUsd });
});
// No wallet: the house wallet posts a visitor's job from its balance, a few a day.
const posted = { day: '', total: 0, byIp: new Map<string, number>() };
app.post('/api/board/post', async (c) => {
  if (!has('board')) return c.json({ error: 'This bank has no board.' }, 400);
  const b = await c.req.json().catch(() => ({}));
  const day = new Date().toISOString().slice(0, 10);
  if (posted.day !== day) Object.assign(posted, { day, total: 0, byIp: new Map() });
  const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  if (posted.total >= 6 || (posted.byIp.get(ip) ?? 0) >= 2) return c.json({ error: 'The house has posted all the jobs it can today. Post from your own wallet, or try tomorrow.' }, 429);
  try {
    const tx = await postForVisitor(String(b.id ?? ''));
    posted.total++; posted.byIp.set(ip, (posted.byIp.get(ip) ?? 0) + 1);
    return c.json({ tx, id: b.id });
  } catch (e: any) { return c.json({ error: String(e?.message ?? e).slice(0, 200) }, 400); }
});
app.get('/api/crew', async (c) => c.json({ operator: NEAR?.crew ?? null, houseStake: HOUSE_STAKE, minStake: MIN_STAKE, crew: await crewView() }));
app.get('/api/crew/spec/:hash', (c) => {
  const raw = specFile(c.req.param('hash'));
  if (!raw) return c.json({ error: 'no spec with that hash' }, 404);
  return c.body(raw, 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' });
});
// A review with the exact request and answer bytes its TEE signature is over.
app.get('/api/crew/review/:agent', (c) => {
  const r = reviewOf(c.req.param('agent'));
  return r ? c.json(r, 200, { 'access-control-allow-origin': '*' }) : c.json({ error: 'not reviewed yet' }, 404);
});
// Check and store a spec; returns its hash, the agent's name on chain, and the wallet call that enlists it.
app.post('/api/crew/spec', async (c) => {
  if (DRY || !NEAR?.crew) return c.json({ error: 'the crew runs on chain only' }, 400);
  if ((await bankRoom()) < ROOM_MIN) return c.json({ error: 'The bank is out of room on chain for new agents until it is topped up with NEAR. Try again later.' }, 503);
  const { spec, problems } = parseSpec(await c.req.json().catch(() => ({})));
  if (!spec) return c.json({ error: problems.join('; ') }, 400);
  const taken = (await crew().catch(() => [])).some((m) => m.agent === agentId(spec.slug));
  if (taken) return c.json({ error: 'that name is taken' }, 400);
  const hash = saveSpec(spec);
  const stake = Math.max(MIN_STAKE, Number(new URL(c.req.url).searchParams.get('stake') ?? 0.25));
  return c.json({ hash, agent: agentId(spec.slug), flags: redFlags(spec), wallet: walletCall(spec, hash, stake), stake });
});
// No wallet: the house wallet stakes the agent from its balance, a few a day.
const enlisted = { day: '', total: 0, byIp: new Map<string, number>() };
app.post('/api/crew/enlist', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const raw = specFile(String(b.hash ?? ''));
  if (!raw) return c.json({ error: 'save the spec first' }, 400);
  const day = new Date().toISOString().slice(0, 10);
  if (enlisted.day !== day) Object.assign(enlisted, { day, total: 0, byIp: new Map() });
  const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  if (enlisted.total >= 10 || (enlisted.byIp.get(ip) ?? 0) >= 2) return c.json({ error: 'The house has staked all the agents it can today. Enlist from your own wallet, or try tomorrow.' }, 429);
  try {
    const tx = await enlistForVisitor(JSON.parse(raw), String(b.hash));
    enlisted.total++; enlisted.byIp.set(ip, (enlisted.byIp.get(ip) ?? 0) + 1);
    return c.json({ tx, agent: agentId(JSON.parse(raw).slug) });
  } catch (e: any) { return c.json({ error: String(e?.message ?? e).slice(0, 200) }, 400); }
});
app.get('/api/info', (c) => c.json({
  mode: DRY ? 'demo' : NEAR?.network, model: MODEL, bank: NEAR?.bank ?? null, explorer: NEAR?.explorer ?? null,
  usdc: NEAR?.usdc ?? null, search: searchOn(), canned: DRY || CANNED, house: DRY ? null : demoPayer() || null,
  faucet: !!NEAR?.usdcFaucet, crew: NEAR?.crew ?? null, board: !DRY && !!NEAR?.house && has('board'),
  features: FEATURES.filter(has),
}));
app.get('/api/agent/:account', async (c) => {
  const account = c.req.param('account');
  if (!/^[a-z0-9._-]{2,64}$/.test(account)) return c.json({ error: 'not an account' }, 400);
  const p = await profile(account).catch(() => undefined);
  return p ? c.json(p) : c.json({ error: 'no such agent at the bank' }, 404);
});
app.get('/api/services', (c) => c.json(SERVICES.map(({ run, ...s }) => s)));
app.get('/api/team', async (c) => {
  const onChain = NEAR ? await view<[string, { role: string; active: boolean; rep: number; delivered?: number; failed?: number }][]>(NEAR.bank, 'list_agents').catch(() => []) : [];
  const rec = new Map(onChain);
  return c.json(ROSTER.map((a) => {
    const account = accountOf(a.id), r = rec.get(account);
    return { ...a, account, url: NEAR ? accountUrl(account) : null, rep: r?.rep ?? 500, active: r?.active ?? true };
  }));
});
app.get('/api/orders', (c) => c.json(listOrders(30).filter((o) => !o.private).map((o) => ({
  id: o.id, service: o.service, state: o.state, priceUsd: o.priceUsd, createdAt: o.createdAt,
  lots: o.lots.map((l) => ({ title: l.title, winner: l.winner, pay: l.pay, bids: l.bids.length + (l.quotes?.filter((q) => q.entered).length ?? 0), status: l.status })),
}))));
app.get('/api/orders/:id', (c) => {
  const o = getOrder(c.req.param('id'));
  return o ? c.json(view_(o)) : c.json({ error: 'not found' }, 404);
});
app.post('/api/orders', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  try {
    const o = await quote(String(b.service ?? ''), b.input ?? {}, b.customer, !!b.private);
    return c.json(view_(o));
  } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 400); }
});
// The demo wallet pays for the visitor, and every paid job runs model calls, so the demo wallet takes a few
// jobs a day per visitor and a cap for the whole site (PARALLAX_DAY_PER_IP, PARALLAX_DAY_TOTAL).
const PER_IP = Number(process.env.PARALLAX_DAY_PER_IP ?? (DRY ? 20 : 4));
const TOTAL = Number(process.env.PARALLAX_DAY_TOTAL ?? (DRY ? 300 : 40));
const paidToday = { day: '', total: 0, byIp: new Map<string, number>() };
function allowPaid(ip: string): string | null {
  const day = new Date().toISOString().slice(0, 10);
  if (paidToday.day !== day) Object.assign(paidToday, { day, total: 0, byIp: new Map() });
  if (paidToday.total >= TOTAL) return 'The demo wallet has paid for all the jobs it can today. Try again tomorrow.';
  if ((paidToday.byIp.get(ip) ?? 0) >= PER_IP) return `The demo wallet pays for ${PER_IP} jobs a day per visitor. Try again tomorrow.`;
  paidToday.total++;
  paidToday.byIp.set(ip, (paidToday.byIp.get(ip) ?? 0) + 1);
  return null;
}
app.post('/api/orders/:id/pay', async (c) => {
  const o = getOrder(c.req.param('id'));
  if (!o) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const demoWallet = b.wallet !== 'own';
  if (demoWallet && o.state === 'quoted') {
    const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
    const no = allowPaid(ip);
    if (no) return c.json({ error: no }, 429);
  }
  try { return c.json(view_(await fund(o, demoWallet))); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 400); }
});
// Pay from another chain (NEAR Intents, mainnet only): the tokens on offer, then a deposit address for one job.
app.get('/api/pay/assets', async (c) => {
  if (NEAR?.network !== 'mainnet') return c.json([]);
  try { return c.json(await payAssets()); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 502); }
});
app.post('/api/orders/:id/intents', async (c) => {
  const o = getOrder(c.req.param('id'));
  if (!o) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  try {
    if (b.txHash && o.intents) { await submitDeposit(o.intents.address, String(b.txHash).slice(0, 120), o.intents.memo); return c.json(view_(o)); }
    return c.json(view_(await payFromChain(o, String(b.assetId ?? ''), String(b.refundTo ?? '').trim())));
  } catch (e: any) { return c.json({ error: String(e?.message ?? e).slice(0, 200) }, 400); }
});
app.post('/api/orders/:id/accept', async (c) => {
  const o = getOrder(c.req.param('id'));
  if (!o) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(view_(await accept(o, b.tx))); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 400); }
});
app.post('/api/orders/:id/reject', async (c) => {
  const o = getOrder(c.req.param('id'));
  if (!o) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(view_(await rejected(o, b.tx))); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 400); }
});

// Live events: everything, or one order's (with what already happened, so a late page catches up).
app.get('/api/events', (c) => streamSSE(c, async (s) => {
  const only = c.req.query('order');
  const send = (e: Event) => s.writeSSE({ data: JSON.stringify(e) }).catch(() => {});
  for (const e of backlog(only)) await send(e);
  const on = (e: Event) => { if (!only || e.orderId === only) void send(e); };
  bus.on('event', on);
  const ping = setInterval(() => void s.writeSSE({ event: 'ping', data: '' }).catch(() => {}), 20_000);
  await new Promise<void>((done) => s.onAbort(() => { bus.off('event', on); clearInterval(ping); done(); }));
}));

// Websites the team built.
app.get('/sites/:id/', (c) => {
  const f = sitePath(c.req.param('id'));
  return /^[a-z0-9]+$/.test(c.req.param('id')) && existsSync(f) ? c.html(readFileSync(f, 'utf8')) : c.notFound();
});
// Files a delivery made beside its page (pictures, logos, an invitation's calendar file), by name only.
const FILE_TYPES: Record<string, string> = { wav: 'audio/wav', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', pdf: 'application/pdf', ics: 'text/calendar; charset=utf-8', html: 'text/html; charset=utf-8' };
app.get('/sites/:id/:file', (c) => {
  const id = c.req.param('id'), file = c.req.param('file');
  if (!/^[a-z0-9]+$/.test(id) || !/^[a-z0-9-]+\.[a-z]+$/.test(file)) return c.notFound();
  const f = sitePath(id, file), type = FILE_TYPES[file.split('.').pop()!];
  if (!type || !existsSync(f)) return c.notFound();
  return new Response(readFileSync(f), { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' } });
});

// The site (built web app), with the single-page fallback.
if (existsSync(WEB_DIR)) {
  const root = relative(process.cwd(), WEB_DIR);
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
}

serve({ fetch: app.fetch, port: PORT }, () => console.log(`parallax on :${PORT} (${DRY ? 'demo mode' : NEAR?.network ?? 'no deployment'})`));
