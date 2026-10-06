import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync } from 'fs';
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
  // Optionaler Smart-Plug zur echten Strommessung (Shelly Gen1 + Gen2, Auto-Erkennung).
  smartPlugType?: SmartPlugType;
  smartPlugUrl?: string; // IP/Host des Shelly im LAN, z. B. "192.168.178.50"
}

export type BridgeRole = 'monitor' | 'label' | 'both';

export interface MultiConfig {
  version: 2;
  language: BridgeLang;
  printers: PrinterConfig[];
  role?: BridgeRole;       // was diese Bridge-Instanz tun soll (Web-UI-Rollenwahl, Phase 2)
  labelPrinter?: string;   // ausgewählter Etikettendrucker (System-/CUPS-Name)
}

const CONFIG_DIR  = join(homedir(), '.flownt-bridge');
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

export function loadMultiConfig(): MultiConfig {
  if (!existsSync(CONFIG_FILE)) return { version: 2, language: 'de', printers: [] };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    // Never silently fall back to an empty config: the next save would overwrite
    // the user's printers. Keep the broken file next to it and start empty.
    const backup = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    try { renameSync(CONFIG_FILE, backup); } catch { /* keep going */ }
    console.error(`[flownt-bridge] config.json unreadable (${(e as Error).message}) — moved to ${backup}`);
    return { version: 2, language: 'de', printers: [] };
  }
  if (raw.version === 2) return raw as unknown as MultiConfig;
  // Legacy single-printer format → auto-migrate and persist
  const cfg = migrate(raw);
  saveMultiConfig(cfg);
  return cfg;
}

export function saveMultiConfig(cfg: MultiConfig): void {
  // The file holds the Flownt token and printer access codes: owner-only
  // permissions, and an atomic replace so a crash never leaves half a file.
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, CONFIG_FILE);
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
