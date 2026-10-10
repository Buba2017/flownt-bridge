import { loadMultiConfig, saveMultiConfig, type PrinterConfig } from './config.js';
import { BambuCloudClient, BambuCloudSession, type CloudTaskSource, type CloudToken } from './bambu-cloud.js';

// One cloud client per Bambu account, shared by all printers bound to it, so a token
// refresh happens once and is written back to every printer that carried the old token.

const sessions = new Map<string, BambuCloudSession>();
const legacy = new Map<string, BambuCloudClient>();

function persistRefresh(previous: CloudToken, next: CloudToken): void {
  try {
    const cfg = loadMultiConfig();
    let changed = false;
    for (const p of cfg.printers) {
      if (p.bambuCloudToken && (p.bambuCloudToken.refreshToken ?? p.bambuCloudToken.accessToken)
          === (previous.refreshToken ?? previous.accessToken)) {
        p.bambuCloudToken = { ...next };
        changed = true;
      }
    }
    if (changed) saveMultiConfig(cfg);
  } catch (e) {
    console.error('[bambu-cloud] renewed token not saved:', (e as Error).message);
  }
}

/** The printer's cloud task source: Flownt-delivered token, else e-mail/password, else none. */
export function cloudSourceFor(cfg: PrinterConfig): CloudTaskSource | null {
  const t = cfg.bambuCloudToken;
  if (t?.accessToken) {
    const key = t.refreshToken ?? t.accessToken;
    let s = sessions.get(key);
    if (!s) {
      let last: CloudToken = { ...t };
      s = new BambuCloudSession({ ...t }, next => {
        sessions.delete(last.refreshToken ?? last.accessToken);
        sessions.set(next.refreshToken ?? next.accessToken, s!);
        persistRefresh(last, next);
        last = { ...next };
      });
      sessions.set(key, s);
    }
    return s;
  }
  if (cfg.bambuCloudEmail && cfg.bambuCloudPassword) {
    // Keyed by the password too: a corrected password must not keep the old client.
    const key = `${cfg.bambuCloudEmail.toLowerCase()}\n${cfg.bambuCloudPassword}`;
    let c = legacy.get(key);
    if (!c) { c = new BambuCloudClient(cfg.bambuCloudEmail, cfg.bambuCloudPassword); legacy.set(key, c); }
    return c;
  }
  return null;
}

/** Forgets cached clients (tests, config reset). */
export function resetCloudSources(): void {
  sessions.clear();
  legacy.clear();
}
