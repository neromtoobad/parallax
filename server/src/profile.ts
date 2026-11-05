// One agent's page: its record, its money at the bank, the bonds it has out, and the parts it bid for, all
// read from the bank. Team agents and enlisted ones look the same here; an enlisted one also shows its sponsor.
import { DRY } from './config.ts';
import { crew } from './crew.ts';
import { NEAR, fromUnits, view } from './near/chain.ts';
import { ROSTER, accountOf } from './wallets.ts';

type AgentRow = { role: string; active: boolean; rep: number; earned: string; wins: number; fails: number };
type Seller = { Team: string } | { Outside: string };
type ChainLot = {
  id: number; job: string; title: string; status: string; round: number; reveals: { agent: string; price: string }[];
  commits: { agent: string }[]; winner: Seller | null; bid: string; pay: string; excluded: string[];
};

let lots: ChainLot[] = [], lotsAt = 0;
/** The last 200 lots, cached for 15 seconds. */
async function recentLots(): Promise<ChainLot[]> {
  if (Date.now() - lotsAt < 15_000) return lots;
  const n = (await view<{ lots: number }>(NEAR!.bank, 'overview')).lots;
  const from = Math.max(0, n - 200), out: ChainLot[] = [];
  for (let i = from; i < n; i += 50) out.push(...(await view<ChainLot[]>(NEAR!.bank, 'list_lots', { from: i, limit: 50 })));
  lots = out; lotsAt = Date.now();
  return lots;
}

export async function profile(account: string) {
  if (DRY || !NEAR) return undefined;
  const row = await view<AgentRow | null>(NEAR.bank, 'get_agent', { account }).catch(() => null);
  if (!row) return undefined;
  const team = ROSTER.find((a) => accountOf(a.id) === account), member = (await crew().catch(() => [])).find((m) => m.agent === account);
  const [balance, all] = await Promise.all([view<string>(NEAR.bank, 'balance_of', { account }), recentLots()]);
  const mine = all.filter((l) => l.commits.some((c) => c.agent === account) || l.excluded.includes(account)).reverse();
  const live = mine.filter((l) => ['Bidding', 'Awarded', 'Submitted'].includes(l.status)).map((l) => l.id);
  const bonds = live.length ? await view<[number, string][]>(NEAR.bank, 'bonds_of', { agent: account, lots: live }).catch(() => []) : [];
  const bondOn = new Map(bonds.map(([l, v]) => [Number(l), fromUnits(v)]));
  return {
    account, name: team?.name ?? member?.name ?? account.split('.')[0], role: row.role, title: team?.title, about: team?.about, look: team?.look,
    crew: member && { sponsor: member.sponsor, state: member.state, note: member.note, joined: Number(BigInt(member.joined) / 1_000_000n) },
    active: row.active, rep: row.rep, wins: row.wins, fails: row.fails, earned: fromUnits(row.earned), balance: fromUnits(balance),
    bonded: [...bondOn.values()].reduce((a, b) => a + b, 0),
    lots: mine.slice(0, 30).map((l) => {
      const mineBid = l.reveals.find((r) => r.agent === account), won = !!l.winner && 'Team' in l.winner && l.winner.Team === account;
      return {
        id: l.id, job: l.job, title: l.title, round: l.round, status: l.status, won, failed: l.excluded.includes(account),
        bid: mineBid ? fromUnits(mineBid.price) : undefined, pay: won ? fromUnits(l.pay) : undefined, bond: bondOn.get(l.id),
      };
    }),
  };
}
