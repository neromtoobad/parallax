import type { Dept, ServiceId } from './types.ts';

export const SERVICES: { id: ServiceId; name: string; dept: Dept; blurb: string; fields: { name: string; label: string; placeholder: string; type?: string }[] }[] = [
  {
    id: 'company-brief',
    name: 'Company brief',
    dept: 'sales',
    blurb: 'Everything you need before a sales call, pitch or partnership chat. Every fact checked from two angles.',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'Linear, or linear.app' },
      { name: 'purpose', label: 'What is it for?', placeholder: 'Sales call with their Head of Ops next week' },
    ],
  },
  {
    id: 'lead-list',
    name: 'Lead list',
    dept: 'sales',
    blurb: 'Companies that fit your ideal customer, each with the right person to contact. Every lead checked from two angles.',
    fields: [
      { name: 'icp', label: 'Who are you looking for?', placeholder: 'Seed to Series A fintech startups in Nigeria' },
      { name: 'titles', label: 'Who should we contact?', placeholder: 'CTO or Head of Engineering' },
      { name: 'count', label: 'How many leads?', placeholder: '10', type: 'number' },
    ],
  },
  {
    id: 'people-map',
    name: 'Who to talk to',
    dept: 'sales',
    blurb: 'The people at one company who matter for your goal, from decision-maker to blocker. Each one found in the database and confirmed on the open web.',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'Paystack, or paystack.com' },
      { name: 'goal', label: 'What do you want from them?', placeholder: 'Selling HR software' },
    ],
  },
  {
    id: 'competitor-teardown',
    name: 'Competitor teardown',
    dept: 'market',
    blurb: "Who you compete with and how each one sells itself: positioning, target customer and pricing, quoted from their own sites, then where you differ and where you're exposed.",
    fields: [
      { name: 'company', label: 'Your company (or the one to tear down)', placeholder: 'Linear, or linear.app' },
      { name: 'focus', label: 'What matters most?', placeholder: 'Pricing and positioning for mid-size engineering teams' },
    ],
  },
  {
    id: 'market-map',
    name: 'Market map',
    dept: 'market',
    blurb: "The companies in a space with size, age and funding from the database, each confirmed on its own website with a quoted line showing what it does.",
    fields: [
      { name: 'space', label: 'Which space?', placeholder: 'AI agent observability tools' },
      { name: 'country', label: 'Country (optional)', placeholder: 'United States' },
      { name: 'count', label: 'How many companies?', placeholder: '10', type: 'number' },
    ],
  },
  {
    id: 'vendor-check',
    name: 'Check before you pay',
    dept: 'trust',
    blurb: 'A green, amber or red verdict on a supplier before money moves: domain, company record, leadership, complaints, lawsuits and news, each a checked signal.',
    fields: [
      { name: 'company', label: 'Supplier (name or website)', placeholder: 'acme-supplies.com' },
      { name: 'context', label: "What's the deal?", placeholder: 'Supplier asking for a 50% deposit on a $20k order' },
    ],
  },
  {
    id: 'person-check',
    name: 'Verify a person',
    dept: 'trust',
    blurb: 'Is this person really at this company, in this role? The people database and the open web each give an answer; the verdict is confirmed, mismatch or not found.',
    fields: [
      { name: 'name', label: 'Full name', placeholder: 'Karri Saarinen' },
      { name: 'company', label: 'Company', placeholder: 'Linear' },
      { name: 'title', label: 'Title they claim (optional)', placeholder: 'CEO' },
    ],
  },
];
