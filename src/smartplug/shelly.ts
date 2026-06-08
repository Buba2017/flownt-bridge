// Shelly Smart-Plug-Client — liest Momentanleistung (W) + Energiezähler (Wh).
// Unterstützt Gen1 (HTTP /status, meters[]) und die RPC-Familie Gen2/Gen3/Gen4
// (/rpc/Switch.GetStatus), mit automatischer Erkennung. Fehlertolerant: liefert
// bei Problemen null statt zu werfen.

import fetch from 'node-fetch';

export interface ShellyReading {
  powerW: number;   // aktuelle Wirkleistung in Watt
  energyWh: number; // kumulierter Energiezähler in Wattstunden
}

type ShellyGen = 'gen1' | 'gen2' | 'unknown';

function normalizeBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

async function fetchJson(url: string, timeoutMs = 3000): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export class ShellyClient {
  private base: string;
  private gen: ShellyGen = 'unknown';

  constructor(url: string) {
    this.base = normalizeBaseUrl(url);
  }

  /** Liest Leistung + Energie; erkennt die Generation beim ersten Aufruf automatisch. */
  async read(): Promise<ShellyReading | null> {
    if (this.gen === 'gen2' || this.gen === 'unknown') {
      const r = await this.readGen2();
      if (r) { this.gen = 'gen2'; return r; }
      if (this.gen === 'gen2') return null; // war Gen2, jetzt nicht erreichbar
    }
    if (this.gen === 'gen1' || this.gen === 'unknown') {
      const r = await this.readGen1();
      if (r) { this.gen = 'gen1'; return r; }
    }
    return null;
  }

  // Gen2/Plus: /rpc/Switch.GetStatus?id=0 → apower (W), aenergy.total (Wh)
  private async readGen2(): Promise<ShellyReading | null> {
    const j = await fetchJson(`${this.base}/rpc/Switch.GetStatus?id=0`);
    if (!j || typeof j.apower !== 'number') return null;
    const energyWh = typeof j?.aenergy?.total === 'number' ? j.aenergy.total : 0;
    return { powerW: j.apower, energyWh };
  }

  // Gen1: /status → meters[0].power (W), meters[0].total (Watt-Minuten → /60 = Wh)
  private async readGen1(): Promise<ShellyReading | null> {
    const j = await fetchJson(`${this.base}/status`);
    const m = Array.isArray(j?.meters) ? j.meters[0] : null;
    if (!m || typeof m.power !== 'number') return null;
    const energyWh = typeof m.total === 'number' ? m.total / 60 : 0;
    return { powerW: m.power, energyWh };
  }
}
