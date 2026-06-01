import mqtt from 'mqtt';
import { Client as FTPClient } from 'basic-ftp';
import { Writable } from 'stream';
import { Adapter, AmsHumidityUnit, AmsSlot, FilamentWeight, PrinterCommand, PrinterSnapshot, PrinterStatus } from './types.js';
import { parseFileBuffer } from './bambu-file-parser.js';
import { addEvent } from '../events.js';

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

interface BambuHms {
  attr: number;
  code: number;
}

interface BambuPrint {
  command?: string;  // "push_status", "gcode_line", "project_file", …
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number; // in minutes
  nozzle_temper?: number;
  bed_temper?: number;
  subtask_name?: string;
  gcode_file?: string; // absoluter Pfad auf dem Drucker, z.B. "/data/Metadata/plate_1.gcode"
  file?: string;       // alternatives Feld, gleiches Format
  hms?: BambuHms[];
  ams?: {
    ams?: BambuAmsUnit[];
    tray_now?: number | string; // aktiver Slot (globaler Index: ams_unit*4 + slot); Bambu sendet manchmal string
  };
}

interface BambuReport {
  print?: BambuPrint;
}

function mapState(state: string): PrinterStatus {
  switch (state.toUpperCase()) {
    case 'RUNNING': return 'printing';
    case 'PAUSE':   return 'paused';
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


class BufferWritable extends Writable {
  private chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) { this.chunks.push(chunk); cb(); }
  getBuffer(): Buffer { return Buffer.concat(this.chunks); }
}

export class BambuAdapter implements Adapter {
  private ip: string;
  private serial: string;
  private accessCode: string;
  private printerId: string;
  private connected = false;
  private snapshot: PrinterSnapshot = { status: 'offline' };
  private client: mqtt.MqttClient | null = null;

  constructor(ip: string, serial: string, accessCode: string, printerId = '') {
    this.ip = ip.replace(/^https?:\/\//, '');
    this.serial = serial;
    this.accessCode = accessCode;
    this.printerId = printerId;
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
      addEvent(this.printerId, 'success', `Drucker verbunden: ${this.ip}`);
      this.client!.subscribe(`device/${this.serial}/report`, err => {
        if (err) console.error('[bambu] Subscribe error:', err.message);
      });
      // Ask printer for a full state push so the snapshot is current immediately
      this.client!.publish(
        `device/${this.serial}/request`,
        JSON.stringify({ pushing: { command: 'pushall', sequence_id: '0' } }),
        { qos: 0 },
        (err) => { if (err) console.error('[bambu] pushall error:', err.message); },
      );
    });

    this.client.on('message', (_topic, payload) => {
      try {
        const raw = payload.toString();
        const msg = JSON.parse(raw) as BambuReport;
        const p = msg.print;
        if (!p) return;

        // push_status = periodic full-state push (gcode_state may be "" when printer is idle)
        const isPushStatus = p.command === 'push_status';

        if (!isPushStatus) {
          // All command responses — log regardless of whether gcode_state is present
          console.log('[bambu] Printer response:', raw.slice(0, 800));
          if (!p.gcode_state) return; // no state to update
        }

        // Treat empty gcode_state as IDLE (happens during idle push_status)
        const gcodeState = p.gcode_state || 'IDLE';
        const prevStatus = this.snapshot.status;
        const newStatus = mapState(gcodeState);

        if (newStatus !== prevStatus) {
          console.log(`[bambu] State: ${gcodeState} → ${newStatus} (${p.mc_percent ?? '-'}%)`);
          if (gcodeState === 'FAILED' || gcodeState === 'RUNNING') {
            console.log('[bambu] Full status:', raw.slice(0, 20000));
          }
          if (p.hms?.length) {
            console.log('[bambu] HMS warnings:', JSON.stringify(p.hms));
          }
        }

        const trayNow = typeof p.ams?.tray_now === 'string'
          ? parseInt(p.ams.tray_now, 10)
          : p.ams?.tray_now;
        const amsSlots = parseAmsSlots(p.ams);
        const amsHumidity = parseAmsHumidity(p.ams);

        // Carry parsedFilamentWeights forward (cleared at start of each new print)
        const isNewPrint = prevStatus !== 'printing' && prevStatus !== 'paused' && newStatus === 'printing';
        const parsedFilamentWeights = isNewPrint ? null : this.snapshot.parsedFilamentWeights;

        this.snapshot = {
          status: newStatus,
          printFile: p.subtask_name || undefined,
          progressPct: p.mc_percent,
          tempHotend: p.nozzle_temper,
          tempBed: p.bed_temper,
          etaSec: p.mc_remaining_time != null ? p.mc_remaining_time * 60 : undefined,
          amsSlots: amsSlots.length > 0 ? amsSlots : this.snapshot.amsSlots,
          activeMqttSlot: trayNow,
          amsHumidity: amsHumidity.length > 0 ? amsHumidity : this.snapshot.amsHumidity,
          parsedFilamentWeights,
        };

        // Bei Druckstart: Druckdatei via FTPS laden und parsen
        if (isNewPrint && this.snapshot.printFile) {
          this.fetchPrintFile(this.snapshot.printFile).catch(err =>
            console.error('[bambu] fetchPrintFile:', err),
          );
        }
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
      addEvent(this.printerId, 'warn', `MQTT-Fehler: ${err.message}`);
    });

    this.client.on('close', () => {
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
    });
  }

  private async fetchPrintFile(subtaskName?: string): Promise<void> {
    if (!subtaskName) return;
    // FTPS-Root ist die SD-Karte. Dateien liegen als "{name}.gcode.3mf" (Bambu Studio)
    // HA sucht: /cache/ zuerst, dann Root /
    const name = subtaskName;
    const candidates: string[] = [
      `/cache/${name}.gcode.3mf`,
      `/cache/${name}.3mf`,
      `/${name}.gcode.3mf`,
      `/${name}.3mf`,
    ];
    const filename = `${name}.gcode.3mf`;
    console.log(`[bambu] FTPS: Lade Druckdatei "${name}", versuche ${candidates.length} Pfad(e)…`);
    for (const remotePath of candidates) {
      const ftp = new FTPClient();
      ftp.ftp.verbose = false;
      try {
        await ftp.access({
          host: this.ip,
          port: 990,
          user: 'bblp',
          password: this.accessCode,
          secure: 'implicit',
          secureOptions: { rejectUnauthorized: false },
        });
        console.log(`[bambu] FTPS verbunden, lade: ${remotePath}`);
        const writable = new BufferWritable();
        await ftp.downloadTo(writable, remotePath);
        ftp.close();
        const buf = writable.getBuffer();
        const weights: FilamentWeight[] = parseFileBuffer(filename, buf);
        this.snapshot = { ...this.snapshot, parsedFilamentWeights: weights };
        console.log(`[bambu] Druckdatei geladen: ${filename} → ${weights.length} Filament(e) geparst`);
        addEvent(this.printerId, 'success', `Druckdatei geladen: ${filename} (${weights.length} Slot(s))`);
        return;
      } catch (err: unknown) {
        ftp.close();
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('550')) {
          console.log(`[bambu] FTPS 550 – nicht gefunden: ${remotePath}`);
        } else {
          console.warn(`[bambu] FTPS-Fehler (${remotePath}): ${msg}`);
          addEvent(this.printerId, 'warn', `FTPS-Fehler: ${msg.slice(0, 80)}`);
          return; // Verbindungsfehler → kein weiterer Versuch
        }
      }
    }
    console.warn(`[bambu] Druckdatei nicht via FTPS abrufbar: ${filename}`);
    addEvent(this.printerId, 'warn', `Druckdatei nicht via FTPS gefunden: ${filename}`);
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    return this.snapshot;
  }

  async sendCommand(cmd: PrinterCommand): Promise<void> {
    if (!this.client || !this.connected) throw new Error('MQTT nicht verbunden');
    const seqId = String(Date.now()).slice(-8);
    let payload: object;
    switch (cmd.type) {
      case 'pause':
        payload = { print: { command: 'pause', sequence_id: seqId } };
        break;
      case 'resume':
        payload = { print: { command: 'resume', sequence_id: seqId } };
        break;
      case 'stop':
        payload = { print: { command: 'stop', sequence_id: seqId } };
        break;
    }
    await new Promise<void>((resolve, reject) => {
      this.client!.publish(
        `device/${this.serial}/request`,
        JSON.stringify(payload),
        { qos: 0 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    console.log(`[bambu] Command sent: ${cmd.type}`);
  }
}
