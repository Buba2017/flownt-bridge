import { PrinterConfig } from './config.js';
import type { PrinterBridgeState } from './server.js';
import { Adapter, PrinterSnapshot } from './adapters/types.js';
import { CONTRACT_VERSION, EventType, IngestBody, MaterialLine } from './contract.js';
import { BRIDGE_VERSION } from './version.js';
import { BambuCloudClient } from './bambu-cloud.js';
import { ShellyClient } from './smartplug/shelly.js';
import { addEvent } from './events.js';
import { defaultSender, getOutbox, Outbox, Sender } from './outbox.js';
import { JobEnd, JobSessionStore, JobTracker } from './job-session.js';
import { isTrackedSlot, resolveMaterials, slotLabel } from './job-materials.js';

// Last preview delivered per printer config (object identity = one fetch of one job).
const sentPreviews = new Map<string, PrinterSnapshot['printPreview']>();

/** Injection points for tests; production uses the defaults. */
export interface BridgeDeps {
  send?: Sender;
  outbox?: Outbox;
  sessions?: JobSessionStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Fields every push carries: identity, version and the live printer state. */
function baseBody(cfg: PrinterConfig, snapshot: PrinterSnapshot, eventType: EventType): IngestBody {
  // Backend only accepts: idle, printing, maintenance, offline, error — paused → printing
  const status = snapshot.status === 'paused' ? 'printing' : snapshot.status;
  const body: IngestBody = {
    auth_token: cfg.flowntAuthToken,
    event_type: eventType,
    bridge_version: BRIDGE_VERSION,
    contract_version: CONTRACT_VERSION,
    printer_status: status,
    print_file: snapshot.printFile,
    progress_pct: snapshot.progressPct,
    temp_hotend: snapshot.tempHotend,
    temp_bed: snapshot.tempBed,
    eta_s: snapshot.etaSec,
  };
  if (snapshot.powerW != null) body.live_power_w = snapshot.powerW;
  if (snapshot.amsSlots?.length) body.ams_state = snapshot.amsSlots;
  if (snapshot.activeMqttSlot != null) body.ams_active_slot = snapshot.activeMqttSlot;
  if (snapshot.amsHumidity?.length) body.ams_humidity = snapshot.amsHumidity;
  if (snapshot.amsUnits?.length) body.ams_units = snapshot.amsUnits;
  if (snapshot.jobState) body.job_state = snapshot.jobState;
  if (snapshot.hms) body.hms = snapshot.hms;
  if (snapshot.printError !== undefined) body.print_error = snapshot.printError;
  return body;
}

async function pushStatus(cfg: PrinterConfig, snapshot: PrinterSnapshot, send: Sender): Promise<void> {
  const body = baseBody(cfg, snapshot, 'status_update');
  // The preview is sent once per job (the backend keeps it until the next job).
  if (snapshot.printPreview && sentPreviews.get(cfg.id) !== snapshot.printPreview) {
    body.print_preview = { print_file: snapshot.printPreview.printFile, png_base64: snapshot.printPreview.png.toString('base64') };
  }
  const res = await send(body);
  if (res.status < 200 || res.status >= 300) throw new Error(`bridge-ingest ${res.status}: ${(res.text ?? '').slice(0, 200)}`);
  if (body.print_preview && snapshot.printPreview) sentPreviews.set(cfg.id, snapshot.printPreview);
}

/** Terminal event body for a finished/failed job, built from its session. */
async function buildTerminalBody(
  cfg: PrinterConfig, snapshot: PrinterSnapshot, end: JobEnd,
  energyWh: number | null, bambuCloud: BambuCloudClient | null,
): Promise<IngestBody> {
  const s = end.session;
  const eventType: EventType = end.outcome === 'completed' ? 'job_complete' : 'job_failed';
  const body = baseBody(cfg, { ...snapshot, printFile: snapshot.printFile ?? s.printFile }, eventType);
  body.print_file = s.printFile ?? body.print_file;
  if (s.lastProgressPct != null) body.progress_pct = s.lastProgressPct;
  body.source_job_id = s.sourceJobId;
  body.duration_min = Math.max(0, Math.round((end.finishedAt - s.startedAt) / 60_000));

  // Measured energy = meter(end) − meter(start) — also useful for aborted jobs.
  if (s.energyStartWh != null && energyWh != null) {
    const usedWh = energyWh - s.energyStartWh;
    if (usedWh >= 0 && usedWh < 100_000) { // guard against meter reset / outliers
      body.energy_wh = usedWh;
      addEvent(cfg.id, 'info', `Stromverbrauch: ${(usedWh / 1000).toFixed(3)} kWh`);
    }
  }

  if (eventType === 'job_complete') {
    const resolved = resolveMaterials(s.parsedFilamentWeights, {
      mapping: s.filamentMapping, activeSlot: s.lastActiveSlot, amsSlots: snapshot.amsSlots?.length ? snapshot.amsSlots : s.amsSlots,
    });
    for (const n of resolved.notes) addEvent(cfg.id, n.type, n.msg);
    if (resolved.weights.length) {
      // Per material line the source-abstracted slot reference; filamentIndex stays as the
      // compat field the backend reads.
      body.filament_weights = resolved.weights.map((fw): MaterialLine => ({
        filamentIndex: fw.filamentIndex,
        grams: fw.grams,
        color: fw.color,
        slotRef: { source: resolved.slotSource, value: fw.filamentIndex },
        measureSource: 'slicer_file',
      }));
    }
    // Bambu cloud weight only when the print file gave nothing (its login mails a code).
    if (!resolved.weights.length && bambuCloud && cfg.adapterSerial) {
      const cloudWeight = await bambuCloud.getLatestTaskWeightWithRetry(cfg.adapterSerial);
      if (cloudWeight != null) body.cloud_weight_g = cloudWeight;
    }
  }
  return body;
}

export async function runBridge(
  adapter: Adapter,
  cfg: PrinterConfig,
  state: PrinterBridgeState,
  isCancelled: () => boolean,
  deps: BridgeDeps = {},
): Promise<void> {
  const send = deps.send ?? defaultSender;
  const outbox = deps.outbox ?? getOutbox();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  console.log(`[${cfg.name}] Verbindung wird aufgebaut…`);

  const bambuCloud = (cfg.bambuCloudEmail && cfg.bambuCloudPassword)
    ? new BambuCloudClient(cfg.bambuCloudEmail, cfg.bambuCloudPassword)
    : null;

  const smartPlug = (cfg.smartPlugType === 'shelly' && cfg.smartPlugUrl)
    ? new ShellyClient(cfg.smartPlugUrl)
    : null;
  if (smartPlug) addEvent(cfg.id, 'info', `Smart-Plug aktiv: ${cfg.smartPlugUrl}`);

  // Initial heartbeat to verify token
  try {
    const heartbeat: IngestBody = { auth_token: cfg.flowntAuthToken, event_type: 'heartbeat', bridge_version: BRIDGE_VERSION, contract_version: CONTRACT_VERSION };
    const res = await send(heartbeat);
    // A rejected token (401) or wrong backend URL (404) must not be reported as OK.
    if (res.status < 200 || res.status >= 300) throw new Error(`bridge-ingest ${res.status}: ${(res.text ?? '').slice(0, 200)}`);
    console.log(`[${cfg.name}] Auth OK ✓`);
    state.error = null;
    addEvent(cfg.id, 'success', 'Verbindung zu Flownt hergestellt ✓');
  } catch (e) {
    console.error(`[${cfg.name}] Heartbeat fehlgeschlagen:`, e);
    state.error = 'Keine Verbindung zu Flownt. Bitte Token und Server-URL prüfen.';
    addEvent(cfg.id, 'warn', `Heartbeat fehlgeschlagen — Token oder Verbindung prüfen (${(e as Error)?.message ?? e})`);
  }

  // Job start, energy start reading, mapping and weights live in a persisted session, so
  // a restart or reconnect mid-print keeps them (see job-session.ts).
  const tracker = new JobTracker(cfg.id, deps.sessions ?? new JobSessionStore(), now);
  let consecutiveErrors = 0;
  let lastEnergyWh: number | null = null;     // last smart-plug meter reading (Wh)
  let lastLoggedSlot: number | null = tracker.session?.lastActiveSlot ?? null;

  while (!isCancelled()) {
    try {
      let snapshot = await adapter.getSnapshot();

      // Smart-Plug (Shelly): Momentanleistung lesen und in den Snapshot mergen.
      // Fehlertolerant — ein nicht erreichbarer Plug darf den Druckerstatus nicht stören.
      if (smartPlug) {
        const reading = await smartPlug.read();
        if (reading) {
          snapshot = { ...snapshot, powerW: Math.round(reading.powerW) };
          lastEnergyWh = reading.energyWh;
        }
      }

      state.snapshot = snapshot;

      // Job start / end. The terminal event goes to the persistent outbox first; only
      // then is the session closed — a failed push can no longer lose a job end.
      for (let i = 0; i < 2; i++) {
        const { ended, started } = tracker.observe(snapshot, lastEnergyWh);
        if (started) {
          lastLoggedSlot = null;
          addEvent(cfg.id, 'info', `Druck gestartet: ${started.printFile ?? '–'}`);
        }
        if (!ended) break;
        const body = await buildTerminalBody(cfg, snapshot, ended, lastEnergyWh, bambuCloud);
        outbox.enqueue(cfg.id, cfg.name, body);
        tracker.endJob();
        if (body.event_type === 'job_failed') {
          addEvent(cfg.id, 'warn', `Druck ${ended.outcome === 'cancelled' ? 'abgebrochen' : 'fehlgeschlagen'} — kein Materialabzug`);
          console.log(`[${cfg.name}] Job ${ended.outcome} → Abbruch-Log (${body.duration_min ?? '?'} min, kein Abzug)`);
        } else {
          console.log(`[${cfg.name}] Job abgeschlossen → Drucklog-Eintrag (${body.duration_min ?? '?'} min)`);
        }
      }

      // Visible diagnosis in the event log: which slot would be booked right now?
      const active = tracker.session?.lastActiveSlot ?? null;
      if (active != null && isTrackedSlot(active) && active !== lastLoggedSlot) {
        lastLoggedSlot = active;
        addEvent(cfg.id, 'info', `Aktiver Filament-Slot: ${slotLabel(active)}`);
      }

      await outbox.flush();
      await pushStatus(cfg, snapshot, send);
      state.lastPushAt = new Date();
      state.error = null;
      consecutiveErrors = 0;

      const progress = snapshot.progressPct != null ? ` ${snapshot.progressPct}%` : '';
      const file = snapshot.printFile ? ` "${snapshot.printFile}"` : '';
      console.log(`[${cfg.name}] ${new Date().toISOString()} → ${snapshot.status.toUpperCase()}${file}${progress}${snapshot.stale ? ' (stale)' : ''}`);
    } catch (err) {
      consecutiveErrors++;
      const backoff = Math.min(consecutiveErrors * 5_000, 60_000);
      state.error = `Verbindungsfehler (${consecutiveErrors}×). Nächster Versuch in ${backoff / 1000}s.`;
      console.error(`[${cfg.name}] Fehler (${consecutiveErrors}×):`, err);
      if (consecutiveErrors === 1) addEvent(cfg.id, 'warn', `Verbindungsfehler: ${String(err).slice(0, 80)}`);
      await sleep(backoff);
      continue;
    }

    // Wait for the next poll, but push right away when the AMS contents change.
    const amsSig = adapter.amsSignature?.();
    const until = now() + cfg.pollingIntervalMs;
    while (now() < until && !isCancelled()) {
      await sleep(Math.min(1_000, until - now()));
      if (amsSig !== undefined && adapter.amsSignature?.() !== amsSig) break;
    }
  }
}
