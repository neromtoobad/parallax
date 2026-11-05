// What each role is expected to spend on its model calls for one job of each service, in USD. The CFO
// starts from these and moves to the real average once a service has a record (treasury.ts).
import type { Role } from '../wallets.ts';

export const SPEND: Record<string, Partial<Record<Role, number>>> = {
  'find-customers': { researcher: 0.004, scout: 0.002, reader: 0.009, investigator: 0.004, analyst: 0.005, writer: 0.005, auditor: 0.003 },
  website: { researcher: 0.004, reader: 0.004, writer: 0.008, analyst: 0.003, illustrator: 0.016, producer: 0.001, auditor: 0.004 },
  flyers: { writer: 0.004, illustrator: 0.026, producer: 0.001, auditor: 0.003 },
  factcheck: { investigator: 0.0008, reader: 0.0004 },
};
