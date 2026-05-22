import fetch from 'node-fetch';
import { BridgeConfig, FLOWNT_EDGE_URL } from './config.js';
import { Adapter, PrinterSnapshot } from './adapters/types.js';
import { bridgeState } from './server.js';

async function push(
  cfg: BridgeConfig,
  snapshot: PrinterSnapshot,
  eventType = 'status_update',
  durationMin?: number,
): Promise<void> {
  const body: Record<string, unknown> = {
    auth_token: cfg.flowntAuthToken,
    event_type: eventType,
    printer_status: snapshot.status,
    print_file: snapshot.printFile,
    progress_pct: snapshot.progressPct,
    temp_hotend: snapshot.tempHotend,
    temp_bed: snapshot.tempBed,
    eta_s: snapshot.etaSec,
  };
  if (durationMin != null) body.duration_min = durationMin;
  if (snapshot.amsSlots?.length) body.ams_state = snapshot.amsSlots;
  if (snapshot.activeMqttSlot != null) body.ams_active_slot = snapshot.activeMqttSlot;
  if (snapshot.amsHumidity?.length) body.ams_humidity = snapshot.amsHumidity;

  const res = await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
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
  let prevStatus: PrinterSnapshot['status'] | null = null;
  let printStartedAt: number | null = null;

  while (!isCancelled()) {
    try {
      const snapshot = await adapter.getSnapshot();
      state.snapshot = snapshot;

      // Detect job completion: printing → idle
      let eventType = 'status_update';
      let durationMin: number | undefined;
      if (prevStatus === 'printing' && snapshot.status === 'idle') {
        eventType = 'job_complete';
        if (printStartedAt != null) {
          durationMin = Math.round((Date.now() - printStartedAt) / 60_000);
        }
        printStartedAt = null;
        console.log(`[flownt-bridge] Job abgeschlossen → Drucklog-Eintrag (${durationMin ?? '?'} min)`);
      }
      if (snapshot.status === 'printing' && prevStatus !== 'printing') {
        printStartedAt = Date.now();
      }

      prevStatus = snapshot.status;

      await push(cfg, snapshot, eventType, durationMin);
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
