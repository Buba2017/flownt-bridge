import fetch from 'node-fetch';
import { BridgeConfig } from './config.js';
import { Adapter, PrinterSnapshot } from './adapters/types.js';
import { bridgeState } from './server.js';

async function push(cfg: BridgeConfig, snapshot: PrinterSnapshot, eventType = 'status_update'): Promise<void> {
  const res = await fetch(`${cfg.flowntEdgeUrl}/bridge-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: cfg.flowntAuthToken,
      event_type: eventType,
      printer_status: snapshot.status,
      print_file: snapshot.printFile,
      progress_pct: snapshot.progressPct,
      temp_hotend: snapshot.tempHotend,
      temp_bed: snapshot.tempBed,
      eta_s: snapshot.etaSec,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bridge-ingest ${res.status}: ${text}`);
  }
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

export async function runBridge(
  adapter: Adapter,
  cfg: BridgeConfig,
  state: typeof bridgeState,
  isCancelled: () => boolean,
): Promise<void> {
  console.log('[flownt-bridge] Verbindung wird aufgebaut…');

  // Initial heartbeat to verify token
  try {
    await fetch(`${cfg.flowntEdgeUrl}/bridge-ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: cfg.flowntAuthToken, event_type: 'heartbeat' }),
    });
    console.log('[flownt-bridge] Auth OK ✓');
    state.error = null;
  } catch (e) {
    console.error('[flownt-bridge] Heartbeat fehlgeschlagen:', e);
    state.error = 'Keine Verbindung zu Flownt. Bitte Token und Server-URL prüfen.';
  }

  let consecutiveErrors = 0;

  while (!isCancelled()) {
    try {
      const snapshot = await adapter.getSnapshot();
      state.snapshot = snapshot;
      await push(cfg, snapshot);
      state.lastPushAt = new Date();
      state.error = null;
      consecutiveErrors = 0;

      const progress = snapshot.progressPct != null ? ` ${snapshot.progressPct}%` : '';
      const file = snapshot.printFile ? ` "${snapshot.printFile}"` : '';
      console.log(`[flownt-bridge] ${new Date().toISOString()} → ${snapshot.status.toUpperCase()}${file}${progress}`);
    } catch (err) {
      consecutiveErrors++;
      const backoff = Math.min(consecutiveErrors * 5_000, 60_000);
      state.error = `Verbindungsfehler (${consecutiveErrors}×). Nächster Versuch in ${backoff / 1000}s.`;
      console.error(`[flownt-bridge] Fehler (${consecutiveErrors}×):`, err);
      await sleep(backoff);
      continue;
    }

    await sleep(cfg.pollingIntervalMs);
  }
}
