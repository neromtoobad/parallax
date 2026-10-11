/**
 * Fixed eval set. Company facts here are long-settled public facts (founding year, current CEO),
 * so a run can be scored for wrong answers, not just missing ones.
 */

export interface BriefCase {
  id: string;
  input: { company: string; purpose: string };
  gold: { founded: number; ceo: string | string[] };
}

export interface LeadCase {
  id: string;
  input: { icp: string; titles: string; count: number };
}

export const BRIEFS: BriefCase[] = [
  { id: 'linear', input: { company: 'Linear (linear.app)', purpose: 'Sales call with their Head of Operations; we sell support analytics' }, gold: { founded: 2019, ceo: 'Karri Saarinen' } },
  { id: 'vercel', input: { company: 'Vercel', purpose: 'Partnership chat about a hosting integration' }, gold: { founded: 2015, ceo: 'Guillermo Rauch' } },
  { id: 'figma', input: { company: 'Figma', purpose: 'Pitching a design-ops plugin to their platform team' }, gold: { founded: 2012, ceo: 'Dylan Field' } },
  { id: 'retool', input: { company: 'Retool', purpose: 'Investor meeting prep: how big are they now' }, gold: { founded: 2017, ceo: 'David Hsu' } },
  { id: 'paystack', input: { company: 'Paystack (paystack.com)', purpose: 'Sales call: we sell fraud screening to payment companies in Africa' }, gold: { founded: 2015, ceo: 'Shola Akinlade' } },
  { id: 'flutterwave', input: { company: 'Flutterwave', purpose: 'Partnership pitch for cross-border payouts' }, gold: { founded: 2016, ceo: 'Olugbenga Agboola' } },
  { id: 'posthog', input: { company: 'PostHog', purpose: 'Sales call: we sell data warehouse connectors' }, gold: { founded: 2020, ceo: ['James Hawkins', 'Tim Glaser'] } }, // co-CEOs, per posthog.com/about
];

export const LEADS: LeadCase[] = [
  { id: 'devtools-us', input: { icp: 'Developer tools startups selling to engineering teams, 20 to 200 employees, United States', titles: 'CTO or VP Engineering', count: 5 } },
  { id: 'fintech-ng', input: { icp: 'Fintech startups in Nigeria', titles: 'CEO or Head of Partnerships', count: 5 } },
];
