// Research notes an outside winner (hired from the Agent Market) hands the team for one order.
// The team's model calls in that order read them (tools.ts llm). No imports, so anything can use it.
export type Notes = { handle: string; roles: string[]; text: string };
const notes = new Map<string, Notes>();
export const setNotes = (orderId: string, n: Notes) => void notes.set(orderId, n);
export const notesFor = (orderId?: string) => (orderId ? notes.get(orderId) : undefined);
export const dropNotes = (orderId: string) => void notes.delete(orderId);
