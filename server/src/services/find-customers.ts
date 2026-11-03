// Find Customers: a ranked list of real businesses to sell to, from OpenStreetMap, each read up, checked,
// and given its own opening line, plus the email to send.
import type { Job } from '../job.ts';
import { llmJson, places, readPage, type Place } from '../tools.ts';
import { audit, briefOf } from './check.ts';
import type { Field, Service } from './index.ts';

const fields: Field[] = [
  { key: 'business', label: 'Your business', hint: 'Alma Roasters, a small specialty coffee roaster' },
  { key: 'offer', label: 'What you want to sell them', hint: 'Fresh-roasted beans delivered weekly, with a free barista session', long: true },
  { key: 'customers', label: 'Who you sell to', hint: 'Independent cafés' },
  { key: 'city', label: 'Where', hint: 'Lisbon, Portugal' },
  { key: 'from', label: 'Sign the email as', hint: 'Marta, Alma Roasters', optional: true },
];

// A guess from plain words, used in demo mode and when the model's tags find nothing.
const GUESS: [RegExp, string][] = [
  [/caf[eé]|coffee/i, 'amenity=cafe'], [/restaurant|diner|eatery/i, 'amenity=restaurant'], [/bar|pub/i, 'amenity=bar'],
  [/baker/i, 'shop=bakery'], [/hotel|guest ?house|hostel/i, 'tourism=hotel'], [/gym|fitness/i, 'leisure=fitness_centre'],
  [/salon|hair|barber/i, 'shop=hairdresser'], [/dentist/i, 'amenity=dentist'], [/school/i, 'amenity=school'],
  [/florist|flower/i, 'shop=florist'], [/book/i, 'shop=books'], [/clothes|fashion|boutique/i, 'shop=clothes'],
  [/law|solicitor|attorney/i, 'office=lawyer'], [/architect/i, 'office=architect'], [/clinic|doctor/i, 'amenity=clinic'],
];
// Chains buy centrally; demo mode sets the well-known ones aside (the model does this from its own knowledge).
const CHAINS = /starbucks|mcdonald|costa coffee|padaria portuguesa|pret a manger|tim hortons|dunkin|subway|kfc|burger king|pizza hut|domino|caffè nero|five guys|telepizza|h3|vitaminas/i;
const guess = (s: string) => [...new Set(GUESS.filter(([re]) => re.test(s)).map(([, t]) => t))].slice(0, 3);

type Lead = Place & { fit: number; why: string; opener: string; flag?: string; note?: string };

async function run(job: Job, input: Record<string, string>) {
  const brief = briefOf(fields, input);
  const who = input.customers, city = input.city;

  // 1. The researcher turns "who you sell to" into map tags.
  job.log('researcher', 'start', `Working out what "${who}" look like on a map`);
  const plan = await llmJson<{ profile: string; tags: string[] }>(job, 'researcher', {
    reason: 'turn the customer type into map tags',
    system: 'You plan a customer search on OpenStreetMap for a small business. Reply with JSON {"profile": one sentence on the ideal customer, "tags": up to 3 OpenStreetMap key=value tags that find them (e.g. amenity=cafe, shop=bakery, office=architect, tourism=hotel)}. Use only common, real OSM tags.',
    prompt: brief,
    dry: () => JSON.stringify({ profile: `${who} in ${city} that buy what ${input.business} sells and decide for themselves.`, tags: guess(who).length ? guess(who) : ['amenity=cafe'] }),
    maxTokens: 300,
  });
  const tags = (plan.tags ?? []).filter((t) => /^[a-z_:]+=[a-z_;]+$/i.test(t)).slice(0, 3);
  job.log('researcher', 'done', `${plan.profile} Looking for ${tags.join(', ')}.`);

  // 2. The scout maps them.
  job.log('scout', 'start', `Mapping ${tags.join(', ')} around ${city}`);
  let found = tags.length ? await places(city, tags, 24) : [];
  if (found.length < 5 && guess(who).length) found = await places(city, guess(who), 24);
  if (!found.length) throw new Error(`no ${who} found on the map around ${city}`);
  job.log('scout', 'done', `Found ${found.length} on OpenStreetMap, ${found.filter((p) => p.email || p.phone).length} with a phone or email`);

  // 3. The reader reads the websites of the best-placed ones.
  const withSite = found.filter((p) => p.website).slice(0, 8);
  job.log('reader', 'start', `Reading ${withSite.length} websites`);
  const pages = await Promise.all(withSite.map((p) => readPage(p.website!.startsWith('http') ? p.website! : `https://${p.website}`, 2500).catch(() => '')));
  const read = withSite.map((p, i) => ({ i: found.indexOf(p), text: pages[i] })).filter((x) => x.text.length > 200);
  const notes = read.length ? await llmJson<{ notes: { i: number; note: string }[] }>(job, 'reader', {
    reason: `summarise ${read.length} websites`,
    system: 'For each business website, write one short factual line a salesperson could use: what they do, anything notable (menu, opening, events, style). Only what the text says. JSON {"notes": [{"i": number, "note": string}]}.',
    prompt: read.map((x) => `#${x.i} ${found[x.i].name}\n${x.text}`).join('\n\n'),
    dry: () => JSON.stringify({ notes: read.map((x) => ({ i: x.i, note: `${found[x.i].name} has its own website and lists ${found[x.i].kind || 'its services'} there.` })) }),
    maxTokens: 900,
  }) : { notes: [] };
  const noteOf = new Map(notes.notes.map((n) => [n.i, n.note]));
  job.log('reader', 'done', `${noteOf.size} websites summarised`);

  // 4. The investigator flags the ones not worth writing to.
  job.log('investigator', 'start', 'Checking each lead before anyone writes to it');
  const listed = found.map((p, i) => `#${i} ${p.name} | ${p.kind} | ${p.address || 'no address'} | web:${p.website ? 'yes' : 'no'} phone:${p.phone ? 'yes' : 'no'} email:${p.email ? 'yes' : 'no'}${noteOf.has(i) ? ` | ${noteOf.get(i)}` : ''}`).join('\n');
  const flags = await llmJson<{ flags: { i: number; flag: string }[] }>(job, 'investigator', {
    reason: 'flag weak or wrong leads',
    system: 'You vet sales leads. Flag a business that is a big chain or franchise (it buys centrally), plainly the wrong kind for the offer, or impossible to reach. Do not flag for missing info alone if there is an address. JSON {"flags": [{"i": number, "flag": short reason}]}.',
    prompt: `Offer: ${input.offer}\nWho: ${who}\n\n${listed}`,
    dry: () => JSON.stringify({ flags: found.map((p, i) => ({ i, p })).flatMap(({ p, i }) => CHAINS.test(p.name) ? [{ i, flag: `${p.name} is a chain and buys centrally` }] : !p.phone && !p.email && !p.website && !p.address ? [{ i, flag: 'no way to reach them found' }] : []) }),
    maxTokens: 600,
  });
  const flagOf = new Map(flags.flags.map((f) => [f.i, f.flag]));
  job.log('investigator', 'done', flagOf.size ? `${flagOf.size} set aside: ${[...flagOf.values()].slice(0, 2).join('; ')}` : 'All leads look real and reachable');

  // 5. The analyst ranks the rest.
  job.log('analyst', 'start', 'Ranking the leads by fit');
  const rank = await llmJson<{ top: { i: number; fit: number; why: string }[] }>(job, 'analyst', {
    reason: 'rank the leads',
    system: 'Rank sales leads for a small business. Pick the best 10 (fewer if fewer are good), skip flagged ones. fit is 1-5. why is one concrete line. JSON {"top": [{"i": number, "fit": number, "why": string}]}, best first.',
    prompt: `${brief}\n\nLeads:\n${listed}\n\nFlagged:\n${[...flagOf].map(([i, f]) => `#${i} ${f}`).join('\n') || 'none'}`,
    dry: () => JSON.stringify({ top: found.map((p, i) => ({ p, i })).filter(({ i }) => !flagOf.has(i)).slice(0, 10).map(({ p, i }, k) => ({ i, fit: Math.max(3, 5 - Math.floor(k / 4)), why: p.email ? 'Has an email listed, so the first message can go today' : p.phone ? 'Has a phone listed for a quick call' : 'Close by and the right kind of place' })) }),
    maxTokens: 900,
  });
  const top = rank.top.filter((t) => found[t.i] && !flagOf.has(t.i)).slice(0, 10);
  job.log('analyst', 'done', `Top ${top.length}: ${top.slice(0, 3).map((t) => found[t.i].name).join(', ')}…`);

  // 6. The writer drafts the email and a first line for each lead.
  job.log('writer', 'start', 'Writing the email and a first line for each lead');
  const sign = input.from?.trim() || input.business;
  const copy = await llmJson<{ subject: string; body: string; openers: { i: number; line: string }[] }>(job, 'writer', {
    reason: 'draft the outreach email',
    system: 'Write a short cold email (under 120 words) from a small business to a local business. Plain, warm, specific, no hype, one clear ask. Put {{opener}} where a personal first line goes, and {{name}} for the business name. Then a personal first line for each lead (one sentence, true to what we know). JSON {"subject": string, "body": string, "openers": [{"i": number, "line": string}]}.',
    prompt: `${brief}\nSign as: ${sign}\n\nLeads:\n${top.map((t) => `#${t.i} ${found[t.i].name} (${found[t.i].kind}) ${noteOf.get(t.i) ?? ''}`).join('\n')}`,
    dry: () => JSON.stringify({
      subject: `${input.business.split(',')[0]} for ${'{{name}}'}`,
      body: `Hi {{name}} team,\n\n{{opener}}\n\nWe're ${input.business}. ${input.offer}\n\nCould I drop by one morning this week with a sample? Ten minutes, no pitch deck.\n\nThanks,\n${sign}`,
      openers: top.map((t) => ({ i: t.i, line: noteOf.has(t.i) ? `I was reading about ${found[t.i].name} and liked what I saw.` : `I walk past ${found[t.i].name} often and wanted to say hello properly.` })),
    }),
    maxTokens: 1200,
  });
  const opener = new Map(copy.openers.map((o) => [o.i, o.line]));
  job.log('writer', 'done', `"${copy.subject}"`);

  const leads: Lead[] = top.map((t) => ({ ...found[t.i], fit: t.fit, why: t.why, opener: opener.get(t.i) ?? '', note: noteOf.get(t.i) }));
  const check = await audit(job, brief, `Email subject: ${copy.subject}\n${copy.body}\n\nLeads:\n${leads.map((l) => `${l.name} | ${l.address} | ${l.email ?? ''} ${l.phone ?? ''} | ${l.why} | ${l.opener}`).join('\n')}`);

  const q = (s = '') => `"${String(s).replace(/"/g, '""')}"`;
  const csv = ['name,kind,address,website,phone,email,fit,why,first line,map', ...leads.map((l) => [l.name, l.kind, l.address, l.website, l.phone, l.email, l.fit, l.why, l.opener, l.osm].map((v) => q(String(v ?? ''))).join(','))].join('\n');
  return {
    summary: `${leads.length} ${who.toLowerCase()} in ${city}, ranked, each with a first line, and the email to send them.`,
    check, leads, csv, email: { subject: copy.subject, body: copy.body },
  };
}

export const findCustomers: Service = {
  id: 'find-customers', name: 'Find customers', priceUsd: 3,
  blurb: 'Ten real businesses near you that should buy from you, each checked, ranked and given its own first line, with the email to send.',
  team: ['researcher', 'scout', 'reader', 'investigator', 'analyst', 'writer', 'auditor'],
  fields,
  example: { business: 'Alma Roasters, a small specialty coffee roaster', offer: 'Fresh-roasted beans delivered every week, with a free barista session for new cafés', customers: 'Independent cafés', city: 'Lisbon, Portugal', from: 'Marta, Alma Roasters' },
  run,
};
