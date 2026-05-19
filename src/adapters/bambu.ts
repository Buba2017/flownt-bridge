import mqtt from 'mqtt';
import { Adapter, PrinterSnapshot } from './types.js';

interface BambuPrint {
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number; // in minutes
  nozzle_temper?: number;
  bed_temper?: number;
  subtask_name?: string;
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

export class BambuAdapter implements Adapter {
  private ip: string;
  private serial: string;
  private accessCode: string;
  private connected = false;
  private snapshot: PrinterSnapshot = { status: 'offline' };
  private client: mqtt.MqttClient | null = null;

  constructor(ip: string, serial: string, accessCode: string) {
    this.ip = ip.replace(/^https?:\/\//, ''); // strip protocol if user included it
    this.serial = serial;
    this.accessCode = accessCode;
    this.connect();
  }

  private connect(): void {
    this.client = mqtt.connect(`mqtts://${this.ip}:8883`, {
      username: 'bblp',
      password: this.accessCode,
      rejectUnauthorized: false, // Bambu uses a self-signed cert
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

        this.snapshot = {
          status: mapState(p.gcode_state),
          printFile: p.subtask_name || undefined,
          progressPct: p.mc_percent,
          tempHotend: p.nozzle_temper,
          tempBed: p.bed_temper,
          etaSec: p.mc_remaining_time != null ? p.mc_remaining_time * 60 : undefined,
        };
      } catch {
        // ignore malformed messages
      }
    });

    this.client.on('reconnect', () => {
      this.connected = false;
      this.snapshot = { status: 'offline' };
      console.log('[bambu] Reconnecting…');
    });

    this.client.on('error', err => {
      this.connected = false;
      this.snapshot = { status: 'offline' };
      console.error('[bambu] MQTT error:', err.message);
    });

    this.client.on('close', () => {
      this.connected = false;
      this.snapshot = { status: 'offline' };
    });
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    return this.snapshot;
  }
}
