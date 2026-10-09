import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Flownt backend (Supabase Edge Functions). Self-hosted Flownt instances point the
// bridge at their own project via FLOWNT_EDGE_URL; the default is flownt.app.
const DEFAULT_EDGE_URL = 'https://qvlmidtunxthqsxfutkq.supabase.co/functions/v1';
export const FLOWNT_EDGE_URL = (process.env.FLOWNT_EDGE_URL?.trim() || DEFAULT_EDGE_URL).replace(/\/+$/, '');

export type BridgeLang = 'de' | 'en';

export type SmartPlugType = 'shelly';

export interface PrinterConfig {
  id: string;
  name: string;
  flowntAuthToken: string;
  adapterType: 'bambu' | 'moonraker' | 'prusa';
  adapterUrl: string;
  adapterApiKey: string;
  adapterSerial: string;
  pollingIntervalMs: number;
  cameraTransport?: 'auto' | 'jpeg' | 'rtsp';
  bambuCloudEmail?: string;
  bambuCloudPassword?: string;
  /** Bambu Cloud session of the account the printer is bound to, delivered encrypted by
   *  Flownt (secret `bambu_cloud_token`). Used to read the cloud task history for jobs
   *  whose print file is not readable. Kept up to date when the token is renewed. */
  bambuCloudToken?: { accessToken: string; refreshToken?: string; expiresAt?: number };
  // Optionaler Smart-Plug zur echten Strommessung (Shelly Gen1 + Gen2, Auto-Erkennung).
  smartPlugType?: SmartPlugType;
  smartPlugUrl?: string; // IP/Host des Shelly im LAN, z. B. "192.168.178.50"
  // Set for printers assigned centrally in Flownt (paired bridge, see link/sync.ts).
  // Managed printers are added, updated and removed by the sync; others are left alone.
  flowntPrinterId?: string;
  managed?: boolean;
}

export type BridgeRole = 'monitor' | 'label' | 'both';

export interface MultiConfig {
  version: 2;
  language: BridgeLang;
  printers: PrinterConfig[];
  role?: BridgeRole;       // was diese Bridge-Instanz tun soll (Web-UI-Rollenwahl, Phase 2)
  labelPrinter?: string;   // ausgewählter Etikettendrucker (System-/CUPS-Name)
  // Pairing with Flownt (bridge-sync). The token authenticates this bridge.
  link?: { bridgeId: string; bridgeToken: string; name: string; pairedAt: string };
  // Extra browser origins allowed to call the bridge (e.g. a self-hosted Flownt app),
  // added in the setup UI. Defaults and FLOWNT_ALLOWED_ORIGINS apply in addition.
  allowedOrigins?: string[];
  // Access codes of printers recently removed by the sync (24 h, see link/tombstones.ts).
  removedSecrets?: Array<{ flowntPrinterId: string; adapterSerial?: string; adapterApiKey: string; removedAt: string }>;
}

export const CONFIG_DIR  = join(homedir(), '.flownt-bridge');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function migrate(raw: Record<string, unknown>): MultiConfig {
  const printer: PrinterConfig = {
    id: randomUUID(),
    name: raw.adapterType === 'bambu' ? 'Bambu Lab Drucker' : 'Klipper Drucker',
    flowntAuthToken: (raw.flowntAuthToken ?? '') as string,
    adapterType: (raw.adapterType ?? 'bambu') as 'bambu' | 'moonraker' | 'prusa',
    adapterUrl: (raw.adapterUrl ?? '') as string,
    adapterApiKey: (raw.adapterApiKey ?? '') as string,
    adapterSerial: (raw.adapterSerial ?? '') as string,
    pollingIntervalMs: (raw.pollingIntervalMs ?? 30_000) as number,
    ...(raw.bambuCloudEmail    ? { bambuCloudEmail:    raw.bambuCloudEmail    as string } : {}),
    ...(raw.bambuCloudPassword ? { bambuCloudPassword: raw.bambuCloudPassword as string } : {}),
  };
  return {
    version: 2,
    language: 'de',
    printers: raw.flowntAuthToken ? [printer] : [],
  };
}

const DEFAULT_POLLING_MS = 30_000;
const MIN_POLLING_MS = 5_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Hand-edited files: an access code written as a number is still the code.
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Brings a v2 config read from disk (possibly edited by hand) into the shape the code
 * relies on: string fields are strings, optional strings are strings or absent, the
 * polling interval is usable (0 or missing made the bridge loop spin; at least 5 s),
 * lists are lists.
 * Unknown adapter types stay: index.ts reports them as that printer's error.
 */
export function normalizeConfig(raw: Record<string, unknown>): MultiConfig {
  const printers = (Array.isArray(raw.printers) ? raw.printers : []).filter(isObj).map((p, i) => {
    const polling = Number(p.pollingIntervalMs);
    const out: PrinterConfig = {
      ...(p as unknown as PrinterConfig),
      id: str(p.id) || `printer-${i + 1}`,
      name: str(p.name),
      flowntAuthToken: str(p.flowntAuthToken),
      adapterUrl: str(p.adapterUrl),
      adapterApiKey: str(p.adapterApiKey),
      adapterSerial: str(p.adapterSerial),
      pollingIntervalMs: Number.isFinite(polling) && polling > 0 ? Math.max(polling, MIN_POLLING_MS) : DEFAULT_POLLING_MS,
    };
    for (const k of ['bambuCloudEmail', 'bambuCloudPassword', 'smartPlugUrl'] as const) {
      const v = optStr(p[k]);
      if (v) out[k] = v; else delete out[k];
    }
    return out;
  });
  const cfg: MultiConfig = { ...(raw as unknown as MultiConfig), version: 2, language: raw.language === 'en' ? 'en' : 'de', printers };
  const origins = Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins.filter((o): o is string => typeof o === 'string') : [];
  if (origins.length) cfg.allowedOrigins = origins; else delete cfg.allowedOrigins;
  if (Array.isArray(raw.removedSecrets)) cfg.removedSecrets = raw.removedSecrets.filter(isObj) as unknown as MultiConfig['removedSecrets'];
  else delete cfg.removedSecrets;
  return cfg;
}

export function loadMultiConfig(): MultiConfig {
  if (!existsSync(CONFIG_FILE)) return { version: 2, language: 'de', printers: [] };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    if (!isObj(parsed)) throw new Error('not a JSON object');
    raw = parsed;
  } catch (e) {
    // Never silently fall back to an empty config: the next save would overwrite the
    // user's printers. Keep the broken file next to it and start empty. If it cannot be
    // moved aside, stop here rather than run with an empty config that a save would
    // write over the only copy.
    const backup = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(CONFIG_FILE, backup);
    } catch (moveErr) {
      throw new Error(`config.json unreadable (${(e as Error).message}) and could not be moved aside (${(moveErr as Error).message}) — fix or remove ${CONFIG_FILE}`);
    }
    console.error(`[flownt-bridge] config.json unreadable (${(e as Error).message}) — moved to ${backup}`);
    return { version: 2, language: 'de', printers: [] };
  }
  if (raw.version === 2) return normalizeConfig(raw);
  // Legacy single-printer format → auto-migrate and persist
  const cfg = normalizeConfig(migrate(raw) as unknown as Record<string, unknown>);
  saveMultiConfig(cfg);
  return cfg;
}

export function saveMultiConfig(cfg: MultiConfig): void {
  // The file holds the Flownt token and printer access codes: owner-only
  // permissions, and an atomic replace so a crash never leaves half a file. Each save
  // writes its own temp file, so two writers never interleave.
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* keep the original error */ }
    throw e;
  }
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* e.g. Windows */ }
}

export function newPrinterId(): string {
  return randomUUID();
}

// A Bambu printer can be configured before its LAN access code is known (e.g. created
// from Flownt); it then waits instead of connecting with an empty code.
export function needsAccessCode(p: PrinterConfig): boolean {
  return p.adapterType === 'bambu' && !p.adapterApiKey?.trim();
}
