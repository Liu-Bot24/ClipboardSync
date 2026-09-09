import { filterVisibleHistory } from './policy.js';

export function historyEventForSelection(events, settings, eventId, limit = 15) {
  if (typeof eventId !== 'string' || !eventId) return null;
  return filterVisibleHistory(events, settings, limit).find((event) => event.id === eventId) || null;
}
