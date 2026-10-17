import { loadMultiConfig, saveMultiConfig, needsAccessCode, type PrinterConfig } from '../config.js';
import { BambuCloudSession, type CloudDevice, type CloudToken } from '../bambu-cloud.js';
import { cloudSourceFor } from '../cloud-sources.js';
import { createLogger } from '../logger.js';

const log = createLogger('link');

// Flownt delivers access codes and the cloud session only for the printers that exist at
// the moment someone signs in with Bambu Lab. A printer added later stays offline until
// the next sign-in. A bridge that already holds a session of the account fills the gap
// itself: the account's device list carries each bound printer's LAN access code. The
// codes stay on the bridge, like the ones delivered by Flownt.

export interface DeviceLister {
  readonly current: CloudToken;
  listDevices(): Promise<CloudDevice[] | null>;
}

export interface CloudCodeDeps {
  now?: () => number;
  /** The session a printer's cloud token belongs to (shared per account). */
  sessionFor?: (p: PrinterConfig) => DeviceLister | null;
}

/** A printer not found in any account is looked up again after this long. */
export const CLOUD_LOOKUP_RETRY_MS = 10 * 60_000;
const lastLookup = new Map<string, number>();

/** Test hook: forget when serials were last looked up. */
export function resetCloudLookups(): void { lastLookup.clear(); }

const defaultSessionFor = (p: PrinterConfig): DeviceLister | null => {
  const s = cloudSourceFor(p);
  return s instanceof BambuCloudSession ? s : null;
};

const wants = (p: PrinterConfig) => p.managed === true && p.adapterType === 'bambu' && !!p.adapterSerial?.trim()
  && (needsAccessCode(p) || !p.bambuCloudToken?.accessToken);

/**
 * Gives managed Bambu printers without an access code or cloud session the ones of the
 * Bambu account they are bound to, using a session the bridge already holds. Calls
 * `onUpdate` for printers that got a code (they reconnect). Returns how many changed.
 */
export async function fillFromCloud(onUpdate: (p: PrinterConfig) => void, deps: CloudCodeDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now;
  const sessionFor = deps.sessionFor ?? defaultSessionFor;
  const cfg = loadMultiConfig();
  const due = cfg.printers.filter(p => wants(p) && now() - (lastLookup.get(p.adapterSerial.toUpperCase()) ?? -Infinity) >= CLOUD_LOOKUP_RETRY_MS);
  if (!due.length) return 0;
  const sessions = new Set<DeviceLister>();
  for (const p of cfg.printers) {
    const s = p.bambuCloudToken?.accessToken ? sessionFor(p) : null;
    if (s) sessions.add(s);
  }
  if (!sessions.size) return 0;
  for (const p of due) lastLookup.set(p.adapterSerial.toUpperCase(), now());

  const found = new Map<string, { code: string; token: CloudToken }>();
  for (const s of sessions) {
    const devices = await s.listDevices();
    for (const d of devices ?? []) {
      const serial = d.serial.toUpperCase();
      if (!found.has(serial)) found.set(serial, { code: d.accessCode.trim(), token: { ...s.current } });
    }
  }
  if (!found.size) return 0;

  // The lookup took a while: apply to the current config, not the one read above.
  const fresh = loadMultiConfig();
  const reconnect: PrinterConfig[] = [];
  let changed = 0;
  for (const p of fresh.printers) {
    if (!wants(p)) continue;
    const hit = found.get(p.adapterSerial.toUpperCase());
    if (!hit) continue;
    let touched = false;
    if (needsAccessCode(p) && hit.code) {
      p.adapterApiKey = hit.code;
      reconnect.push(p);
      touched = true;
    }
    if (!p.bambuCloudToken?.accessToken) {
      p.bambuCloudToken = { ...hit.token };
      touched = true;
    }
    if (touched) {
      changed++;
      lastLookup.delete(p.adapterSerial.toUpperCase());
    }
  }
  if (!changed) return 0;
  saveMultiConfig(fresh);
  log.info(`Bambu Cloud: ${changed} Drucker ergänzt (${reconnect.length} Access-Code(s) aus dem Konto übernommen)`);
  for (const p of reconnect) onUpdate(p);
  return changed;
}
