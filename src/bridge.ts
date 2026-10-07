import { PrinterConfig } from './config.js';
import type { PrinterBridgeState } from './server.js';
import { Adapter, AmsSlot, FilamentWeight, PrinterSnapshot } from './adapters/types.js';
import { CONTRACT_VERSION, EventType, IngestBody, MaterialLine } from './contract.js';
import { BRIDGE_VERSION } from './version.js';
import { ShellyClient } from './smartplug/shelly.js';
import { addEvent } from './events.js';
import { defaultSender, Enricher, getOutbox, Outbox, PendingMaterial, Sender } from './outbox.js';
import { JobEnd, JobSession, JobSessionStore, JobTracker } from './job-session.js';
import { EXTERNAL_SLOT, isTrackedSlot, MaterialContext, ResolvedLine, resolveMaterials, slotIndex, slotLabel } from './job-materials.js';
import { amsRemainLines, cloudTaskLines, matchCloudTask } from './material-sources.js';
import { cloudSourceFor } from './cloud-sources.js';
import type { CloudTaskSource } from './bambu-cloud.js';

/** How long a job end without usage figures waits for the file / cloud lookup. */
const MATERIAL_LOOKUP_MS = 30 * 60_000;

// Last preview delivered per printer config (object identity = one fetch of one job).
const sentPreviews = new Map<string, PrinterSnapshot['printPreview']>();

/** Injection points for tests; production uses the defaults. */
export interface BridgeDeps {
  send?: Sender;
  outbox?: Outbox;
  sessions?: JobSessionStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Cloud task source of the printer (default: from its config, see cloud-sources.ts). */
  cloudSource?: (cfg: PrinterConfig) => CloudTaskSource | null;
  /** Current config of the printer (default: the one runBridge was started with). */
  currentConfig?: () => PrinterConfig;
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

const HMS_RANK: Record<string, number> = { fatal: 0, serious: 1, common: 2, info: 3, unknown: 4 };

/** Why a job failed: the printer's error code, else the most severe active HMS code. */
export function failureReason(s: Pick<JobSession, 'printError' | 'hms'>): string | null {
  if (s.printError) return s.printError;
  const worst = [...s.hms].sort((a, b) => (HMS_RANK[a.severity] ?? 9) - (HMS_RANK[b.severity] ?? 9))[0];
  return worst?.code ?? null;
}

/**
 * Share of the job printed before it ended (0–1): by layers when the printer reported
 * them for this job, else by progress; null when unknown.
 */
export function printedFraction(s: Pick<JobSession, 'lastLayer' | 'totalLayers' | 'lastProgressPct'>): number | null {
  if (s.lastLayer != null && s.totalLayers) return Math.min(1, Math.max(0, s.lastLayer / s.totalLayers));
  if (s.lastProgressPct != null) return Math.min(1, Math.max(0, s.lastProgressPct / 100));
  return null;
}

/**
 * Material lines from slicer weights: physical slot per filament (job-materials.ts), the
 * RFID spool seen in that slot, and for a failed/cancelled job (`fraction` set) the share
 * printed so far.
 */
export function slicerLines(
  weights: FilamentWeight[], ctx: MaterialContext, fraction: number | null,
  note: (type: 'info' | 'warn', msg: string) => void = () => {},
): MaterialLine[] {
  const resolved = resolveMaterials(weights, ctx);
  for (const n of resolved.notes) note(n.type, n.msg);
  const trayUuid = (line: ResolvedLine): string | null => {
    if (line.source !== 'ams' || line.filamentIndex === EXTERNAL_SLOT) return null;
    return ctx.amsSlots.find(a => slotIndex(a.ams_unit, a.slot) === line.filamentIndex)?.tray_uuid ?? null;
  };
  return resolved.lines.map((l): MaterialLine => ({
    // filamentIndex stays as the compat field the backend reads.
    filamentIndex: l.filamentIndex,
    grams: fraction == null ? l.grams : Math.round(l.grams * fraction * 100) / 100,
    color: l.color,
    filament_type: l.filamentType ?? null,
    slotRef: { source: l.source, value: l.filamentIndex },
    measureSource: fraction == null ? 'slicer_file' : 'estimated_partial',
    estimated_grams: l.grams,
    tray_uuid: trayUuid(l),
  }));
}

export interface TerminalJob {
  body: IngestBody;
  /** Set when the material is still to be looked up before sending. */
  pending?: PendingMaterial;
}

/** Terminal event body for a finished/failed job, built from its session. */
export function buildTerminalBody(
  cfg: PrinterConfig, snapshot: PrinterSnapshot, end: JobEnd, energyWh: number | null,
  lookup: { canRefetch: boolean; hasCloud: boolean },
): TerminalJob {
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

  body.started_at = new Date(s.startedAt).toISOString();
  body.finished_at = new Date(end.finishedAt).toISOString();
  if (s.estimatedDurationMin != null) body.estimated_duration_min = s.estimatedDurationMin;
  body.outcome = end.outcome;
  if (s.lastProgressPct != null) body.last_progress_pct = s.lastProgressPct;
  if (eventType === 'job_failed') body.failure_reason = failureReason(s);

  // AMS state as seen during the job (the live one may already belong to the next job).
  const jobSlots: AmsSlot[] = s.amsSlots.length ? s.amsSlots : snapshot.amsSlots ?? [];
  const ctx: MaterialContext = { mapping: s.filamentMapping, activeSlot: s.lastActiveSlot, amsSlots: jobSlots };
  // Failed / cancelled: only the part printed so far counts.
  const fraction = eventType === 'job_failed' ? printedFraction(s) : null;
  if (eventType === 'job_failed' && fraction === 0) return { body }; // nothing printed

  if (s.parsedFilamentWeights.length) {
    if (eventType === 'job_complete' || fraction != null) {
      body.filament_weights = slicerLines(s.parsedFilamentWeights, ctx, fraction, (t, m) => addEvent(cfg.id, t, m));
    }
    return { body };
  }

  // No slicer weights yet. The RFID remaining-% drop is the last resort; the file (still
  // on the SD card) and the cloud task history are tried first, from the outbox.
  const fallback = amsRemainLines(s.amsSlotsAtStart, jobSlots, s.amsStartProgressPct ?? 0);
  // Also for jobs the printer reports in its own storage: X1C reprints say /data/ while the
  // file is still on the SD card. The enricher marks the file unreadable after one miss.
  const canRefetch = lookup.canRefetch && !!s.printFile;
  if (canRefetch || (lookup.hasCloud && !!cfg.adapterSerial)) {
    const ids = s.jobIds ? [s.jobIds.taskId, s.jobIds.subtaskId, s.jobIds.jobId].filter((x): x is string => !!x) : [];
    return {
      body,
      pending: {
        until: end.finishedAt + MATERIAL_LOOKUP_MS, nextAt: end.finishedAt, attempts: 0,
        printFile: s.printFile, plateIndex: s.plateIndex ?? null, fileUnreadable: !canRefetch,
        serial: cfg.adapterSerial || undefined, jobIds: ids, startedAt: s.startedAt, finishedAt: end.finishedAt,
        fraction, mapping: s.filamentMapping, activeSlot: s.lastActiveSlot, amsSlots: jobSlots, fallback,
      },
    };
  }
  if (fallback.length) body.filament_weights = fallback;
  else body.material_unknown = true;
  return { body };
}

/** Material lookup for a printer's pending job ends: print file again, then the cloud. */
export function materialEnricher(
  adapter: Adapter, getCfg: () => PrinterConfig, cloudFor: (cfg: PrinterConfig) => CloudTaskSource | null,
): Enricher {
  return async (pm) => {
    if (!pm.fileUnreadable && adapter.refetchJobWeights && pm.printFile) {
      const r = await adapter.refetchJobWeights(pm.printFile, pm.plateIndex);
      if (r.kind === 'ok') {
        const lines = slicerLines(r.weights, { mapping: pm.mapping, activeSlot: pm.activeSlot, amsSlots: pm.amsSlots }, pm.fraction);
        if (lines.length) return { lines, source: 'Druckdatei' };
      } else if (r.kind === 'internal' || r.kind === 'missing') {
        pm.fileUnreadable = true;
      }
    }
    const cloud = cloudFor(getCfg());
    // File not on the card and no cloud access: nothing left to wait for.
    if (pm.fileUnreadable && (!cloud || !pm.serial)) return 'exhausted';
    if (cloud && pm.serial) {
      const tasks = await cloud.listTasks(pm.serial);
      const task = tasks && matchCloudTask(tasks, {
        serial: pm.serial, ids: pm.jobIds, startedAt: pm.startedAt, finishedAt: pm.finishedAt, title: pm.printFile,
      });
      if (task) {
        const lines = cloudTaskLines(task, pm.amsSlots, pm.fraction);
        if (lines.length) return { lines, source: 'Bambu Cloud' };
      }
    }
    return null;
  };
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

  const cloudFor = deps.cloudSource ?? cloudSourceFor;
  const getCfg = deps.currentConfig ?? (() => cfg);
  const enricher = materialEnricher(adapter, getCfg, cloudFor);
  outbox.setEnricher(cfg.id, enricher);

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
        const { body, pending } = buildTerminalBody(cfg, snapshot, ended, lastEnergyWh, {
          canRefetch: typeof adapter.refetchJobWeights === 'function', hasCloud: cloudFor(getCfg()) != null,
        });
        outbox.enqueue(cfg.id, cfg.name, body, pending);
        tracker.endJob();
        if (pending) addEvent(cfg.id, 'info', `Materialverbrauch wird ermittelt (Druckdatei / Bambu Cloud): ${body.print_file ?? '–'}`);
        if (body.event_type === 'job_failed') {
          const partial = body.filament_weights?.length ? 'Teilverbrauch gebucht' : 'kein Materialabzug';
          addEvent(cfg.id, 'warn', `Druck ${ended.outcome === 'cancelled' ? 'abgebrochen' : 'fehlgeschlagen'} — ${partial}`);
          console.log(`[${cfg.name}] Job ${ended.outcome} → Abbruch-Log (${body.duration_min ?? '?'} min, ${partial})`);
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
  outbox.clearEnricher(cfg.id, enricher);
}
