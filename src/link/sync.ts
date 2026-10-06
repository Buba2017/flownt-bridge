import { FLOWNT_EDGE_URL, loadMultiConfig, saveMultiConfig, newPrinterId, needsAccessCode, PrinterConfig } from '../config.js';
import type {
  BridgePairRequest, BridgePairResponse, BridgeSyncRequest, BridgeSyncResponse, LinkedPrinterState,
} from '../contract.js';
import { BRIDGE_VERSION } from '../version.js';
import { publicKeyPem, decryptSecret } from './keys.js';
import { discoveredDevices, discoveredIp } from './discovery.js';

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

export function linkStatus() {
  return { link: loadMultiConfig().link ?? null, lastSyncAt, lastSyncError };
}

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
  console.log(`[link] Mit Flownt gekoppelt als „${res.name}" (${res.bridge_id})`);
  return res;
}

export function unpair(): void {
  const cfg = loadMultiConfig();
  delete cfg.link;
  saveMultiConfig(cfg);
}

function reconcile(res: BridgeSyncResponse, cb: LinkCallbacks): void {
  const cfg = loadMultiConfig();
  const added: PrinterConfig[] = [];
  const updated: PrinterConfig[] = [];
  const removed: string[] = [];
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
  const keep = new Set(remote.map(r => r.printer_id));
  cfg.printers = cfg.printers.filter(p => {
    if (p.managed && p.flowntPrinterId && !keep.has(p.flowntPrinterId)) { removed.push(p.id); return false; }
    return true;
  });

  // Delivered secrets → local config; acknowledged on the next sync.
  for (const s of res.secrets) {
    const local = cfg.printers.find(p => p.flowntPrinterId === s.printer_id);
    try {
      const code = decryptSecret(s.ciphertext).trim();
      if (local && code && local.adapterApiKey !== code) {
        local.adapterApiKey = code;
        if (!added.includes(local) && !updated.includes(local)) updated.push(local);
      }
    } catch (e) {
      console.error(`[link] Secret ${s.id} nicht entschlüsselbar: ${(e as Error).message}`);
    }
    ackQueue.push(s.id);
  }

  if (added.length || updated.length || removed.length) {
    saveMultiConfig(cfg);
    for (const id of removed) cb.onDelete(id);
    for (const p of added) cb.onAdd(p);
    for (const p of updated) cb.onUpdate(p);
    console.log(`[link] Sync: +${added.length} ~${updated.length} -${removed.length} Drucker, ${res.secrets.length} Code(s) übernommen`);
  }
}

async function syncOnce(cb: LinkCallbacks): Promise<void> {
  const cfg = loadMultiConfig();
  if (!cfg.link) return;
  const printers: LinkedPrinterState[] = cfg.printers
    .filter(p => p.flowntPrinterId)
    .map(p => ({ printer_id: p.flowntPrinterId!, has_access_code: !needsAccessCode(p), connected: cb.isConnected(p.id) }));
  const acked = ackQueue;
  const req: BridgeSyncRequest = {
    action: 'sync', bridge_token: cfg.link.bridgeToken, bridge_version: BRIDGE_VERSION,
    discovered: discoveredDevices(), printers, acked_secrets: acked,
  };
  const res = await post<BridgeSyncResponse>(req);
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
      console.warn(`[link] Sync fehlgeschlagen: ${lastSyncError}`);
    }
    setTimeout(tick, SYNC_INTERVAL_MS);
  };
  void tick();
}

/** Run one sync immediately (e.g. right after pairing). */
export function syncNow(cb: LinkCallbacks): Promise<void> {
  return syncOnce(cb).catch(e => { lastSyncError = (e as Error).message; });
}
