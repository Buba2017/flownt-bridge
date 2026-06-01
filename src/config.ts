import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export const FLOWNT_EDGE_URL = 'https://qvlmidtunxthqsxfutkq.supabase.co/functions/v1';

export type BridgeLang = 'de' | 'en';

export interface PrinterConfig {
  id: string;
  name: string;
  flowntAuthToken: string;
  adapterType: 'bambu' | 'moonraker';
  adapterUrl: string;
  adapterApiKey: string;
  adapterSerial: string;
  pollingIntervalMs: number;
  bambuCloudEmail?: string;
  bambuCloudPassword?: string;
}

export interface MultiConfig {
  version: 2;
  language: BridgeLang;
  printers: PrinterConfig[];
}

const CONFIG_DIR  = join(homedir(), '.flownt-bridge');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function migrate(raw: Record<string, unknown>): MultiConfig {
  const printer: PrinterConfig = {
    id: randomUUID(),
    name: raw.adapterType === 'bambu' ? 'Bambu Lab Drucker' : 'Klipper Drucker',
    flowntAuthToken: (raw.flowntAuthToken ?? '') as string,
    adapterType: (raw.adapterType ?? 'bambu') as 'bambu' | 'moonraker',
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
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    if (raw.version === 2) return raw as unknown as MultiConfig;
    // Legacy single-printer format → auto-migrate and persist
    const cfg = migrate(raw);
    saveMultiConfig(cfg);
    return cfg;
  } catch {
    return { version: 2, language: 'de', printers: [] };
  }
}

export function saveMultiConfig(cfg: MultiConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

export function newPrinterId(): string {
  return randomUUID();
}
