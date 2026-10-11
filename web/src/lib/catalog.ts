import type { AgentId } from './api';

export type Dept = 'sales' | 'market' | 'trust';

export interface ServiceDef {
  id: string;
  name: string;
  dept: Dept;
  tagline: string;
  blurb: string;
  /** Who fronts this service on the site. */
  face: Exclude<AgentId, 'system'>;
  /** What the two angles each look at, in plain words. */
  angles: [string, string];
  deliverable: string;
  fields: { name: string; label: string; placeholder: string; type?: string; optional?: boolean }[];
}

export const DEPTS: Record<Dept, { name: string; line: string; color: string }> = {
  sales: { name: 'Sales', line: 'Walk into every meeting knowing more than they expect.', color: 'var(--records)' },
  market: { name: 'Market', line: 'See your competitors and your market as they really are.', color: 'var(--field)' },
  trust: { name: 'Trust', line: 'Check before you pay, sign or hire.', color: 'var(--verifier)' },
};

export const SERVICES: ServiceDef[] = [
  {
    id: 'company-brief',
    name: 'Company brief',
    dept: 'sales',
    tagline: 'Before the call',
    blurb: 'Who they are, how big, who runs it, how they’re funded, and what to do with that in the meeting.',
    face: 'writer',
    angles: ['Company & people databases', 'Their own site and the open web'],
    deliverable: '7 verified facts + 4-6 meeting notes, every line cited',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'Linear, or linear.app' },
      { name: 'purpose', label: 'What is it for?', placeholder: 'Sales call with their Head of Ops next week' },
    ],
  },
  {
    id: 'lead-list',
    name: 'Lead list',
    dept: 'sales',
    tagline: 'Pipeline that holds up',
    blurb: 'Companies that fit your ideal customer, each with the right person to contact. A lead ships only if both angles agree.',
    face: 'records',
    angles: ['Company search + people database', 'Their homepage + the open web'],
    deliverable: 'N verified leads with contacts, CSV export, pay per verified lead',
    fields: [
      { name: 'icp', label: 'Who are you looking for?', placeholder: 'Fintech startups in Nigeria' },
      { name: 'titles', label: 'Who should we contact?', placeholder: 'CEO or Head of Partnerships' },
      { name: 'count', label: 'How many leads?', placeholder: '5', type: 'number' },
    ],
  },
  {
    id: 'people-map',
    name: 'Who to talk to',
    dept: 'sales',
    tagline: 'The right door',
    blurb: 'The people at one company who matter for what you’re selling, each confirmed to still be there.',
    face: 'lead',
    angles: ['People database by function', 'Web mentions of each person'],
    deliverable: '3-8 people with role, why they matter, and confirmation checks',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'Paystack' },
      { name: 'goal', label: 'What are you selling or asking for?', placeholder: 'HR software for growing teams' },
    ],
  },
  {
    id: 'competitor-teardown',
    name: 'Competitor teardown',
    dept: 'market',
    tagline: 'Know the field',
    blurb: 'Your closest competitors, how they position and price themselves in their own words, and where you’re different.',
    face: 'field',
    angles: ['Company database (size, funding)', 'Their homepages and pricing pages'],
    deliverable: '4-6 competitors, quoted positioning + pricing, your edge and exposure',
    fields: [
      { name: 'company', label: 'Your company (or the one to study)', placeholder: 'linear.app' },
      { name: 'focus', label: 'What do you want to compare?', placeholder: 'Pricing and who they sell to', optional: true },
    ],
  },
  {
    id: 'market-map',
    name: 'Market map',
    dept: 'market',
    tagline: 'The whole board',
    blurb: 'The companies in a space with size, funding and what they actually do, each confirmed on its own site.',
    face: 'arbiter',
    angles: ['Company search with hard filters', 'A quoted line from each homepage'],
    deliverable: 'N companies, verified, sortable, CSV export',
    fields: [
      { name: 'space', label: 'Which space?', placeholder: 'AI agent observability tools' },
      { name: 'country', label: 'Country (optional)', placeholder: 'United States', optional: true },
      { name: 'count', label: 'How many companies?', placeholder: '8', type: 'number' },
    ],
  },
  {
    id: 'vendor-check',
    name: 'Check before you pay',
    dept: 'trust',
    tagline: 'Supplier due diligence',
    blurb: 'Is this supplier real? Domain, records, leadership, complaints and news, with a green, amber or red verdict you can defend.',
    face: 'verifier',
    angles: ['Company + people databases', 'Their site, complaints and news'],
    deliverable: 'Verdict + every check with its source',
    fields: [
      { name: 'company', label: 'Company or website', placeholder: 'acme-supplies.com' },
      { name: 'context', label: 'What’s the deal?', placeholder: 'They want a 50% deposit for 200 units', optional: true },
    ],
  },
  {
    id: 'person-check',
    name: 'Verify a person',
    dept: 'trust',
    tagline: 'Are they who they say?',
    blurb: 'Does this person really hold that role at that company, today? Confirmed, mismatch or not found, with proof.',
    face: 'cfo',
    angles: ['People database (current role)', 'The web and the company’s own team page'],
    deliverable: 'Verdict + current role, start date and evidence',
    fields: [
      { name: 'name', label: 'Their name', placeholder: 'Karri Saarinen' },
      { name: 'company', label: 'Company they claim', placeholder: 'Linear' },
      { name: 'title', label: 'Title they claim (optional)', placeholder: 'CEO', optional: true },
    ],
  },
];

export const serviceById = (id: string) => SERVICES.find((s) => s.id === id);
