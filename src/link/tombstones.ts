import type { MultiConfig, PrinterConfig } from '../config.js';

// Access codes of printers removed by the sync are kept for TOMBSTONE_TTL_MS, so a
// printer that comes back (re-assigned in Flownt, or a removal that turns out to be a
// backend glitch) gets its code again without the user re-entering it. Codes delivered
// for a printer the bridge does not have (yet) are parked the same way.

export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SecretTombstone {
  flowntPrinterId: string;
  adapterSerial?: string;
  adapterApiKey: string;
  removedAt: string;
}

/** Drop expired tombstones; returns true if anything changed. */
export function pruneTombstones(cfg: MultiConfig, now = Date.now()): boolean {
  const list = cfg.removedSecrets ?? [];
  const kept = list.filter(t => now - Date.parse(t.removedAt) < TOMBSTONE_TTL_MS);
  if (kept.length === list.length) return false;
  if (kept.length) cfg.removedSecrets = kept; else delete cfg.removedSecrets;
  return true;
}

export function addTombstone(cfg: MultiConfig, t: Omit<SecretTombstone, 'removedAt'>, now = Date.now()): void {
  if (!t.adapterApiKey?.trim()) return;
  const list = (cfg.removedSecrets ?? []).filter(x => x.flowntPrinterId !== t.flowntPrinterId);
  list.push({ ...t, removedAt: new Date(now).toISOString() });
  cfg.removedSecrets = list;
}

/** Take (and remove) the parked code for this printer: by Flownt id, else by serial. */
export function takeTombstone(cfg: MultiConfig, p: Pick<PrinterConfig, 'flowntPrinterId' | 'adapterSerial'>): string | undefined {
  const list = cfg.removedSecrets ?? [];
  const serial = p.adapterSerial?.trim().toUpperCase();
  const i = list.findIndex(t => (p.flowntPrinterId && t.flowntPrinterId === p.flowntPrinterId)
    || (!!serial && t.adapterSerial?.trim().toUpperCase() === serial));
  if (i < 0) return undefined;
  const [t] = list.splice(i, 1);
  if (list.length) cfg.removedSecrets = list; else delete cfg.removedSecrets;
  return t.adapterApiKey;
}
