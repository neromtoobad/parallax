// One event stream for the whole company. The site follows it over SSE; scripts can listen too.
import { EventEmitter } from 'node:events';

export type Event = { type: string; orderId?: string; data?: unknown; at?: number };

export const bus = new EventEmitter();
bus.setMaxListeners(200);

const recent: Event[] = [];
/** Events from the last few minutes, so a page opened mid-auction can catch up. */
export const backlog = (orderId?: string) => (orderId ? recent.filter((e) => e.orderId === orderId) : recent.slice(-200));

export function publish(e: Event) {
  const ev = { ...e, at: Date.now() };
  recent.push(ev);
  while (recent.length > 2000 || (recent.length && ev.at - recent[0].at! > 15 * 60_000)) recent.shift();
  bus.emit('event', ev);
}
