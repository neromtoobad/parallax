// One customer job while it runs: who does each part (the lots' winners), what they did, what they spent.
// Services write steps with log(); meter.ts adds a receipt line for every paid call.
import { publish } from './bus.ts';
import type { ReceiptLine } from './meter.ts';
import type { Winner } from './lots.ts';
import { accountOf, leadOf, type Role } from './wallets.ts';

export type Step = { at: string; agent: Role | 'cfo'; kind: string; text: string };
export type Policy = { budgetUsd: number; allowHosts: string[] };

export class Job {
  steps: Step[] = [];
  receipt: ReceiptLine[] = [];
  readonly orderId: string;
  readonly service: string;
  readonly policy: Policy;
  readonly assignment: Partial<Record<Role, Winner>>;
  constructor(orderId: string, service: string, policy: Policy, assignment: Partial<Record<Role, Winner>> = {}) {
    this.orderId = orderId; this.service = service; this.policy = policy; this.assignment = assignment;
  }

  /** The role that actually does a part: the lot's winner may hold a different role in the same group. */
  who(role: Role): Role { return this.assignment[role]?.role ?? role; }
  /** The account that pays for a part: the winner's own, or the role's lead agent when nobody won it. */
  payer(role: Role): string { return this.assignment[role]?.account ?? accountOf(leadOf(this.who(role)).id); }

  spentUsd() { return this.receipt.reduce((t, r) => t + r.usd, 0); }

  log(agent: Role | 'cfo', kind: string, text: string) {
    const s = { at: new Date().toISOString(), agent: agent === 'cfo' ? agent : this.who(agent), kind, text };
    this.steps.push(s);
    publish({ type: 'step', orderId: this.orderId, data: { ...s, account: agent === 'cfo' ? 'cfo' : this.payer(agent) } });
  }

  addReceipt(line: ReceiptLine) {
    this.receipt.push(line);
    publish({ type: 'receipt', orderId: this.orderId, data: { agent: line.agent, vendor: line.vendor, usd: line.usd, reason: line.reason, dry: line.dry } });
  }
}
