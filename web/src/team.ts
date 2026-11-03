// Faces for accounts and roles (the roster itself comes from /api/team; this is enough to draw anyone).
export const NAMES: Record<string, string> = {
  scout: 'Pip', researcher: 'Odile', 'researcher-2': 'Teo', reader: 'Wren', investigator: 'Ansel', writer: 'Juno', 'writer-2': 'Bram',
  analyst: 'Sol', illustrator: 'Rafa', 'illustrator-2': 'Mei', producer: 'Nova', auditor: 'Hedda', 'auditor-2': 'Lux', messenger: 'Kit',
};
/** writer-2.team.parallax.testnet → writer-2; outside:handle → undefined. */
export const idOf = (account?: string) => (account && !account.startsWith('outside:') ? account.split('.')[0] : undefined);
export const nameOf = (account?: string) => {
  if (!account) return '';
  if (account === 'cfo') return 'CFO';
  return NAMES[idOf(account) ?? ''] ?? account.replace(/^outside:/, '');
};
export const faceOf = (account?: string) => {
  const n = NAMES[idOf(account) ?? ''];
  return n ? `/agents/heads/${n.toLowerCase()}.jpg` : undefined;
};
