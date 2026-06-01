import fetch from 'node-fetch';
import { Adapter, FilamentWeight, PrinterSnapshot } from './types.js';
import { parseFileBuffer } from './bambu-file-parser.js';

interface MoonrakerPrintStats {
  state: string;
  filename: string;
  print_duration: number;
}
interface MoonrakerQueryResponse {
  result: {
    status: {
      print_stats?: MoonrakerPrintStats;
      extruder?: { temperature: number };
      heater_bed?: { temperature: number };
      display_status?: { progress: number };
    };
  };
}

function mapState(state: string): PrinterSnapshot['status'] {
  switch (state) {
    case 'printing':
    case 'paused':
      return 'printing';
    case 'error':
      return 'error';
    case 'standby':
    case 'complete':
    case 'cancelled':
    default:
      return 'idle';
  }
}

export class MoonrakerAdapter implements Adapter {
  private baseUrl: string;
  private apiKey: string;
  private prevStatus: PrinterSnapshot['status'] | null = null;
  private parsedFilamentWeights: FilamentWeight[] | null = null;

  constructor(baseUrl: string, apiKey = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  private async fetchPrintFile(filename: string): Promise<void> {
    try {
      const url = `${this.baseUrl}/server/files/gcodes/${encodeURIComponent(filename)}`;
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        console.warn(`[moonraker] Druckdatei nicht abrufbar (${res.status}): ${filename}`);
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const weights = parseFileBuffer(filename, buf);
      this.parsedFilamentWeights = weights;
      console.log(`[moonraker] Druckdatei geladen: ${filename} → ${weights.length} Filament(e) geparst`);
    } catch (err) {
      console.warn('[moonraker] fetchPrintFile:', err);
    }
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    try {
      const url = `${this.baseUrl}/printer/objects/query?print_stats&extruder&heater_bed&display_status`;
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { status: 'offline' };

      const body = (await res.json()) as MoonrakerQueryResponse;
      const s = body.result?.status ?? {};
      const ps = s.print_stats;
      const printerStatus = mapState(ps?.state ?? 'standby');

      // Druckdatei bei idle→printing herunterladen
      const isNewPrint = this.prevStatus !== 'printing' && this.prevStatus !== 'paused' && printerStatus === 'printing';
      if (isNewPrint) {
        this.parsedFilamentWeights = null;
        if (ps?.filename) {
          this.fetchPrintFile(ps.filename).catch(err => console.error('[moonraker] fetchPrintFile:', err));
        }
      }
      this.prevStatus = printerStatus;

      return {
        status: printerStatus,
        printFile: ps?.filename || undefined,
        progressPct: s.display_status?.progress != null ? Math.round(s.display_status.progress * 100) : undefined,
        tempHotend: s.extruder?.temperature,
        tempBed: s.heater_bed?.temperature,
        parsedFilamentWeights: this.parsedFilamentWeights,
      };
    } catch {
      return { status: 'offline' };
    }
  }
}
