import mqtt from 'mqtt';
import { Adapter, AmsHumidityUnit, AmsSlot, PrinterSnapshot } from './types.js';

interface BambuAmsTray {
  id?: string;
  tray_type?: string;
  tray_color?: string;  // Bambu sendet "0xFFAA00FF" (RRGGBBAA) oder "0xFFAA00"
  remain?: number;
  tray_weight?: number;
}

interface BambuAmsUnit {
  id?: string;
  humidity?: string; // "1"–"5" (Bambu-Skala)
  temp?: string;     // "26.4" (°C)
  tray?: BambuAmsTray[];
}

interface BambuPrint {
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number; // in minutes
  nozzle_temper?: number;
  bed_temper?: number;
  subtask_name?: string;
  ams?: {
    ams?: BambuAmsUnit[];
    tray_now?: number; // aktiver Slot (globaler Index: ams_unit*4 + slot)
  };
}

interface BambuReport {
  print?: BambuPrint;
}

function mapState(state: string): PrinterSnapshot['status'] {
  switch (state.toUpperCase()) {
    case 'RUNNING': return 'printing';
    case 'PAUSE':   return 'printing';
    case 'FAILED':  return 'error';
    case 'IDLE':
    case 'FINISH':
    case 'CREATED':
    default:        return 'idle';
  }
}

function normalizeColor(raw?: string): string {
  if (!raw) return '#888888';
  // Bambu sendet "0xFFAA00FF" (mit Alpha) oder "0xFFAA00" → "#FFAA00"
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw.replace('#', '');
  // Nimm nur die ersten 6 Zeichen (RGB, ohne Alpha)
  return '#' + hex.slice(0, 6).toUpperCase();
}

function parseAmsSlots(ams?: BambuPrint['ams']): AmsSlot[] {
  if (!ams?.ams?.length) return [];
  return ams.ams.flatMap((unit, amsUnit) =>
    (unit.tray ?? []).map((tray, slot) => ({
      ams_unit: amsUnit,
      slot,
      material: tray.tray_type ?? '',
      color: normalizeColor(tray.tray_color),
      remain: tray.remain ?? 0,
      tray_weight: tray.tray_weight ?? 1000,
    }))
  );
}

function parseAmsHumidity(ams?: BambuPrint['ams']): AmsHumidityUnit[] {
  if (!ams?.ams?.length) return [];
return ams.ams
    .map((unit, amsUnit) => ({
      ams_unit: amsUnit,
      humidity: parseInt(unit.humidity ?? '0', 10),
      temp: parseFloat(unit.temp ?? '0'),
    }))
    .filter(u => u.humidity > 0);
}

export class BambuAdapter implements Adapter {
  private ip: string;
  private serial: string;
  private accessCode: string;
  private connected = false;
  private snapshot: PrinterSnapshot = { status: 'offline' };
  private client: mqtt.MqttClient | null = null;

  constructor(ip: string, serial: string, accessCode: string) {
    this.ip = ip.replace(/^https?:\/\//, '');
    this.serial = serial;
    this.accessCode = accessCode;
    this.connect();
  }

  private connect(): void {
    this.client = mqtt.connect(`mqtts://${this.ip}:8883`, {
      username: 'bblp',
      password: this.accessCode,
      rejectUnauthorized: false,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.snapshot = { status: 'idle' };
      console.log('[bambu] MQTT connected →', this.ip);
      this.client!.subscribe(`device/${this.serial}/report`, err => {
        if (err) console.error('[bambu] Subscribe error:', err.message);
      });
    });

    this.client.on('message', (_topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString()) as BambuReport;
        const p = msg.print;
        if (!p || !p.gcode_state) return;

        const amsSlots = parseAmsSlots(p.ams);
        const amsHumidity = parseAmsHumidity(p.ams);

        this.snapshot = {
          status: mapState(p.gcode_state),
          printFile: p.subtask_name || undefined,
          progressPct: p.mc_percent,
          tempHotend: p.nozzle_temper,
          tempBed: p.bed_temper,
          etaSec: p.mc_remaining_time != null ? p.mc_remaining_time * 60 : undefined,
          amsSlots: amsSlots.length > 0 ? amsSlots : this.snapshot.amsSlots,
          activeMqttSlot: p.ams?.tray_now,
          amsHumidity: amsHumidity.length > 0 ? amsHumidity : this.snapshot.amsHumidity,
        };
      } catch {
        // ignore malformed messages
      }
    });

    this.client.on('reconnect', () => {
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
      console.log('[bambu] Reconnecting…');
    });

    this.client.on('error', err => {
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
      console.error('[bambu] MQTT error:', err.message);
    });

    this.client.on('close', () => {
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
    });
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    return this.snapshot;
  }
}
