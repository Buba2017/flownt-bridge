export type EventType = 'success' | 'info' | 'warn';

export interface BridgeEvent {
  ts: Date;
  type: EventType;
  msg: string;
}

const MAX = 30;
const logs = new Map<string, BridgeEvent[]>();

export function getEventLog(printerId: string): BridgeEvent[] {
  if (!logs.has(printerId)) logs.set(printerId, []);
  return logs.get(printerId)!;
}

export function addEvent(printerId: string, type: EventType, msg: string): void {
  const log = getEventLog(printerId);
  log.unshift({ ts: new Date(), type, msg });
  if (log.length > MAX) log.pop();
}
