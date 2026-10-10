import fetch from 'node-fetch';
import { Adapter, FilamentWeight, JobResult, PrinterSnapshot } from './types.js';
import { parseFileBuffer } from './bambu-file-parser.js';

// Prusa Link — lokale HTTP-API der Prusa-Drucker (MK4, XL, MINI, Core One; MK3S+ via
// PrusaLink ab 0.7). Auth per X-Api-Key (am Drucker-Display unter Einstellungen →
// Netzwerk → PrusaLink). Digest-Auth älterer Installationen wird nicht unterstützt.
// Read-only wie Moonraker: Status pollen, Druckdatei fürs Gewichts-Parsing laden.

interface PrusaStatus {
  printer?: {
    state?: string;        // IDLE | BUSY | PRINTING | PAUSED | FINISHED | STOPPED | ERROR | ATTENTION | READY
    temp_nozzle?: number;
    temp_bed?: number;
  };
  job?: {
    id?: number;
    progress?: number;     // 0–100
    time_remaining?: number; // Sekunden
    time_printing?: number;
  };
}

interface PrusaJob {
  id?: number;
  file?: {
    name?: string;
    display_name?: string;
    refs?: { download?: string }; // server-relativer Pfad, direkt GET-bar
  };
}

// ATTENTION heißt „Nutzereingriff nötig" (Filamentwechsel, MMU-Stau, …) und kann mitten
// im Druck auftreten — mit laufendem Job als paused werten (Job lebt noch, kein job_failed),
// ohne Job als error (Drucker braucht Hilfe, druckt aber nichts).
function mapState(state: string, hasJob: boolean): PrinterSnapshot['status'] {
  switch (state) {
    case 'PRINTING': return 'printing';
    case 'PAUSED':   return 'paused';
    case 'ATTENTION': return hasJob ? 'paused' : 'error';
    case 'ERROR':    return 'error';
    case 'FINISHED':
    case 'STOPPED':
    case 'IDLE':
    case 'BUSY':
    case 'READY':
    default:         return 'idle';
  }
}

// Normalisierter Job-Ausgang. Entscheidend: FINISHED ≠ STOPPED — ein Abbruch darf nicht
// als Erfolg abgebucht werden (gleiche Logik wie complete/cancelled bei Moonraker).
function mapJobResult(state: string): JobResult | null {
  switch (state) {
    case 'FINISHED': return 'completed';
    case 'STOPPED':  return 'aborted';
    case 'ERROR':    return 'failed';
    default:         return null;
  }
}

const isActive = (s: PrinterSnapshot['status'] | null) => s === 'printing' || s === 'paused';

export class PrusaLinkAdapter implements Adapter {
  private baseUrl: string;
  private apiKey: string;
  private prevStatus: PrinterSnapshot['status'] | null = null;
  private parsedFilamentWeights: FilamentWeight[] | null = null;
  private currentFileName: string | null = null;
  // Bumped per new print: a lookup still running for an earlier print is discarded.
  private jobSeq = 0;
  private fetching = false;

  constructor(baseUrl: string, apiKey = '') {
    // Nutzer geben oft nur die IP ein — Schema ergänzen.
    const url = /^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
    this.baseUrl = url.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h['X-Api-Key'] = this.apiKey;
    return h;
  }

  // Bei Druckstart: Job-Details holen (Dateiname) und die Druckdatei fürs
  // Filamentgewichts-Parsing laden. Bei .bgcode ist das Parsing Best-Effort
  // (unkomprimierte Metadaten-Blöcke); liefert es nichts, wird der Druck ohne
  // Gewichte geloggt.
  private async fetchJobAndFile(seq: number): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/job`, { headers: this.headers(), signal: AbortSignal.timeout(8000) });
      if (res.status === 204 || !res.ok) return;
      const job = (await res.json()) as PrusaJob;
      if (seq !== this.jobSeq) return;
      this.currentFileName = job.file?.display_name || job.file?.name || null;

      const download = job.file?.refs?.download;
      if (!download || !this.currentFileName) return;
      const fileRes = await fetch(`${this.baseUrl}${download}`, { headers: this.headers(), signal: AbortSignal.timeout(60_000) });
      if (!fileRes.ok) {
        console.warn(`[prusa] Druckdatei nicht abrufbar (${fileRes.status}): ${this.currentFileName}`);
        return;
      }
      const buf = Buffer.from(await fileRes.arrayBuffer());
      const name = this.currentFileName;
      const weights = parseFileBuffer(name, buf);
      if (seq !== this.jobSeq) return;
      this.parsedFilamentWeights = weights;
      console.log(`[prusa] Druckdatei geladen: ${name} → ${weights.length} Filament(e) geparst`);
    } catch (err) {
      console.warn('[prusa] fetchJobAndFile:', err);
    }
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/status`, { headers: this.headers(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { status: 'offline' };

      const body = (await res.json()) as PrusaStatus;
      const state = (body.printer?.state ?? 'IDLE').toUpperCase();
      const hasJob = body.job != null;
      const printerStatus = mapState(state, hasJob);

      // New print (also one first seen paused, e.g. after a bridge restart).
      if (!isActive(this.prevStatus) && isActive(printerStatus)) {
        this.jobSeq++;
        this.parsedFilamentWeights = null;
        this.currentFileName = null;
      }
      // Without the file name the job has no identity (no print log): a lookup that
      // failed at the start is repeated on the next poll.
      if (isActive(printerStatus) && !this.currentFileName && !this.fetching) {
        this.fetching = true;
        this.fetchJobAndFile(this.jobSeq)
          .catch(err => console.error('[prusa] fetchJobAndFile:', err))
          .finally(() => { this.fetching = false; });
      }
      this.prevStatus = printerStatus;

      return {
        status: printerStatus,
        jobResult: mapJobResult(state),
        // Dateiname gecacht — beim Terminal-Poll (FINISHED/STOPPED) fehlt job im Status oft schon.
        printFile: this.currentFileName ?? undefined,
        progressPct: typeof body.job?.progress === 'number' ? Math.round(body.job.progress) : undefined,
        etaSec: typeof body.job?.time_remaining === 'number' ? body.job.time_remaining : undefined,
        tempHotend: body.printer?.temp_nozzle,
        tempBed: body.printer?.temp_bed,
        parsedFilamentWeights: this.parsedFilamentWeights,
      };
    } catch {
      return { status: 'offline' };
    }
  }
}
