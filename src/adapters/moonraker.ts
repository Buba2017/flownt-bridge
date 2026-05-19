import fetch from 'node-fetch';
import { Adapter, PrinterSnapshot } from './types.js';

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

  constructor(baseUrl: string, apiKey = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
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

      return {
        status: printerStatus,
        printFile: ps?.filename || undefined,
        progressPct: s.display_status?.progress != null ? Math.round(s.display_status.progress * 100) : undefined,
        tempHotend: s.extruder?.temperature,
        tempBed: s.heater_bed?.temperature,
      };
    } catch {
      return { status: 'offline' };
    }
  }
}
