import { randomUUID } from 'crypto';
import { join } from 'path';
import fetch from 'node-fetch';
import { CONFIG_DIR, FLOWNT_EDGE_URL } from './config.js';
import type { AmsSlot, IngestBody, MaterialLine } from './contract.js';
import { addEvent } from './events.js';
import { readJson, writeJsonAtomic } from './state-file.js';

// Persistent outbox for terminal job events (job_complete / job_failed).
//
// A job end is seen exactly once. If its push failed, the event used to be lost for
// good (no print log, no material booking). Now the event is written to disk first and
// delivered from here, with backoff, until bridge-ingest answers 2xx — also across
// bridge restarts. The backend books a job at most once per (printer, source_job_id),
// so a resend after an unclear failure is safe.
//
// A 4xx (except 408 / 429) means the backend will never accept this body (bad token,
// printer deleted, invalid body): the entry moves to a dead-letter list (visible in
// /healthz, kept on disk) instead of blocking the queue. Before that, a rotated printer
// token is picked up from the current config (`setTokenResolver`), so a token change in
// Flownt no longer loses the job.
//
// Jobs without usage figures wait here before they are sent (`pendingMaterial`): the
// printer's enricher (bridge.ts) retries the print file and the Bambu Cloud task history
// for a while; afterwards the job goes out with the RFID estimate or flagged
// `material_unknown`.

export interface SendResult { status: number; data: unknown; text?: string }
export type Sender = (body: IngestBody) => Promise<SendResult>;

/** A job end whose material is still being looked up before it is sent. */
export interface PendingMaterial {
  /** Give up and send with the fallback after this time (epoch ms). */
  until: number;
  nextAt: number;
  attempts: number;
  printFile?: string;
  plateIndex: number | null;
  /** File in the printer's internal storage, or confirmed missing on the SD card. */
  fileUnreadable: boolean;
  serial?: string;
  jobIds: string[];
  startedAt: number;
  finishedAt: number;
  /** Share printed for failed/cancelled jobs (scales full-job weights), null if complete. */
  fraction: number | null;
  /** Planned print time in minutes (finds earlier runs of the same job as template). */
  estimatedMin?: number | null;
  mapping: number[];
  activeSlot: number | null;
  amsSlots: AmsSlot[];
  /** Lines to send when nothing better turns up (RFID estimate), may be empty. */
  fallback: MaterialLine[];
}

export interface Enrichment { lines: MaterialLine[]; source: string }
/** Looks up the material of a pending job; null = nothing yet, 'exhausted' = no source left
 *  to try (send with the fallback now). May update `pm`. */
export type Enricher = (pm: PendingMaterial) => Promise<Enrichment | 'exhausted' | null>;

export interface OutboxEntry {
  id: string;
  printerId: string;
  printerName: string;
  body: IngestBody;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  pendingMaterial?: PendingMaterial;
}

export interface DeadLetter extends OutboxEntry {
  status: number;
  rejectedAt: number;
  response: string;
}

const MATERIAL_RETRY_MIN_MS = 60_000;
const MATERIAL_RETRY_MAX_MS = 10 * 60_000;
const MAX_DEAD_LETTERS = 100;

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export const defaultSender: Sender = async (body) => {
  const res = await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => '');
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  return { status: res.status, data, text };
};

const isPermanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

export class Outbox {
  private entries: OutboxEntry[];
  private dead: DeadLetter[];
  private flushing: Promise<void> | null = null;
  private readonly enrichers = new Map<string, Enricher>();
  private tokenFor: (printerId: string) => string | null = () => null;

  constructor(
    private readonly file: string,
    private readonly send: Sender = defaultSender,
    private readonly now: () => number = Date.now,
  ) {
    this.entries = readJson<OutboxEntry[]>(file) ?? [];
    this.dead = readJson<DeadLetter[]>(this.deadFile) ?? [];
    if (this.entries.length) console.log(`[outbox] ${this.entries.length} pending job event(s) from before the restart`);
  }

  private get deadFile(): string {
    return this.file.replace(/\.json$/, '') + '-rejected.json';
  }

  private persist(): void {
    writeJsonAtomic(this.file, this.entries);
  }

  /** Registers the material lookup of a printer (see PendingMaterial). */
  setEnricher(printerId: string, enricher: Enricher | null): void {
    if (enricher) this.enrichers.set(printerId, enricher); else this.enrichers.delete(printerId);
  }

  /** Removes a printer's enricher, unless another one replaced it meanwhile. */
  clearEnricher(printerId: string, enricher: Enricher): void {
    if (this.enrichers.get(printerId) === enricher) this.enrichers.delete(printerId);
  }

  /** Current Flownt token of a printer, used when a queued body carries an outdated one. */
  setTokenResolver(fn: (printerId: string) => string | null): void {
    this.tokenFor = fn;
  }

  /** Stores a terminal event durably (throws if it cannot be written). */
  enqueue(printerId: string, printerName: string, body: IngestBody, pendingMaterial?: PendingMaterial): OutboxEntry {
    const t = this.now();
    const entry: OutboxEntry = { id: randomUUID(), printerId, printerName, body, enqueuedAt: t, attempts: 0, nextAttemptAt: t };
    if (pendingMaterial) entry.pendingMaterial = pendingMaterial;
    this.entries.push(entry);
    try {
      this.persist();
    } catch (e) {
      this.entries.pop();
      throw e;
    }
    return entry;
  }

  pending(): readonly OutboxEntry[] {
    return this.entries;
  }

  rejected(): readonly DeadLetter[] {
    return this.dead;
  }

  stats(): OutboxStats {
    const awaitingMaterial = this.entries.filter(e => e.pendingMaterial).length;
    const rejected = this.dead.length;
    if (!this.entries.length) return { pending: 0, oldestAgeS: null, awaitingMaterial, rejected };
    const oldest = Math.min(...this.entries.map(e => e.enqueuedAt));
    return { pending: this.entries.length, oldestAgeS: Math.max(0, Math.round((this.now() - oldest) / 1000)), awaitingMaterial, rejected };
  }

  /**
   * Material lookup for a pending entry. Returns true when the entry is ready to send
   * (material found, or the lookup window is over and the fallback was applied).
   */
  private async enrich(entry: OutboxEntry): Promise<boolean> {
    const pm = entry.pendingMaterial!;
    const t = this.now();
    let exhausted = false;
    if (t < pm.until) {
      if (pm.nextAt > t) return false;
      const enricher = this.enrichers.get(entry.printerId);
      let found: Enrichment | 'exhausted' | null = null;
      if (enricher) {
        try { found = await enricher(pm); } catch (e) { console.warn(`[outbox] [${entry.printerName}] material lookup failed:`, (e as Error).message); }
      }
      if (found === 'exhausted') exhausted = true;
      else if (found?.lines.length) {
        entry.body.filament_weights = found.lines;
        delete entry.pendingMaterial;
        addEvent(entry.printerId, 'success', `Materialverbrauch nachträglich ermittelt (${found.source}): ${entry.body.print_file ?? '–'}`);
        this.persistQuietly();
        return true;
      }
      if (!exhausted) {
        pm.attempts++;
        pm.nextAt = t + Math.min(MATERIAL_RETRY_MIN_MS * 2 ** (pm.attempts - 1), MATERIAL_RETRY_MAX_MS);
        this.persistQuietly();
        return false;
      }
    }
    if (pm.fallback.length) {
      entry.body.filament_weights = pm.fallback;
      addEvent(entry.printerId, 'warn', `Materialverbrauch nur geschätzt (RFID-Restmenge): ${entry.body.print_file ?? '–'}`);
    } else {
      entry.body.material_unknown = true;
      addEvent(entry.printerId, 'warn', `Materialverbrauch unbekannt — in Flownt nachtragen: ${entry.body.print_file ?? '–'}`);
    }
    delete entry.pendingMaterial;
    this.persistQuietly();
    return true;
  }

  private persistQuietly(): void {
    try { this.persist(); } catch (e) { console.error('[outbox] persist failed:', (e as Error).message); }
  }

  /** Sends every entry that is due, oldest first. Concurrent calls share one run. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.run().finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }

  private async run(): Promise<void> {
    for (const entry of [...this.entries]) {
      if (entry.nextAttemptAt > this.now()) continue;
      if (entry.pendingMaterial && !await this.enrich(entry)) continue;
      // A token rotated in Flownt since the job ended: send with the current one.
      const token = this.tokenFor(entry.printerId);
      if (token && token !== entry.body.auth_token) entry.body.auth_token = token;
      const label = `${entry.body.event_type} ${entry.body.source_job_id ?? entry.body.print_file ?? ''}`.trim();
      let result: SendResult | null = null;
      let error: string | undefined;
      try {
        result = await this.send(entry.body);
      } catch (e) {
        error = (e as Error)?.message ?? String(e);
      }
      if (result && result.status >= 200 && result.status < 300) {
        this.remove(entry);
        const id = (result.data as Record<string, unknown> | null)?.print_log_id;
        const idHint = typeof id === 'string' ? ` (${id.slice(0, 8)}…)` : '';
        console.log(`[outbox] [${entry.printerName}] delivered ${label}${entry.attempts ? ` after ${entry.attempts} failed attempt(s)` : ''}`);
        if (entry.body.event_type === 'job_complete') addEvent(entry.printerId, 'success', `Drucklog erstellt${idHint}: ${entry.body.print_file ?? '–'}`);
        continue;
      }
      if (result && isPermanent(result.status)) {
        this.remove(entry);
        const response = (result.text ?? '').slice(0, 300);
        this.dead = [...this.dead, { ...entry, status: result.status, rejectedAt: this.now(), response }].slice(-MAX_DEAD_LETTERS);
        try { writeJsonAtomic(this.deadFile, this.dead); } catch (e) { console.error('[outbox] dead letters not saved:', (e as Error).message); }
        console.error(`[outbox] [${entry.printerName}] ${label} rejected with ${result.status}, moved to ${this.deadFile}: ${response}`);
        addEvent(entry.printerId, 'warn', `Job-Meldung von Flownt abgelehnt (${result.status}) — in der Bridge aufbewahrt, siehe /healthz`);
        continue;
      }
      entry.attempts++;
      entry.lastError = error ?? `HTTP ${result!.status}`;
      const delay = Math.min(RETRY_MIN_MS * 2 ** (entry.attempts - 1), RETRY_MAX_MS);
      entry.nextAttemptAt = this.now() + delay;
      console.warn(`[outbox] [${entry.printerName}] ${label} failed (${entry.lastError}), retry ${entry.attempts} in ${Math.round(delay / 1000)}s`);
      if (entry.attempts === 1) addEvent(entry.printerId, 'warn', `Job-Meldung an Flownt fehlgeschlagen — wird wiederholt (${entry.lastError.slice(0, 60)})`);
      try { this.persist(); } catch (e) { console.error('[outbox] persist failed:', (e as Error).message); }
    }
  }

  private remove(entry: OutboxEntry): void {
    this.entries = this.entries.filter(e => e.id !== entry.id);
    try { this.persist(); } catch (e) { console.error('[outbox] persist failed:', (e as Error).message); }
  }
}

let shared: Outbox | null = null;

/** The bridge's outbox (one for all printers), stored in the config directory. */
export function getOutbox(): Outbox {
  if (!shared) shared = new Outbox(join(CONFIG_DIR, 'outbox.json'));
  return shared;
}

export interface OutboxStats {
  pending: number;
  oldestAgeS: number | null;
  /** Job ends waiting for their material lookup. */
  awaitingMaterial: number;
  /** Events Flownt rejected (kept in outbox-rejected.json). */
  rejected: number;
}

/** Health info for /healthz: pending terminal events and the age of the oldest. */
export function outboxStats(): OutboxStats {
  return getOutbox().stats();
}
