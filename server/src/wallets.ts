// The team: fourteen agents, each with a role, a NEAR account and a face. Roles are what the bank hires
// for and what lots are bid in (auction.ts GROUPS); the messenger carries finished work and doesn't bid.
import { NEAR } from './near/chain.ts';

export type Role =
  | 'scout' | 'researcher' | 'reader' | 'investigator'
  | 'writer' | 'analyst'
  | 'illustrator' | 'producer'
  | 'auditor'
  | 'messenger';

export type Agent = {
  id: string; // the short account name: researcher-2 for researcher-2.team.<root>
  role: Role;
  name: string;
  title: string;
  look: string; // the colour they're drawn in, for the site
  about: string;
};

export const ROSTER: Agent[] = [
  { id: 'scout', role: 'scout', name: 'Pip', title: 'Scout', look: '#17D9D4', about: 'Finds the people and places worth a look, fast.' },
  { id: 'researcher', role: 'researcher', name: 'Odile', title: 'Researcher', look: '#8B93E6', about: 'Checks every claim twice and keeps the sources.' },
  { id: 'researcher-2', role: 'researcher', name: 'Teo', title: 'Researcher', look: '#6B7B3A', about: 'Files everything. Bids low when the topic is familiar.' },
  { id: 'reader', role: 'reader', name: 'Wren', title: 'Reader', look: '#F4B79A', about: 'Reads the whole page so nobody else has to.' },
  { id: 'investigator', role: 'investigator', name: 'Ansel', title: 'Investigator', look: '#C9B48A', about: 'Looks behind a lead before anyone writes to it.' },
  { id: 'writer', role: 'writer', name: 'Juno', title: 'Writer', look: '#F07A62', about: 'Writes the line people actually answer.' },
  { id: 'writer-2', role: 'writer', name: 'Bram', title: 'Writer', look: '#D9A22B', about: 'Long copy, short sentences.' },
  { id: 'analyst', role: 'analyst', name: 'Sol', title: 'Analyst', look: '#0B6F6C', about: 'Turns a pile of notes into a ranked list.' },
  { id: 'illustrator', role: 'illustrator', name: 'Rafa', title: 'Illustrator', look: '#4F6FA8', about: 'Paints first, explains later.' },
  { id: 'illustrator-2', role: 'illustrator', name: 'Mei', title: 'Illustrator', look: '#7FD9AE', about: 'Clean layouts and a steady hand.' },
  { id: 'producer', role: 'producer', name: 'Nova', title: 'Producer', look: '#111111', about: 'Puts the pieces together and ships them.' },
  { id: 'auditor', role: 'auditor', name: 'Hedda', title: 'Auditor', look: '#B5A3E0', about: 'Nothing leaves without her check mark.' },
  { id: 'auditor-2', role: 'auditor', name: 'Lux', title: 'Auditor', look: '#E8E7DE', about: 'Stamps it only when it is right.' },
  { id: 'messenger', role: 'messenger', name: 'Kit', title: 'Messenger', look: '#00EC97', about: 'Carries sealed bids in and finished work out.' },
];

const byId = new Map(ROSTER.map((a) => [a.id, a]));
/** The agent behind an account (writer-2.team.parallax.testnet, or writer-2 in demo mode). */
export const agentOf = (account: string) => byId.get(account.split('.')[0]);
/** A role's first agent, the one who does the work when no lot was won for it. */
export const leadOf = (role: Role) => ROSTER.find((a) => a.role === role)!;
/** The NEAR account an agent signs with: <id>.team.<root> (the deployment lists one per role; seconds share the parent). */
const parent = NEAR ? Object.values(NEAR.team)[0].split('.').slice(1).join('.') : '';
export const accountOf = (id: string) => (NEAR ? NEAR.team[id] ?? `${id}.${parent}` : id);
/** Display name for an account or outside handle. */
export const nameOf = (account: string) => agentOf(account)?.name ?? account.replace(/^outside:/, '');
