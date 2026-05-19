import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const FLOWNT_EDGE_URL = 'https://qvlmidtunxthqsxfutkq.supabase.co/functions/v1';

export interface BridgeConfig {
  flowntAuthToken: string;
  adapterType: 'bambu' | 'moonraker';
  adapterUrl: string;
  adapterApiKey: string;
  adapterSerial: string;
  pollingIntervalMs: number;
}

const CONFIG_DIR  = join(homedir(), '.flownt-bridge');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): BridgeConfig | null {
  if (!configExists()) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as BridgeConfig;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: BridgeConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}
