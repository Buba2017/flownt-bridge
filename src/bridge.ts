import fetch from 'node-fetch';
import { PrinterConfig, FLOWNT_EDGE_URL } from './config.js';
import type { PrinterBridgeState } from './server.js';
import { Adapter, PrinterSnapshot } from './adapters/types.js';
import { BambuCloudClient } from './bambu-cloud.js';
import { addEvent } from './events.js';

async function push(
  cfg: PrinterConfig,
  snapshot: PrinterSnapshot,
  eventType = 'status_update',
  durationMin?: number,
): Promise<string | undefined> {
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
  if (eventType === 'job_complete') {
    if (snapshot.parsedFilamentWeights?.length) body.filament_weights = snapshot.parsedFilamentWeights;
    if (snapshot.cloudWeightG != null) body.cloud_weight_g = snapshot.cloudWeightG;
  }

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
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return typeof data.print_log_id === 'string' ? data.print_log_id : undefined;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

export async function runBridge(
  adapter: Adapter,
  cfg: PrinterConfig,
  state: PrinterBridgeState,
  isCancelled: () => boolean,
): Promise<void> {
  console.log(`[${cfg.name}] Verbindung wird aufgebaut…`);

  const bambuCloud = (cfg.bambuCloudEmail && cfg.bambuCloudPassword)
    ? new BambuCloudClient(cfg.bambuCloudEmail, cfg.bambuCloudPassword)
    : null;

  // Initial heartbeat to verify token
  try {
    await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: cfg.flowntAuthToken, event_type: 'heartbeat' }),
    });
    console.log(`[${cfg.name}] Auth OK ✓`);
    state.error = null;
    addEvent(cfg.id, 'success', 'Verbindung zu Flownt hergestellt ✓');
  } catch (e) {
    console.error(`[${cfg.name}] Heartbeat fehlgeschlagen:`, e);
    state.error = 'Keine Verbindung zu Flownt. Bitte Token und Server-URL prüfen.';
    addEvent(cfg.id, 'warn', 'Heartbeat fehlgeschlagen — Token oder Verbindung prüfen');
  }

  let consecutiveErrors = 0;
  let prevStatus: PrinterSnapshot['status'] | null = null;
  let printStartedAt: number | null = null;
  let lastActiveSlot: number | null = null;   // physischer AMS-Slot (tray_now), global: unit*4+slot

  while (!isCancelled()) {
    try {
      let snapshot = await adapter.getSnapshot();
      state.snapshot = snapshot;

      // Detect job completion: printing/paused → idle
      let eventType = 'status_update';
      let durationMin: number | undefined;
      if ((prevStatus === 'printing' || prevStatus === 'paused') && snapshot.status === 'idle') {
        eventType = 'job_complete';
        if (printStartedAt != null) {
          durationMin = Math.round((Date.now() - printStartedAt) / 60_000);
        }
        printStartedAt = null;
        console.log(`[${cfg.name}] Job abgeschlossen → Drucklog-Eintrag (${durationMin ?? '?'} min)`);
      }
      // Only (re-)start timer when transitioning into printing from a non-print state
      if (snapshot.status === 'printing' && prevStatus !== 'printing' && prevStatus !== 'paused') {
        printStartedAt = Date.now();
        addEvent(cfg.id, 'info', `Druck gestartet: ${snapshot.printFile ?? '–'}`);
      }

      prevStatus = snapshot.status;

      // Aktiven physischen AMS-Slot während des Drucks merken (0–15; ≥254 = externe Spule, ignorieren)
      if (snapshot.status === 'printing'
          && typeof snapshot.activeMqttSlot === 'number'
          && snapshot.activeMqttSlot >= 0 && snapshot.activeMqttSlot < 16) {
        lastActiveSlot = snapshot.activeMqttSlot;
      }

      // Einfarbiger Druck: Verbrauch dem aktiven physischen AMS-Slot zuordnen statt der
      // Slicer-Filament-id (Bambus slice_info-id ist NICHT der physische Slot).
      if (eventType === 'job_complete' && lastActiveSlot != null
          && snapshot.parsedFilamentWeights?.length === 1) {
        const fw = snapshot.parsedFilamentWeights[0];
        if (fw.filamentIndex !== lastActiveSlot) {
          console.log(`[${cfg.name}] Filament → aktiver AMS-Slot ${lastActiveSlot} (statt Slicer-id ${fw.filamentIndex})`);
          snapshot = { ...snapshot, parsedFilamentWeights: [{ ...fw, filamentIndex: lastActiveSlot }] };
        }
      }

      // Cloud-Gewicht via Bambu API NUR holen, wenn FTPS nichts geliefert hat.
      // Bambus Login verschickt sonst bei jedem Druckende einen Verification-Code per Mail.
      const ftpsGotWeights = (snapshot.parsedFilamentWeights?.length ?? 0) > 0;
      if (eventType === 'job_complete' && bambuCloud && cfg.adapterSerial && !ftpsGotWeights) {
        const cloudWeight = await bambuCloud.getLatestTaskWeightWithRetry(cfg.adapterSerial);
        if (cloudWeight != null) snapshot = { ...snapshot, cloudWeightG: cloudWeight };
      }

      // Backend only accepts: idle, printing, maintenance, offline, error
      // Map "paused" → "printing" (job is still active)
      const pushSnapshot: PrinterSnapshot = snapshot.status === 'paused'
        ? { ...snapshot, status: 'printing' }
        : snapshot;

      const printLogId = await push(cfg, pushSnapshot, eventType, durationMin);
      state.lastPushAt = new Date();
      state.error = null;
      consecutiveErrors = 0;
      if (eventType === 'job_complete') {
        const idHint = printLogId ? ` (${printLogId.slice(0, 8)}…)` : '';
        addEvent(cfg.id, 'success', `Drucklog erstellt${idHint}: ${snapshot.printFile ?? '–'}`);
      }

      const progress = snapshot.progressPct != null ? ` ${snapshot.progressPct}%` : '';
      const file = snapshot.printFile ? ` "${snapshot.printFile}"` : '';
      console.log(`[${cfg.name}] ${new Date().toISOString()} → ${snapshot.status.toUpperCase()}${file}${progress}`);
    } catch (err) {
      consecutiveErrors++;
      const backoff = Math.min(consecutiveErrors * 5_000, 60_000);
      state.error = `Verbindungsfehler (${consecutiveErrors}×). Nächster Versuch in ${backoff / 1000}s.`;
      console.error(`[${cfg.name}] Fehler (${consecutiveErrors}×):`, err);
      if (consecutiveErrors === 1) addEvent(cfg.id, 'warn', `Verbindungsfehler: ${String(err).slice(0, 80)}`);
      await sleep(backoff);
      continue;
    }

    await sleep(cfg.pollingIntervalMs);
  }
}
