import { join } from 'path';
import { CONFIG_DIR } from './config.js';
import type { AmsSlot, FilamentWeight, HmsAlert, PrinterSnapshot } from './adapters/types.js';
import { isTrackedSlot } from './job-materials.js';
import { readJson, removeFile, writeJsonAtomic } from './state-file.js';

// Per-printer job session, persisted next to the config.
//
// Start time, energy meter reading at the start, the filament mapping and the slicer
// weights used to live only in memory: a bridge restart (or a reconnect seen as a new
// job) mid-print lost them, so the print log got the wrong duration and the material was
// booked by slicer order. The session survives restarts and is only closed after the
// job's terminal event is safely in the outbox.

export interface JobSession {
  version: 1;
  jobKey: string;
  /** Sent as source_job_id (backend dedup). The printer's id when it has a unique one,
   *  else job key + start time. Stable for the whole job, also across restarts. */
  sourceJobId: string;
  printFile?: string;
  startedAt: number;                 // epoch ms
  /** printer: its own start time; bridge: first seen at the start; estimated: adopted
   *  mid-print (bridge restart, no printer start time), back-computed from progress. */
  startedAtSource: 'printer' | 'bridge' | 'estimated';
  energyStartWh: number | null;
  filamentMapping: number[];
  parsedFilamentWeights: FilamentWeight[];
  estimatedDurationMin: number | null;
  lastProgressPct: number | null;
  lastLayer: number | null;
  totalLayers: number | null;
  lastActiveSlot: number | null;
  /** Last AMS state seen during the job (colour fallback, tray_uuid per slot). */
  amsSlots: AmsSlot[];
  printError: string | null;
  hms: HmsAlert[];
  stopRequested: boolean;
  updatedAt: number;
}

/**
 * Time already printed when the bridge first sees a job mid-print and the printer sends
 * no start time (H2C/X2D): elapsed = remaining × progress / (100 − progress). Null at the
 * start of a job or without a usable progress/remaining time.
 */
export function adoptedElapsedMs(snap: PrinterSnapshot): number | null {
  const pct = snap.progressPct;
  const eta = snap.etaSec;
  if (pct == null || eta == null || pct < 2 || pct >= 100 || eta <= 0) return null;
  const ms = (eta * 1000 * pct) / (100 - pct);
  return ms < 7 * 24 * 3_600_000 ? Math.round(ms) : null;
}

export type JobOutcomeValue = 'completed' | 'failed' | 'cancelled';

export interface JobEnd {
  session: JobSession;
  outcome: JobOutcomeValue;
  /** When the bridge saw the end (epoch ms). */
  finishedAt: number;
  /** false: the job ended while the bridge was not watching (outcome inferred). */
  seen: boolean;
}

export class JobSessionStore {
  constructor(private readonly dir: string = join(CONFIG_DIR, 'jobs')) {}
  private file(printerId: string) { return join(this.dir, `${printerId.replace(/[^\w.-]/g, '_')}.json`); }
  load(printerId: string): JobSession | null {
    const s = readJson<JobSession>(this.file(printerId));
    return s && s.version === 1 && typeof s.jobKey === 'string' ? s : null;
  }
  save(printerId: string, s: JobSession): void { writeJsonAtomic(this.file(printerId), s); }
  clear(printerId: string): void { removeFile(this.file(printerId)); }
}

/** Session content without the touch timestamp (for "did anything change"). */
const sessionJson = (s: JobSession) => JSON.stringify({ ...s, updatedAt: 0 });

const isActive = (s: PrinterSnapshot) => s.status === 'printing' || s.status === 'paused';

/** Job identity of a snapshot; adapters without one fall back to the print file. */
export function snapshotJobKey(s: PrinterSnapshot): string | null {
  return s.jobKey ?? (s.printFile ? `file:${s.printFile}` : null);
}

/** Outcome of a job whose end we did not see clearly (no FINISH / FAILED). */
function inferOutcome(s: JobSession): JobOutcomeValue {
  return (s.lastProgressPct ?? 0) >= 99 ? 'completed' : 'failed';
}

function outcomeOf(snap: PrinterSnapshot, s: JobSession): JobOutcomeValue {
  if (snap.jobResult === 'completed' || snap.jobState === 'finished') return 'completed';
  if (snap.jobResult === 'aborted') return 'cancelled';
  if (snap.jobResult === 'failed' || snap.jobState === 'failed' || snap.status === 'error') {
    return s.stopRequested ? 'cancelled' : 'failed';
  }
  return inferOutcome(s);
}

/**
 * Follows one printer's job across snapshots: starts a session when a job becomes
 * active, keeps it up to date and reports its end. Stale and offline snapshots never
 * start or end a job.
 */
export class JobTracker {
  session: JobSession | null;
  private savedJson = '';

  constructor(
    private readonly printerId: string,
    private readonly store: JobSessionStore = new JobSessionStore(),
    private readonly now: () => number = Date.now,
  ) {
    this.session = store.load(printerId);
    if (this.session) {
      this.savedJson = sessionJson(this.session);
      console.log(`[job] ${printerId}: resuming job ${this.session.jobKey} (started ${new Date(this.session.startedAt).toISOString()})`);
    }
  }

  /**
   * Applies a snapshot. Returns `ended` when the session's job is over (the caller
   * stores the terminal event, then calls endJob()), `started` for a new job.
   */
  observe(snap: PrinterSnapshot, energyWh: number | null): { ended?: JobEnd; started?: JobSession } {
    if (snap.stale || snap.status === 'offline') return {};
    const key = snapshotJobKey(snap);
    const s = this.session;
    if (s) {
      const sameJob = key == null || key === s.jobKey;
      if (sameJob) {
        this.absorb(s, snap);
        if (isActive(snap)) { this.persist(); return {}; }
        return { ended: { session: s, outcome: outcomeOf(snap, s), finishedAt: this.now(), seen: true } };
      }
      // Another job is on the printer: ours ended while we were not looking.
      return { ended: { session: s, outcome: inferOutcome(s), finishedAt: this.now(), seen: false } };
    }
    if (!isActive(snap) || key == null) return {};
    const fromPrinter = snap.jobStartedAtS != null;
    const elapsedMs = fromPrinter ? null : adoptedElapsedMs(snap);
    const startedAt = fromPrinter ? snap.jobStartedAtS! * 1000 : this.now() - (elapsedMs ?? 0);
    const started: JobSession = {
      version: 1,
      jobKey: key,
      sourceJobId: snap.sourceJobId || `${key}@${Math.round(startedAt / 1000)}`,
      printFile: snap.printFile,
      startedAt,
      startedAtSource: fromPrinter ? 'printer' : elapsedMs != null ? 'estimated' : 'bridge',
      // Adopted mid-print: the meter delta would only cover the rest of the job.
      energyStartWh: elapsedMs != null ? null : energyWh,
      filamentMapping: [],
      parsedFilamentWeights: [],
      estimatedDurationMin: null,
      lastProgressPct: null,
      lastLayer: null,
      totalLayers: null,
      lastActiveSlot: null,
      amsSlots: [],
      printError: null,
      hms: [],
      stopRequested: false,
      updatedAt: this.now(),
    };
    this.absorb(started, snap);
    this.session = started;
    this.persist();
    return { started };
  }

  /** Closes the session (after its terminal event was stored). */
  endJob(): void {
    this.session = null;
    this.savedJson = '';
    this.store.clear(this.printerId);
  }

  /** Copies the job-relevant parts of a snapshot of this job into the session. */
  private absorb(s: JobSession, snap: PrinterSnapshot): void {
    if (snap.printFile) s.printFile = snap.printFile;
    if (typeof snap.progressPct === 'number') s.lastProgressPct = snap.progressPct;
    // Layer counts: the printer keeps the previous job's layer_num until the first layer
    // (seen: 29/29 at 0 %), so only trust them once the job has progressed.
    if (snap.layerNum != null && snap.totalLayers && snap.layerNum <= snap.totalLayers && (snap.progressPct ?? 0) > 0) {
      s.lastLayer = snap.layerNum;
      s.totalLayers = snap.totalLayers;
    }
    if (snap.filamentMapping?.length) s.filamentMapping = snap.filamentMapping;
    if (snap.parsedFilamentWeights?.length) s.parsedFilamentWeights = snap.parsedFilamentWeights;
    if (snap.estimatedDurationMin != null) {
      s.estimatedDurationMin = snap.estimatedDurationMin;
    } else if (s.estimatedDurationMin == null && snap.jobState === 'printing' && snap.etaSec != null
        && snap.progressPct != null && snap.progressPct <= 1) {
      // No slicer prediction (file not readable): the printer's remaining time right
      // after the start is the best estimate of the whole job.
      s.estimatedDurationMin = Math.round(snap.etaSec / 60);
    }
    if (snap.amsSlots?.length && isActive(snap)) s.amsSlots = snap.amsSlots;
    if (isTrackedSlot(snap.activeMqttSlot)) s.lastActiveSlot = snap.activeMqttSlot!;
    if (snap.printError !== undefined && snap.printError !== null) s.printError = snap.printError;
    if (snap.hms) s.hms = snap.hms;
    if (snap.stopRequested) s.stopRequested = true;
    s.updatedAt = this.now();
  }

  private persist(): void {
    const s = this.session;
    if (!s) return;
    const json = sessionJson(s);
    if (json === this.savedJson) return;
    try {
      this.store.save(this.printerId, s);
      this.savedJson = json;
    } catch (e) {
      console.error(`[job] ${this.printerId}: session not saved: ${(e as Error).message}`);
    }
  }
}

