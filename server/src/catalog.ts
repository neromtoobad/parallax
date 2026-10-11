import type { ServiceId } from './types.ts';

export const SERVICES: { id: ServiceId; name: string; blurb: string; fields: { name: string; label: string; placeholder: string; type?: string }[] }[] = [
  {
    id: 'company-brief',
    name: 'Company brief',
    blurb: 'Everything you need before a sales call, pitch or partnership chat. Every fact checked from two angles.',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'Linear, or linear.app' },
      { name: 'purpose', label: 'What is it for?', placeholder: 'Sales call with their Head of Ops next week' },
    ],
  },
  {
    id: 'lead-list',
    name: 'Lead list',
    blurb: 'Companies that fit your ideal customer, each with the right person to contact. Every lead checked from two angles.',
    fields: [
      { name: 'icp', label: 'Who are you looking for?', placeholder: 'Seed to Series A fintech startups in Nigeria' },
      { name: 'titles', label: 'Who should we contact?', placeholder: 'CTO or Head of Engineering' },
      { name: 'count', label: 'How many leads?', placeholder: '10', type: 'number' },
    ],
  },
];
