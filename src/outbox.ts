import { randomUUID } from 'crypto';
import { join } from 'path';
import fetch from 'node-fetch';
import { CONFIG_DIR, FLOWNT_EDGE_URL } from './config.js';
import type { IngestBody } from './contract.js';
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
// printer deleted, invalid body): the entry is dropped with an error log instead of
// blocking the queue forever.

export interface SendResult { status: number; data: unknown; text?: string }
export type Sender = (body: IngestBody) => Promise<SendResult>;

export interface OutboxEntry {
  id: string;
  printerId: string;
  printerName: string;
  body: IngestBody;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

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
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly file: string,
    private readonly send: Sender = defaultSender,
    private readonly now: () => number = Date.now,
  ) {
    this.entries = readJson<OutboxEntry[]>(file) ?? [];
    if (this.entries.length) console.log(`[outbox] ${this.entries.length} pending job event(s) from before the restart`);
  }

  private persist(): void {
    writeJsonAtomic(this.file, this.entries);
  }

  /** Stores a terminal event durably (throws if it cannot be written). */
  enqueue(printerId: string, printerName: string, body: IngestBody): OutboxEntry {
    const t = this.now();
    const entry: OutboxEntry = { id: randomUUID(), printerId, printerName, body, enqueuedAt: t, attempts: 0, nextAttemptAt: t };
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

  stats(): { pending: number; oldestAgeS: number | null } {
    if (!this.entries.length) return { pending: 0, oldestAgeS: null };
    const oldest = Math.min(...this.entries.map(e => e.enqueuedAt));
    return { pending: this.entries.length, oldestAgeS: Math.max(0, Math.round((this.now() - oldest) / 1000)) };
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
        console.error(`[outbox] [${entry.printerName}] ${label} rejected with ${result.status}, dropped: ${(result.text ?? '').slice(0, 300)}`);
        addEvent(entry.printerId, 'warn', `Job-Meldung von Flownt abgelehnt (${result.status}) — verworfen`);
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

/** Health info for /healthz: pending terminal events and the age of the oldest. */
export function outboxStats(): { pending: number; oldestAgeS: number | null } {
  return getOutbox().stats();
}
