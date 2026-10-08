import { FLOWNT_EDGE_URL, loadMultiConfig, saveMultiConfig, newPrinterId, needsAccessCode, PrinterConfig } from '../config.js';
import type {
  BridgePairRequest, BridgePairResponse, BridgeSyncRequest, BridgeSyncResponse, LinkedPrinterState,
} from '../contract.js';
import { BRIDGE_VERSION } from '../version.js';
import { publicKeyPem, decryptSecret } from './keys.js';
import { discoveredDevices, discoveredIp } from './discovery.js';
import { RemovalGuard, type PendingRemoval } from './removal-guard.js';
import { addTombstone, pruneTombstones, takeTombstone } from './tombstones.js';
import { createLogger } from '../logger.js';

const log = createLogger('link');

// Link to Flownt (edge function bridge-sync): pairing once, then a periodic sync that
// applies the printers assigned to this bridge in Flownt, decrypts delivered access
// codes and reports discovered devices and per-printer state.

export interface LinkCallbacks {
  onAdd(cfg: PrinterConfig): void;
  onUpdate(cfg: PrinterConfig): void;
  onDelete(id: string): void;
  /** Whether a printer is currently connected (for the state report). */
  isConnected(id: string): boolean;
}

const SYNC_INTERVAL_MS = 30_000;
let lastSyncAt: Date | null = null;
let lastSyncError: string | null = null;
let ackQueue: string[] = [];
const removalGuard = new RemovalGuard();

export function linkStatus(): {
  link: NonNullable<ReturnType<typeof loadMultiConfig>['link']> | null;
  lastSyncAt: Date | null; lastSyncError: string | null; pendingRemoval: PendingRemoval | null;
} {
  return { link: loadMultiConfig().link ?? null, lastSyncAt, lastSyncError, pendingRemoval: removalGuard.status() };
}

/** Test hook: forget the pending mass-removal state. */
export function resetRemovalGuard(): void { removalGuard.reset(); }

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch(`${FLOWNT_EDGE_URL}/bridge-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `bridge-sync ${res.status}`);
  return data;
}

export async function pair(code: string, name?: string): Promise<BridgePairResponse> {
  const req: BridgePairRequest = {
    action: 'pair', pairing_code: code.trim(), public_key: publicKeyPem(),
    name: name?.trim() || undefined, bridge_version: BRIDGE_VERSION,
  };
  const res = await post<BridgePairResponse>(req);
  const cfg = loadMultiConfig();
  cfg.link = { bridgeId: res.bridge_id, bridgeToken: res.bridge_token, name: res.name, pairedAt: new Date().toISOString() };
  saveMultiConfig(cfg);
  log.info(`Mit Flownt gekoppelt als „${res.name}" (${res.bridge_id})`);
  return res;
}

export function unpair(): void {
  const cfg = loadMultiConfig();
  delete cfg.link;
  saveMultiConfig(cfg);
}

/** `{"access_token","refresh_token","expires_at"}` from Flownt → config shape; null if unusable. */
export function parseCloudToken(json: string): PrinterConfig['bambuCloudToken'] | null {
  const x = JSON.parse(json) as Record<string, unknown>;
  const accessToken = typeof x.access_token === 'string' ? x.access_token : '';
  if (!accessToken) return null;
  const expires = typeof x.expires_at === 'string' ? Date.parse(x.expires_at) : typeof x.expires_at === 'number' ? x.expires_at : NaN;
  return {
    accessToken,
    ...(typeof x.refresh_token === 'string' && x.refresh_token ? { refreshToken: x.refresh_token } : {}),
    ...(Number.isFinite(expires) ? { expiresAt: expires } : {}),
  };
}

/** Apply a sync response to the local config. Exported for tests. */
export function reconcile(res: BridgeSyncResponse, cb: LinkCallbacks, guard: RemovalGuard = removalGuard): void {
  const cfg = loadMultiConfig();
  const added: PrinterConfig[] = [];
  const updated: PrinterConfig[] = [];
  const removed: string[] = [];
  let dirty = pruneTombstones(cfg);
  const remote = res.printers.filter(r => r.enabled);

  for (const r of remote) {
    // Bambu IPs come from DHCP: a fresh LAN announcement for the serial wins.
    const url = (r.adapter_type === 'bambu' && discoveredIp(r.device_serial)) || r.adapter_url;
    const local = cfg.printers.find(p => p.flowntPrinterId === r.printer_id)
      ?? cfg.printers.find(p => p.flowntAuthToken === r.auth_token);
    if (local) {
      const changed = local.name !== r.name || local.adapterType !== r.adapter_type || local.adapterUrl !== url
        || local.adapterSerial !== r.device_serial || local.flowntAuthToken !== r.auth_token
        || local.flowntPrinterId !== r.printer_id || !local.managed;
      if (changed) {
        Object.assign(local, {
          name: r.name, adapterType: r.adapter_type, adapterUrl: url, adapterSerial: r.device_serial,
          flowntAuthToken: r.auth_token, flowntPrinterId: r.printer_id, managed: true,
        });
        updated.push(local);
      }
    } else {
      const p: PrinterConfig = {
        id: newPrinterId(), name: r.name, flowntAuthToken: r.auth_token, adapterType: r.adapter_type,
        adapterUrl: url, adapterApiKey: '', adapterSerial: r.device_serial, pollingIntervalMs: 30_000,
        flowntPrinterId: r.printer_id, managed: true,
      };
      cfg.printers.push(p);
      added.push(p);
    }
  }

  // Removals: managed printers the backend no longer lists. A mass removal (all or more
  // than half) is held until confirmed by repeated syncs — see removal-guard.ts.
  const keep = new Set(remote.map(r => r.printer_id));
  const managed = cfg.printers.filter(p => p.managed && p.flowntPrinterId && !added.includes(p));
  const missing = managed.filter(p => !keep.has(p.flowntPrinterId!)).map(p => p.flowntPrinterId!);
  const decision = guard.decide(missing, managed.length);
  if (decision.held.length) {
    const pending = guard.status();
    // Log the first sighting and then every 10th sync, not every 30 s.
    if (pending && (pending.confirmations === 1 || pending.confirmations % 10 === 0)) {
      log.warn(`Sync would remove ${decision.held.length} of ${managed.length} printers — keeping them until `
        + `the removal is confirmed (seen ${pending.confirmations}× since ${pending.since.toISOString()}).`);
    }
  } else if (decision.confirmed) {
    log.warn(`Removal of ${decision.allowed.length} printers confirmed by repeated syncs — applying it.`);
  }
  const removeIds = new Set(decision.allowed);
  cfg.printers = cfg.printers.filter(p => {
    if (p.managed && p.flowntPrinterId && removeIds.has(p.flowntPrinterId)) {
      // Keep the access code for 24 h in case the printer comes back.
      addTombstone(cfg, { flowntPrinterId: p.flowntPrinterId, adapterSerial: p.adapterSerial, adapterApiKey: p.adapterApiKey });
      removed.push(p.id);
      return false;
    }
    return true;
  });

  // Delivered secrets → local config; acknowledged on the next sync. A code for a
  // printer this bridge does not have (yet) is parked like a removed printer's code.
  for (const s of res.secrets) {
    const local = cfg.printers.find(p => p.flowntPrinterId === s.printer_id);
    if (s.kind === 'bambu_cloud_token') {
      // Cloud session for the task history (material of jobs whose file is unreadable).
      try {
        const token = parseCloudToken(decryptSecret(s.ciphertext));
        // Saved only: the printer connection does not depend on it (the material lookup
        // reads the current config), so no reconnect of the printer.
        if (local && token && JSON.stringify(local.bambuCloudToken) !== JSON.stringify(token)) {
          local.bambuCloudToken = token;
          dirty = true;
        }
      } catch (e) {
        log.error(`Secret ${s.id} nicht entschlüsselbar: ${(e as Error).message}`);
      }
      ackQueue.push(s.id);
      continue;
    }
    try {
      const code = decryptSecret(s.ciphertext).trim();
      if (local && code && local.adapterApiKey !== code) {
        local.adapterApiKey = code;
        if (!added.includes(local) && !updated.includes(local)) updated.push(local);
      } else if (!local && code) {
        addTombstone(cfg, { flowntPrinterId: s.printer_id, adapterApiKey: code });
        dirty = true;
      }
    } catch (e) {
      log.error(`Secret ${s.id} nicht entschlüsselbar: ${(e as Error).message}`);
    }
    ackQueue.push(s.id);
  }

  // Printers still without a code get a parked one back (re-added after a removal).
  let restored = 0;
  for (const p of cfg.printers) {
    if (!p.managed || !needsAccessCode(p)) continue;
    const code = takeTombstone(cfg, p);
    if (!code) continue;
    p.adapterApiKey = code;
    restored++;
    dirty = true;
    if (!added.includes(p) && !updated.includes(p)) updated.push(p);
  }

  if (added.length || updated.length || removed.length || dirty) {
    saveMultiConfig(cfg);
    for (const id of removed) cb.onDelete(id);
    for (const p of added) cb.onAdd(p);
    for (const p of updated) cb.onUpdate(p);
    if (added.length || updated.length || removed.length) {
      log.info(`Sync: +${added.length} ~${updated.length} -${removed.length} Drucker, ${res.secrets.length} Code(s) übernommen`
        + (restored ? `, ${restored} Code(s) wiederhergestellt` : ''));
    }
  }
}

async function syncOnce(cb: LinkCallbacks): Promise<void> {
  const cfg = loadMultiConfig();
  if (!cfg.link) return;
  const printers: LinkedPrinterState[] = cfg.printers
    .filter(p => p.flowntPrinterId)
    .map(p => ({
      printer_id: p.flowntPrinterId!, has_access_code: !needsAccessCode(p), connected: cb.isConnected(p.id),
      has_cloud_token: !!p.bambuCloudToken?.accessToken,
    }));
  const acked = ackQueue;
  const req: BridgeSyncRequest = {
    action: 'sync', bridge_token: cfg.link.bridgeToken, bridge_version: BRIDGE_VERSION,
    // Public HTTPS address of this bridge (e.g. a tunnel exposing /camera); lets Flownt
    // open the live camera without asking the user for the bridge address.
    public_url: process.env.FLOWNT_PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
    discovered: discoveredDevices(), printers, acked_secrets: acked,
  };
  const res = await post<BridgeSyncResponse>(req);
  // A malformed body is a failed sync, never "no printers".
  if (!res || !Array.isArray(res.printers) || !Array.isArray(res.secrets)) throw new Error('bridge-sync: malformed response');
  ackQueue = ackQueue.filter(id => !acked.includes(id));
  reconcile(res, cb);
  lastSyncAt = new Date();
  lastSyncError = null;
}

let loopStarted = false;
export function startSyncLoop(cb: LinkCallbacks): void {
  if (loopStarted) return;
  loopStarted = true;
  const tick = async () => {
    try {
      await syncOnce(cb);
    } catch (e) {
      lastSyncError = (e as Error).message;
      log.warn(`Sync fehlgeschlagen: ${lastSyncError}`);
    }
    setTimeout(tick, SYNC_INTERVAL_MS);
  };
  void tick();
}

/** Run one sync immediately (e.g. right after pairing). */
export function syncNow(cb: LinkCallbacks): Promise<void> {
  return syncOnce(cb).catch(e => { lastSyncError = (e as Error).message; });
}
