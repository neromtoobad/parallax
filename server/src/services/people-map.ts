import { BudgetExceeded, say, step } from '../context.ts';
import { peopleAt } from '../crust.ts';
import { env } from '../env.ts';
import { json } from '../llm.ts';
import { emit } from '../store.ts';
import type { Check, Deliverable, Item, Job } from '../types.ts';
import { FUNCTIONS, looksLikeDomain, personOf, personOnWeb, resolveCompany, SENIOR_LEVELS, seniority, toCsv, writeAudited } from './shared.ts';

/**
 * People map: who to talk to at one company for one goal. The Lead works out which functions own
 * the decision, Records finds the people in those seats now, Field confirms each one on the open web.
 */

interface Intake {
  name: string;
  domain: string | null;
  goal: string;
  groups: { role: string; titles: string[]; function: string | null; why: string }[];
}

interface Candidate {
  name: string;
  title: string;
  since: string | null;
  profileUrl: string | null;
  seniority: string | null;
  group: number;
  rank: number;
}

const MAX = 8;

export async function runPeopleMap(job: Job): Promise<Deliverable> {
  const intake = await step(job, 'lead', 'intake', () =>
    json<Intake>({
      system: `You are the Lead at a research agency. A client wants to know who to talk to at one company for a specific goal. Extract the company (and its domain if given, else null) and work out 2-4 groups of people who matter for that goal: who signs off, who uses or owns the problem, who could block it. For each group give a short role label, 3-5 job-title forms as they appear in titles, including the common variants (e.g. "CHRO", "Head of People", "People Director", "VP Human Resources"), the closest function from this list or null: ${FUNCTIONS.join(', ')}, and one sentence on why that group matters for the goal.`,
      user: `Client brief: ${job.brief}\nForm fields: ${JSON.stringify(job.input)}\n\nReturn {"name": string, "domain": string|null, "goal": string, "groups": [{"role", "titles": string[], "function": string|null, "why"}]}`,
      check: (v) => (!v?.name ? 'missing name' : !Array.isArray(v.groups) || !v.groups.length ? 'groups must be a non-empty array' : v.groups.some((g: any) => !Array.isArray(g.titles) || !g.titles.length) ? 'every group needs titles' : null),
    }),
  );
  intake.groups = intake.groups.slice(0, 4).map((g) => ({ ...g, function: FUNCTIONS.includes(g.function ?? '') ? g.function : null }));
  if (!job.plan) {
    job.plan = intake;
    // Outside any step there's no agent context, so say() would drop this; emit it as the Lead.
    emit(job, { agent: 'lead', kind: 'step', text: `Work order: who to talk to at ${intake.name} for ${intake.goal}. Looking for ${intake.groups.map((g) => g.role).join(', ')}` });
  }

  const company = await step(job, 'lead', 'resolve', () => {
    const raw = String(job.input.company ?? '');
    return resolveCompany(intake.name, intake.domain ?? (looksLikeDomain(raw) ? raw : null), job.brief);
  });
  const name = company.name || intake.name;

  // Records: one search per group, by title or by function at a senior level.
  const pool = await step(job, 'records', 'people', async () => {
    const found: Candidate[] = [];
    for (const [gi, g] of intake.groups.entries()) {
      say(`Searching the people database at ${company.domain} for ${g.role}`, 'tool');
      const r = await peopleAt({ domain: company.domain, titles: g.titles, functions: g.function ? [g.function] : undefined, seniority: [...SENIOR_LEVELS, 'Experienced Manager'], limit: 6 }).catch((e) => {
        if (e instanceof BudgetExceeded) throw e;
        say(`people search for ${g.role} failed (${e.message}); moving on`, 'recover');
        return { profiles: [] };
      });
      for (const p of (r.profiles ?? []).map(personOf)) {
        if (!p.name || found.some((f) => f.name.toLowerCase() === p.name.toLowerCase())) continue;
        found.push({ name: p.name, title: p.title, since: p.since, profileUrl: p.profileUrl, seniority: p.seniority, group: gi, rank: seniority(p.title, p.seniority) });
      }
    }
    // Most senior first, but take turns between groups so one function can't fill the map.
    const byGroup = intake.groups.map((_, gi) => found.filter((f) => f.group === gi).sort((a, b) => a.rank - b.rank));
    const order: Candidate[] = [];
    for (let round = 0; order.length < found.length; round++) for (const g of byGroup) if (g[round]) order.push(g[round]);
    say(`Records found ${found.length} people across ${intake.groups.length} groups`);
    return order.slice(0, MAX + 2);
  });
  if (!pool.length) throw new Error(`no current staff found at ${company.domain} for ${intake.groups.map((g) => g.role).join(', ')}`);

  // Field: each person on the open web. One search each, one step each, so a crash resumes mid-list.
  const items: (Item & { group: number })[] = [];
  let partial = false;
  try {
    for (const p of pool) {
      if (items.filter((i) => i.status === 'verified').length >= MAX) break;
      const item = await step(job, 'field', `confirm:${p.name}`, async () => {
        say(`Checking ${p.name} (${p.title}) on the open web`, 'tool');
        const web = await personOnWeb(p.name, name);
        const checks: Check[] = [
          { name: 'in the people database', ok: true, note: `${p.title}${p.since ? `, since ${String(p.since).slice(0, 7)}` : ''}`, source: p.profileUrl ?? 'crustdata' },
          {
            name: 'on the open web',
            ok: web.mentions.length > 0 && !web.left,
            note: web.left ? `web says they left: "${web.left.snippet.slice(0, 140)}"` : web.mentions.length ? `${web.mentions.length} page${web.mentions.length > 1 ? 's' : ''} link them to ${name}` : 'database only; no web page links them to the company',
            source: (web.left ?? web.mentions[0])?.url,
          },
        ];
        return {
          title: p.name,
          subtitle: p.title,
          link: p.profileUrl ?? undefined,
          status: web.left ? 'dropped' : 'verified',
          dropReason: web.left ? `the web says ${p.name} left ${name}` : undefined,
          checks,
          fields: { role: intake.groups[p.group].role, title: p.title, since: p.since ? String(p.since).slice(0, 10) : '', webConfirmed: String(web.mentions.length > 0 && !web.left) },
          group: p.group,
        } as Item & { group: number };
      }, { retries: 1 });
      items.push(item);
      emit(job, { agent: 'verifier', kind: 'check', text: item.status === 'verified' ? `✓ ${item.title}: ${item.subtitle}${item.fields?.webConfirmed === 'true' ? ', confirmed on the web' : ', database only'}` : `✗ ${item.title}: ${item.dropReason}`, data: item });
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded) || !items.some((i) => i.status === 'verified')) throw e;
    partial = true;
    emit(job, { agent: 'cfo', kind: 'money', text: `Budget reached after checking ${items.length} people. Delivering what's verified.` });
  }

  // Web-confirmed people first; database-only ones still make the map, flagged as such.
  const kept = items.filter((i) => i.status === 'verified').sort((a, b) => Number(b.fields?.webConfirmed === 'true') - Number(a.fields?.webConfirmed === 'true')).slice(0, MAX);
  const dropped = items.filter((i) => i.status === 'dropped');
  if (!kept.length) throw new Error(`nobody at ${name} held up: ${dropped.length} people checked`);

  // Writer: why each person matters, and who to approach first. Cites people by key; the audit checks them.
  const ids = Object.fromEntries(kept.map((k, i) => [`P${i + 1}`, `${k.title}, ${k.subtitle}, ${k.fields?.role}${k.fields?.since ? `, in role since ${k.fields.since}` : ''}`]));
  const plan = await step(job, 'writer', 'write', async () => {
    const why = await json<{ people: { id: string; why: string }[] }>({
      model: env.models.fast,
      system: 'For each person, write one plain sentence on why they matter for the client\'s goal, based only on their title and group. No guesses about their opinions.',
      user: `Goal: ${intake.goal} at ${name}\nGroups: ${intake.groups.map((g) => `${g.role}: ${g.why}`).join(' | ')}\nPeople:\n${Object.entries(ids).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nReturn {"people": [{"id", "why"}]}`,
      check: (v) => (!Array.isArray(v?.people) ? 'people must be an array' : null),
    });
    const order = await writeAudited({
      model: env.models.smart,
      system: 'You plan the approach for a client who wants to reach people at a company. Use ONLY the people given. 3-4 points: who to contact first and why, who to bring in next, who could block it. Each point cites the person ids it relies on. No hedging words ("likely", "may", "might", "could", "probably", "suggests", "seems", "potentially"). Do not add numbers or names that are not in the cited people.',
      user: `Goal: ${intake.goal}\nCompany: ${name}\nPeople:\n${Object.entries(ids).map(([k, v]) => `[${k}] ${v}`).join('\n')}`,
      values: ids,
    });
    return { why: Object.fromEntries(why.people.map((p) => [p.id, p.why])), ...order };
  });
  kept.forEach((k, i) => {
    if (plan.why[`P${i + 1}`]) k.fields = { ...k.fields, why: plan.why[`P${i + 1}`] };
  });

  const webConfirmed = kept.filter((k) => k.fields?.webConfirmed === 'true').length;
  // Lead with whoever the approach plan says to contact first.
  const firstId = plan.points[0]?.cites?.find((c) => /^P\d+$/.test(c) && kept[Number(c.slice(1)) - 1]);
  const first = firstId ? kept[Number(firstId.slice(1)) - 1] : kept[0];
  return {
    headline: `${kept.length} people to talk to at ${name} about ${intake.goal}; start with ${first.title} (${first.subtitle}). ${webConfirmed} of ${kept.length} confirmed on the open web.`,
    company: { name, domain: company.domain },
    goal: intake.goal,
    items: [...kept, ...dropped].map(({ group, ...i }) => i),
    points: plan.points,
    stats: { candidates: pool.length, checked: items.length, verified: kept.length, webConfirmed, dropped: dropped.length, draftRounds: plan.rounds },
    csv: toCsv(['name', 'title', 'role', 'since', 'profile', 'web_confirmed', 'why'], kept.map((k) => [k.title, k.subtitle, k.fields?.role, k.fields?.since, k.link, k.fields?.webConfirmed, k.fields?.why])),
    partial,
  };
}
