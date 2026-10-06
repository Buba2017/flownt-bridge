import { release, type as osType } from 'os';
import { strToU8, zipSync } from 'fflate';
import { loadMultiConfig, needsAccessCode, FLOWNT_EDGE_URL, type MultiConfig } from './config.js';
import { CONTRACT_VERSION } from './contract.js';
import { BRIDGE_VERSION } from './version.js';
import { getEventLog } from './events.js';
import { linkStatus } from './link/sync.js';
import { collectHealthProviders } from './health-registry.js';
import { getLogLevel, recentLogLines } from './logger.js';
import type { PrinterBridgeState } from './server.js';

// Health report (GET /healthz) and the support bundle (GET /diagnostics.zip). Neither
// may contain tokens, access codes or passwords.

const startedAt = new Date();
const ageS = (d: Date | null | undefined) => (d ? Math.max(0, Math.round((Date.now() - d.getTime()) / 1000)) : null);

export interface PrinterHealth {
  id: string;
  name: string;
  adapter_type: string;
  managed: boolean;
  running: boolean;
  connected: boolean;
  status: string | null;
  job_state: string | null;
  needs_access_code: boolean;
  /** Seconds since the adapter last produced a snapshot. */
  last_message_age_s: number | null;
  /** Seconds since the last successful push to Flownt. */
  last_push_age_s: number | null;
  error: string | null;
}

export async function healthReport(states: Map<string, PrinterBridgeState>) {
  const cfg = loadMultiConfig();
  const printers: PrinterHealth[] = cfg.printers.map(p => {
    const s = states.get(p.id);
    const snap = s?.snapshot ?? null;
    const connected = !!s?.running && !s.error && !!snap && snap.status !== 'offline';
    return {
      id: p.id,
      name: p.name,
      adapter_type: p.adapterType,
      managed: !!p.managed,
      running: !!s?.running,
      connected,
      status: snap?.status ?? null,
      job_state: snap?.jobState ?? null,
      needs_access_code: needsAccessCode(p),
      last_message_age_s: ageS(s?.lastSnapshotAt),
      last_push_age_s: ageS(s?.lastPushAt),
      error: s?.error ?? null,
    };
  });
  const { link, lastSyncAt, lastSyncError, pendingRemoval } = linkStatus();
  const { outbox = null, ...providers } = await collectHealthProviders();
  const degraded = printers.some(p => p.running && !p.connected) || !!lastSyncError || !!pendingRemoval;
  return {
    status: degraded ? 'degraded' : 'ok',
    bridge_version: BRIDGE_VERSION,
    contract_version: CONTRACT_VERSION,
    node_version: process.version,
    uptime_s: Math.round(process.uptime()),
    started_at: startedAt.toISOString(),
    link: link
      ? {
          paired: true,
          name: link.name,
          last_sync_age_s: ageS(lastSyncAt),
          last_sync_error: lastSyncError,
          pending_removal: pendingRemoval
            ? { printers: pendingRemoval.printerIds.length, since: pendingRemoval.since.toISOString(), confirmations: pendingRemoval.confirmations }
            : null,
        }
      : { paired: false },
    printers,
    outbox,
    providers,
  };
}

// ── Redaction ─────────────────────────────────────────────────────────────────

const REDACTED = '[redacted]';
const redact = (v: string | undefined) => (v ? REDACTED : v);
const maskEmail = (e: string | undefined) => e?.replace(/^(.).*(@.*)$/, '$1***$2');

/** Config without tokens, access codes and passwords (presence stays visible). */
export function redactConfig(cfg: MultiConfig): unknown {
  return {
    ...cfg,
    printers: cfg.printers.map(p => ({
      ...p,
      flowntAuthToken: redact(p.flowntAuthToken),
      adapterApiKey: redact(p.adapterApiKey),
      bambuCloudPassword: redact(p.bambuCloudPassword),
      bambuCloudEmail: maskEmail(p.bambuCloudEmail),
    })),
    link: cfg.link ? { ...cfg.link, bridgeToken: REDACTED } : undefined,
    removedSecrets: cfg.removedSecrets?.map(t => ({ ...t, adapterApiKey: REDACTED })),
  };
}

/** Every secret value currently known to the bridge (for scrubbing free text). */
export function knownSecrets(cfg: MultiConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const values = [
    ...cfg.printers.flatMap(p => [p.flowntAuthToken, p.adapterApiKey, p.bambuCloudPassword]),
    cfg.link?.bridgeToken,
    ...(cfg.removedSecrets ?? []).map(t => t.adapterApiKey),
    env.FLOWNT_BRIDGE_ADMIN_PASSWORD, env.FLOWNT_PAIRING_CODE,
  ];
  return [...new Set(values.filter((v): v is string => !!v && v.trim().length >= 4).map(v => v.trim()))]
    .sort((a, b) => b.length - a.length);
}

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join(REDACTED).split(s.toLowerCase()).join(REDACTED);
  return out
    .replace(/(Bearer\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/(rtsps?:\/\/[^:/\s@]+:)[^@\s]+@/gi, `$1${REDACTED}@`);
}

// ── Bundle ────────────────────────────────────────────────────────────────────

// Environment variables whose values are safe to include; others only as "set".
const SAFE_ENV = ['FLOWNT_EDGE_URL', 'FLOWNT_BRIDGE_HOST', 'FLOWNT_BRIDGE_PORT', 'FLOWNT_ALLOWED_ORIGINS',
  'FLOWNT_CAMERA_ORIGINS', 'FLOWNT_BRIDGE_ALLOWED_HOSTS', 'FLOWNT_PUBLIC_URL', 'FLOWNT_FFMPEG_PATH', 'LOG_LEVEL',
  'FLOWNT_LOG_FILE', 'NODE_ENV'];
const SECRET_ENV = ['FLOWNT_BRIDGE_ADMIN_PASSWORD', 'FLOWNT_PAIRING_CODE'];

export async function buildDiagnosticsZip(states: Map<string, PrinterBridgeState>, env: NodeJS.ProcessEnv = process.env): Promise<Uint8Array> {
  const cfg = loadMultiConfig();
  const secrets = knownSecrets(cfg, env);
  const json = (v: unknown) => strToU8(redactText(JSON.stringify(v, null, 2), secrets) + '\n');
  const versions = {
    bridge_version: BRIDGE_VERSION,
    contract_version: CONTRACT_VERSION,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    os: `${osType()} ${release()}`,
    packaged: !!(process as { pkg?: unknown }).pkg,
    edge_url: FLOWNT_EDGE_URL,
    log_level: getLogLevel(),
    generated_at: new Date().toISOString(),
    env: Object.fromEntries([
      ...SAFE_ENV.filter(k => env[k] !== undefined).map(k => [k, env[k]]),
      ...SECRET_ENV.filter(k => env[k]).map(k => [k, '(set)']),
    ]),
  };
  const events = Object.fromEntries(cfg.printers.map(p => [`${p.name} (${p.id})`,
    getEventLog(p.id).map(e => ({ ts: e.ts.toISOString(), type: e.type, msg: e.msg }))]));
  return zipSync({
    'versions.json': json(versions),
    'health.json': json(await healthReport(states)),
    'config.redacted.json': json(redactConfig(cfg)),
    'events.json': json(events),
    'recent.log': strToU8(redactText(recentLogLines().join('\n'), secrets) + '\n'),
  });
}
