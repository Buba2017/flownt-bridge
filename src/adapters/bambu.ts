import mqtt from 'mqtt';
import { Client as FTPClient, FileInfo } from 'basic-ftp';
import { Writable } from 'stream';
import { Adapter, AmsHumidityUnit, AmsSlot, AmsUnitInfo, FilamentWeight, HmsAlert, JobResult, JobState, PrinterCommand, PrinterSnapshot, PrinterStatus } from './types.js';
import { extractPlatePreview, parseFileBuffer } from './bambu-file-parser.js';
import { ftpsDownload, ftpsList } from './ftps.js';
import { addEvent } from '../events.js';
import { isTelemetry, mergePrintState, PrintState, toInt } from './bambu-state.js';

interface BambuAmsTray {
  id?: string | number;
  state?: number;
  tray_type?: string;
  tray_color?: string;  // Bambu sendet "0xFFAA00FF" (RRGGBBAA) oder "0xFFAA00"
  remain?: number;
  tray_weight?: number | string;
  tray_uuid?: string;       // spool identity from the RFID tag (zeros = no tag)
  tag_uid?: string;         // RFID chip UID (zeros = no tag)
  tray_info_idx?: string;   // Bambu filament code, e.g. "GFA00"
  tray_sub_brands?: string; // product line, e.g. "PLA Basic"
  tray_diameter?: string;
  nozzle_temp_min?: string;
  nozzle_temp_max?: string;
}

interface BambuAmsUnit {
  id?: string | number;
  humidity?: string | number;     // "1"–"5" index, inverted: 5 = dry, 1 = wet
  humidity_raw?: string | number; // relative humidity in % (AMS 2 Pro / AMS HT)
  temp?: string | number;         // "28.7" (°C inside the unit; > 100 is ignored by the merge)
  tray?: BambuAmsTray[];
  dry_time?: number;     // remaining drying time in minutes (AMS 2 Pro / AMS HT)
  dry_setting?: { dry_temperature?: number; dry_duration?: number; dry_filament?: string };
}

// Response to the get_version request: one module per hardware part. AMS models are
// identified by their module name prefix (same mapping as ha-bambulab).
interface BambuInfo {
  command?: string;
  module?: Array<{ name?: string; product_name?: string }>;
}

const AMS_MODULE_PREFIX: Array<[string, NonNullable<AmsUnitInfo['model']>]> = [
  ['ams_f1/', 'AMS Lite'], ['n3f/', 'AMS 2 Pro'], ['n3s/', 'AMS HT'], ['ams/', 'AMS'],
];
const DRYING_MODELS = new Set(['AMS 2 Pro', 'AMS HT']);

interface BambuHms {
  attr: number;
  code: number;
}

interface BambuPrint {
  ipcam?: { rtsp_url?: string };
  command?: string;  // "push_status", "gcode_line", "project_file", …
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number; // in minutes
  nozzle_temper?: number;
  bed_temper?: number;
  subtask_name?: string;
  subtask_id?: string; // eindeutige Job-ID (stabil je Druck; bei Re-Emission desselben Jobs gleich) — Dedup
  job_id?: string;     // Fallback-Job-ID
  gcode_file?: string; // absoluter Pfad auf dem Drucker, z.B. "/data/Metadata/plate_1.gcode"
  file?: string;       // alternatives Feld, gleiches Format
  hms?: BambuHms[];
  print_error?: number;
  sequence_id?: string;
  result?: string;   // command replies: "success" / "fail"
  reason?: string;
  // Per-extruder state (all current firmware; dual-nozzle printers report two). `snow` is
  // the tray loaded on that extruder as (ams_id << 8) | slot, 65535 = none; the active
  // extruder is bits 4–7 of `state`.
  device?: { extruder?: { state?: number; info?: Array<{ id?: number; snow?: number }> } };
  ams?: {
    ams?: BambuAmsUnit[];
    tray_now?: number | string; // aktiver Slot (globaler Index: ams_unit*4 + slot); Bambu sendet manchmal string
  };
  mapping?: number[]; // Slicer-Filament-id (1-basiert, Index = id-1) → physischer Tray-Code; 65535 = ungenutzt/extern
}

interface BambuReport {
  print?: BambuPrint;
  info?: BambuInfo;
}

const isZeroId = (v?: string) => !v || /^0+$/.test(v);
const unitId = (unit: BambuAmsUnit, index: number) => toInt(unit.id) ?? index;
const num = (v?: string | number | null) => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '');
  return Number.isFinite(n) ? n : null;
};

function mapState(state: string): PrinterStatus {
  switch (state.toUpperCase()) {
    case 'RUNNING': return 'printing';
    // Heating, levelling and calibration before the first layer: the printer is busy, and
    // a job that fails here must still end as a (failed) job, not vanish.
    case 'PREPARE':
    case 'SLICING': return 'printing';
    case 'PAUSE':   return 'paused';
    case 'FAILED':  return 'error';
    case 'IDLE':
    case 'FINISH':
    case 'CREATED':
    default:        return 'idle';
  }
}

// Normalisierter Job-Ausgang aus gcode_state. FINISH = sauber beendet, FAILED = Fehler bzw.
// manueller Stop (die Firmware meldet beim Stop aktuell FAILED). Sonst kein Terminal → null.
function mapJobResult(state: string): JobResult | null {
  switch (state.toUpperCase()) {
    case 'FINISH': return 'completed';
    case 'FAILED': return 'failed';
    default:       return null;
  }
}

/** The printer refused or ignored a control command (typically: no Developer Mode). */
export class CommandRejectedError extends Error {
  readonly code = 'command_rejected';
}

export function mapJobState(state: string): JobState {
  switch (state.toUpperCase()) {
    case 'PREPARE':
    case 'SLICING': return 'preparing';
    case 'RUNNING': return 'printing';
    case 'PAUSE':   return 'paused';
    case 'FINISH':  return 'finished';
    case 'FAILED':  return 'failed';
    default:        return 'idle';
  }
}

const HMS_SEVERITY: Record<number, HmsAlert['severity']> = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };
const hex4 = (n: number) => (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

/** HMS entries → "XXXX_XXXX_XXXX_XXXX" codes as shown on the printer. */
export function parseHms(hms: BambuHms[]): HmsAlert[] {
  return hms.map(h => ({
    code: `${hex4(h.attr >>> 16)}_${hex4(h.attr)}_${hex4(h.code >>> 16)}_${hex4(h.code)}`,
    severity: HMS_SEVERITY[(h.code >>> 16) & 0xFFFF] ?? 'unknown',
  }));
}

/** print_error → "MMMM_EEEE"; values below 0x4000 in the low word are status, not errors. */
export function formatPrintError(err: number | undefined): string | null {
  if (!err || (err & 0xFFFF) < 0x4000) return null;
  return `${hex4(err >>> 16)}_${hex4(err)}`;
}

/**
 * Active tray from the extruder state, in the global encoding Flownt uses (unit*4+slot,
 * 128+ = AMS HT, 254 = external spool, 255 = none). Needed for dual-nozzle printers
 * (H2D/H2C/X2D), where tray_now only holds the slot within the unit; on single-nozzle
 * printers it gives the same value as tray_now.
 */
export function activeTrayFromExtruder(dev: BambuPrint['device']): number | undefined {
  const info = dev?.extruder?.info;
  if (!Array.isArray(info) || info.length === 0 || typeof dev?.extruder?.state !== 'number') return undefined;
  const active = (dev.extruder.state >> 4) & 0xF;
  const ext = info.find(e => e.id === active);
  if (typeof ext?.snow !== 'number') return undefined;
  if (ext.snow === 65535) return 255;
  const unit = ext.snow >> 8;
  const slot = ext.snow & 0xFF;
  if (unit === 254 || unit === 255) return 254;
  if (unit >= 128) return unit;
  return unit * 4 + slot;
}

function normalizeColor(raw?: string): string {
  if (!raw) return '#888888';
  // Bambu sendet "0xFFAA00FF" (mit Alpha) oder "0xFFAA00" → "#FFAA00"
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw.replace('#', '');
  // Nimm nur die ersten 6 Zeichen (RGB, ohne Alpha)
  return '#' + hex.slice(0, 6).toUpperCase();
}

// Unit and slot numbers are the printer's own ids (unit*4+slot = Bambu tray code, as in
// tray_now and print.mapping). Using array positions broke printers whose AMS ids do
// not start at 0 (e.g. units 1 and 2).
function parseAmsSlots(ams?: BambuPrint['ams']): AmsSlot[] {
  if (!ams?.ams?.length) return [];
  return ams.ams.flatMap((unit, index) =>
    (unit.tray ?? []).map((tray, position) => {
      return {
        ams_unit: unitId(unit, index),
        slot: toInt(tray.id) ?? position,
        material: tray.tray_type ?? '',
        color: normalizeColor(tray.tray_color),
        remain: tray.remain ?? 0,
        tray_weight: num(tray.tray_weight) || 1000,
        tray_uuid: isZeroId(tray.tray_uuid) ? null : tray.tray_uuid!,
        tag_uid: isZeroId(tray.tag_uid) ? null : tray.tag_uid!,
        filament_code: tray.tray_info_idx || null,
        sub_brand: tray.tray_sub_brands || null,
        diameter_mm: num(tray.tray_diameter),
        nozzle_temp_min: num(tray.nozzle_temp_min),
        nozzle_temp_max: num(tray.nozzle_temp_max),
      };
    })
  );
}

function parseAmsUnits(ams: BambuPrint['ams'] | undefined, models: Map<number, AmsUnitInfo['model']>): AmsUnitInfo[] {
  if (!ams?.ams?.length) return [];
  return ams.ams.map((unit, index) => {
    const id = unitId(unit, index);
    const model = models.get(id) ?? null;
    const canDry = model != null && DRYING_MODELS.has(model);
    return {
      ams_unit: id,
      model,
      slot_count: unit.tray?.length ?? (id >= 128 ? 1 : 4),
      can_dry: canDry,
      drying: canDry ? {
        active: (unit.dry_time ?? 0) > 0,
        temp_c: unit.dry_setting?.dry_temperature != null && unit.dry_setting.dry_temperature > 0 ? unit.dry_setting.dry_temperature : null,
        remaining_min: (unit.dry_time ?? 0) > 0 ? unit.dry_time! : null,
      } : null,
    };
  });
}

function parseAmsHumidity(ams?: BambuPrint['ams']): AmsHumidityUnit[] {
  if (!ams?.ams?.length) return [];
  return ams.ams
    .map((unit, index): AmsHumidityUnit => {
      const pct = toInt(unit.humidity_raw);
      const temp = num(unit.temp);
      return {
        ams_unit: unitId(unit, index),
        humidity: toInt(unit.humidity) ?? 0,
        temp: temp != null && temp <= 100 ? temp : 0,
        humidity_pct: pct != null && pct >= 0 && pct <= 100 ? pct : undefined,
      };
    })
    .filter(u => u.humidity > 0);
}


class BufferWritable extends Writable {
  private chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) { this.chunks.push(chunk); cb(); }
  getBuffer(): Buffer { return Buffer.concat(this.chunks); }
}

// Leerzeichen und Unterstriche gleichsetzen: Bambu Studio bereinigt beim Senden
// "Modell v3" → "Modell_v3" (liegt in /cache/), ein SD-Start meldet aber den
// Originalnamen mit Leerzeichen. So matchen beide Schreibweisen.
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '_');
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// Reconnect-Backoff: A1/P1 bedienen lokal effektiv nur EINEN MQTT-Client; jeder
// fehlgeschlagene Versuch hinterlässt druckerseitig eine halb-offene Verbindung, die
// den Slot bis zum TCP-Keepalive-Timeout (~20 min) blockieren kann. Aggressives
// 5s-Dauerfeuer (alt) ist der dokumentierte Auslöser dafür (BambuStudio#2404,
// ha-bambulab#174) — daher ansteigender Abstand.
const RECONNECT_MIN_MS = 15_000;
const RECONNECT_MAX_MS = 120_000;
// Verbunden, aber keine Push-Daten mehr: dokumentiertes Firmware-Verhalten, wenn ein
// zweiter Client (Bambu Handy/Studio) die Verbindung übernimmt — die alte bleibt
// offen, bekommt aber nichts mehr. Der Watchdog erkennt das und baut sauber neu auf.
const DATA_SILENCE_MS  = 5 * 60_000;
const WATCHDOG_TICK_MS = 60_000;

/** Test hooks; production code passes none. */
export interface BambuAdapterOptions {
  /** false = do not connect (feed frames via handleMessage). */
  autoConnect?: boolean;
  /** Broker URL instead of mqtts://<ip>:8883 (in-process test broker). */
  brokerUrl?: string;
  /** false = never fetch print files over FTPS. */
  fetchFiles?: boolean;
}

export class BambuAdapter implements Adapter {
  private readonly opts: BambuAdapterOptions;
  private cameraRtspUrl: string | null = null;
  // AMS unit id → model, from the printer's module list (get_version).
  private amsModels = new Map<number, AmsUnitInfo['model']>();

  getCameraRtspUrl(): string | null { return this.cameraRtspUrl; }
  private ip: string;
  private serial: string;
  private accessCode: string;
  private printerId: string;
  private connected = false;
  private pendingCommands = new Map<string, (result?: string, reason?: string) => void>();
  private snapshot: PrinterSnapshot = { status: 'offline' };
  // Merged push_status state (see bambu-state.ts); the snapshot is derived from it.
  private state: PrintState = {};
  private client: mqtt.MqttClient | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  // Zuletzt gemeldeter echter Feuchte-Prozentwert je AMS-Unit (aus mc_print.push_info).
  // Wird beim naechsten push_status an amsHumidity[].humidity_pct angehaengt.
  // Job whose print file was already fetched (weights + preview); also covers jobs that
  // were running when the bridge started, not only new ones.
  private fetchedJobKey: string | null = null;
  private plateIndex: number | undefined; // from gcode_file ".../plate_<n>.gcode"
  private lastHumSig = ''; // fuer ein Log nur bei Aenderung der AMS-Feuchte
  private disposed = false;

  constructor(ip: string, serial: string, accessCode: string, printerId = '', opts: BambuAdapterOptions = {}) {
    this.ip = ip.replace(/^https?:\/\//, '');
    this.serial = serial;
    this.accessCode = accessCode;
    this.printerId = printerId;
    this.opts = opts;
    if (opts.autoConnect === false) return;
    this.connect();
    this.watchdog = setInterval(() => this.checkDataSilence(), WATCHDOG_TICK_MS);
  }

  /** Adapter vollständig stoppen (Config-Änderung/Löschen) — sonst reconnectet der
   *  alte MQTT-Client ewig weiter und kämpft mit dem neuen um den einzigen Slot. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.watchdog)       { clearInterval(this.watchdog);      this.watchdog = null; }
    this.teardownClient();
    this.connected = false;
  }

  /** Alten Client restlos abbauen, bevor ein neuer verbindet — halb-offene
   *  Verbindungen blockieren am A1/P1 den lokalen MQTT-Slot. */
  private teardownClient(): void {
    if (!this.client) return;
    this.client.removeAllListeners();
    try { this.client.end(true); } catch { /* ignore */ }
    this.client = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    console.log(`[bambu] Reconnect in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private checkDataSilence(): void {
    if (this.disposed || !this.connected || this.lastMessageAt === 0) return;
    const silentMs = Date.now() - this.lastMessageAt;
    if (silentMs < DATA_SILENCE_MS) return;
    const min = Math.round(silentMs / 60_000);
    console.warn(`[bambu] ${min} min keine Daten trotz Verbindung — Neuaufbau`);
    addEvent(this.printerId, 'warn',
      `${min} min keine Druckerdaten trotz Verbindung — Neuaufbau. (Evtl. hat ein anderes Gerät die Drucker-Verbindung übernommen, z. B. Bambu Handy/Studio)`);
    this.connected = false;
    this.snapshot = { ...this.snapshot, status: 'offline' };
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    this.teardownClient();
    this.client = mqtt.connect(this.opts.brokerUrl ?? `mqtts://${this.ip}:8883`, {
      username: 'bblp',
      password: this.accessCode,
      rejectUnauthorized: false,
      reconnectPeriod: 0,       // kein Auto-Reconnect — manueller Backoff (scheduleReconnect)
      connectTimeout: 15_000,
      keepalive: 30,            // tote Verbindungen schneller erkennen (Default 60 s)
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.lastMessageAt = Date.now();
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
      // Module list: tells which AMS model each unit is (AMS / AMS Lite / AMS 2 Pro / AMS HT).
      this.client!.publish(
        `device/${this.serial}/request`,
        JSON.stringify({ info: { command: 'get_version', sequence_id: '0' } }),
        { qos: 0 },
        (err) => { if (err) console.error('[bambu] get_version error:', err.message); },
      );
    });

    this.client.on('message', (_topic, payload) => this.handleMessage(payload));

    this.client.on('error', err => {
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
      console.error('[bambu] MQTT error:', err.message);
      // "connack timeout": Drucker antwortet auf den Verbindungswunsch nicht — am A1/P1
      // typischerweise, weil der einzige lokale Slot (noch) belegt ist.
      const hint = err.message.includes('connack')
        ? ' (Drucker antwortet nicht — lokaler Verbindungs-Slot evtl. noch belegt)' : '';
      addEvent(this.printerId, 'warn', `MQTT-Fehler: ${err.message}${hint}`);
    });

    this.client.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
      if (wasConnected) {
        // Diagnose: Abriss einer STEHENDEN Verbindung getrennt loggen — das ist das
        // Muster "anderer Client hat übernommen" bzw. WLAN-Abriss (≠ connack timeout).
        console.warn('[bambu] Bestehende MQTT-Verbindung abgerissen');
        addEvent(this.printerId, 'warn', 'Bestehende Drucker-Verbindung abgerissen (WLAN-Abriss oder anderes Gerät hat übernommen) — baue neu auf');
      }
      this.scheduleReconnect();
    });
  }

  /** One MQTT message from the report topic (public for tests: feed captured frames). */
  handleMessage(payload: Buffer | string): void {
    this.lastMessageAt = Date.now();
    const raw = typeof payload === 'string' ? payload : payload.toString();
    let msg: BambuReport;
    try {
      msg = JSON.parse(raw) as BambuReport;
    } catch {
      return; // ignore malformed messages
    }
    if (msg.info?.command === 'get_version' && Array.isArray(msg.info.module)) {
      const models = new Map<number, AmsUnitInfo['model']>();
      for (const m of msg.info.module) {
        const hit = AMS_MODULE_PREFIX.find(([prefix]) => m.name?.startsWith(prefix));
        const id = hit ? parseInt(m.name!.slice(hit[0].length), 10) : NaN;
        if (hit && Number.isFinite(id)) models.set(id, hit[1]);
      }
      this.amsModels = models;
      if (models.size) console.log('[bambu] AMS-Module:', [...models].map(([id, m]) => `${id}=${m}`).join(' '));
      this.snapshot = { ...this.snapshot, amsUnits: this.deriveAmsUnits() };
      return;
    }
    const p = msg.print;
    if (!p || typeof p !== 'object') return;

    // Reply to a command we sent (matched by sequence_id).
    const seq = p.sequence_id != null ? String(p.sequence_id) : undefined;
    const pending = seq ? this.pendingCommands.get(seq) : undefined;
    const isOwnReply = !!pending && (p.command !== 'push_status' || p.result != null || p.reason != null);
    if (pending && isOwnReply) {
      this.pendingCommands.delete(seq!);
      pending(p.result, p.reason);
    }
    if (!isTelemetry(p, isOwnReply)) {
      // Command replies and commands of other clients echoed by the printer: they carry
      // command fields (gcode_state of the command, param, …), not printer state.
      console.log('[bambu] Printer response:', raw.slice(0, 800));
      return;
    }
    if (typeof p.ipcam?.rtsp_url === 'string') this.cameraRtspUrl = p.ipcam.rtsp_url;

    const prevStatus = this.snapshot.status;
    const prevState = this.state;
    this.state = mergePrintState(this.state, p);
    const st = this.state as BambuPrint;
    const gcodeState = typeof st.gcode_state === 'string' ? st.gcode_state : undefined;
    // No gcode_state seen yet (partial frame right after start): keep the last status.
    const newStatus = gcodeState !== undefined ? mapState(gcodeState) : prevStatus;

    if (newStatus !== prevStatus) {
      console.log(`[bambu] State: ${gcodeState} → ${newStatus} (${st.mc_percent ?? '-'}%)`);
      if (gcodeState === 'FAILED' || gcodeState === 'RUNNING') {
        console.log('[bambu] Full status:', JSON.stringify(st).slice(0, 60_000));
      }
      if (st.hms?.length) console.log('[bambu] HMS warnings:', JSON.stringify(st.hms));
    }

    // Carry the job's file data forward (cleared at the start of each new print).
    const isNewPrint = prevStatus !== 'printing' && prevStatus !== 'paused' && newStatus === 'printing';
    // Mapping is job state: a print without its own mapping (external spool!) must not
    // inherit the previous print's mapping, or its usage is booked to that AMS slot.
    if (isNewPrint && !Array.isArray(p.mapping) && prevState.mapping !== undefined) delete this.state.mapping;
    const plateM = typeof st.gcode_file === 'string' ? /plate_(\d+)\.gcode/i.exec(st.gcode_file) : null;
    if (plateM) this.plateIndex = parseInt(plateM[1], 10);

    this.snapshot = this.deriveSnapshot(newStatus, gcodeState, isNewPrint);
    const humSig = (this.snapshot.amsHumidity ?? []).map(u => `${u.ams_unit}:${u.humidity}/5${u.humidity_pct != null ? `/${u.humidity_pct}%` : ''}`).join(' ');
    if (humSig && humSig !== this.lastHumSig) {
      this.lastHumSig = humSig;
      console.log('[bambu] AMS Feuchte:', humSig);
    }

    // Bei Druckstart (oder laufendem Druck nach Bridge-Start): Druckdatei via FTPS
    // laden und parsen — einmal je Job.
    const jobKey = this.snapshot.printFile ? `${this.snapshot.sourceJobId ?? ''}|${this.snapshot.printFile}` : null;
    if (jobKey && (newStatus === 'printing' || newStatus === 'paused') && jobKey !== this.fetchedJobKey && this.opts.fetchFiles !== false) {
      this.fetchedJobKey = jobKey;
      this.fetchPrintFile(this.snapshot.printFile).catch(err =>
        console.error('[bambu] fetchPrintFile:', err),
      );
    }
  }

  private deriveAmsUnits(): AmsUnitInfo[] | undefined {
    const ams = (this.state as BambuPrint).ams;
    return ams?.ams ? parseAmsUnits(ams, this.amsModels) : this.snapshot.amsUnits;
  }

  /** Snapshot from the merged printer state (never from a single frame). */
  private deriveSnapshot(status: PrinterStatus, gcodeState: string | undefined, isNewPrint: boolean): PrinterSnapshot {
    const st = this.state as BambuPrint;
    const prev = this.snapshot;
    const ams = st.ams;
    const trayNow = toInt(ams?.tray_now);
    return {
      status,
      jobResult: gcodeState !== undefined ? mapJobResult(gcodeState) : prev.jobResult,
      printFile: st.subtask_name || undefined,
      sourceJobId: st.subtask_id || st.job_id || undefined,
      progressPct: num(st.mc_percent) ?? undefined,
      tempHotend: num(st.nozzle_temper) ?? undefined,
      tempBed: num(st.bed_temper) ?? undefined,
      etaSec: num(st.mc_remaining_time) != null ? num(st.mc_remaining_time)! * 60 : undefined,
      amsSlots: ams?.ams ? parseAmsSlots(ams) : undefined,
      activeMqttSlot: activeTrayFromExtruder(st.device) ?? trayNow,
      jobState: gcodeState !== undefined ? mapJobState(gcodeState) : prev.jobState,
      hms: Array.isArray(st.hms) ? parseHms(st.hms) : undefined,
      printError: typeof st.print_error === 'number' ? formatPrintError(st.print_error) : undefined,
      amsHumidity: ams?.ams ? parseAmsHumidity(ams) : undefined,
      amsUnits: ams?.ams ? parseAmsUnits(ams, this.amsModels) : undefined,
      filamentMapping: Array.isArray(st.mapping) && st.mapping.length > 0 ? st.mapping : undefined,
      parsedFilamentWeights: isNewPrint ? null : prev.parsedFilamentWeights,
      printPreview: isNewPrint ? null : prev.printPreview,
    };
  }

  /** Plate thumbnail of the job's .3mf, tied to the print file it belongs to. */
  private preview(printFile: string, buf: Buffer): PrinterSnapshot['printPreview'] {
    const png = extractPlatePreview(buf, this.plateIndex);
    return png ? { printFile, png } : null;
  }

  private async fetchPrintFile(subtaskName?: string): Promise<void> {
    if (!subtaskName) return;
    // FTPS-Root ist die SD-Karte. Dateien liegen als "{name}.gcode.3mf" (Bambu Studio)
    // HA sucht: /cache/ zuerst, dann Root /
    const name = subtaskName;
    // Bambu Studio bereinigt beim Senden Leerzeichen → Unterstriche und legt die
    // Datei so in /cache/ ab; MQTT meldet aber oft den Originalnamen mit Leerzeichen
    // (z. B. bei SD-Start). Darum beide Schreibweisen als feste Kandidaten probieren,
    // bevor die teure rekursive SD-Suche greift.
    // A "/" in the job name is stored as "2f" (URL encoding without "%").
    const safe = name.replace(/\//g, '2f');
    const underscored = safe.replace(/ /g, '_');
    const nameVariants = [...new Set([safe, underscored])];
    const candidates: string[] = nameVariants.flatMap((n) => [
      `/cache/${n}.gcode.3mf`,
      `/cache/${n}.3mf`,
      `/${n}.gcode.3mf`,
      `/${n}.3mf`,
    ]);
    const filename = `${name}.gcode.3mf`;
    console.log(`[bambu] FTPS: Lade Druckdatei "${name}", versuche ${candidates.length} Pfad(e)…`);
    for (const remotePath of candidates) {
      try {
        // Own FTPS client: resumes the TLS session on the data connection, which newer
        // Bambu firmware requires (basic-ftp gets "522 session reuse required").
        const buf = await ftpsDownload(this.ip, this.accessCode, remotePath);
        const weights: FilamentWeight[] = parseFileBuffer(filename, buf, this.plateIndex);
        this.snapshot = { ...this.snapshot, parsedFilamentWeights: weights, printPreview: this.preview(name, buf) };
        console.log(`[bambu] Druckdatei geladen: ${remotePath} → ${weights.length} Filament(e) geparst`);
        addEvent(this.printerId, 'success', `Druckdatei geladen: ${filename} (${weights.length} Slot(s))`);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('550')) {
          console.log(`[bambu] FTPS 550 – nicht gefunden: ${remotePath}`);
        } else {
          console.warn(`[bambu] FTPS-Fehler (${remotePath}): ${msg}`);
          addEvent(this.printerId, 'warn', `FTPS-Fehler: ${msg.slice(0, 80)}`);
          return; // Verbindungsfehler → kein weiterer Versuch
        }
      }
    }
    // Then the file lists of the usual folders (names may differ in spaces/underscores).
    for (const dir of ['/cache', '/', '/model']) {
      let names: string[];
      try { names = await ftpsList(this.ip, this.accessCode, dir); } catch { continue; }
      const target = normalizeName(safe);
      const hit = names.map(n => n.split('/').pop() ?? n)
        .find(n => /\.3mf$/i.test(n) && normalizeName(n.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, '')) === target);
      if (!hit) continue;
      try {
        const remotePath = joinPath(dir, hit);
        const buf = await ftpsDownload(this.ip, this.accessCode, remotePath);
        const weights: FilamentWeight[] = parseFileBuffer(hit, buf, this.plateIndex);
        this.snapshot = { ...this.snapshot, parsedFilamentWeights: weights, printPreview: this.preview(name, buf) };
        console.log(`[bambu] Druckdatei geladen: ${remotePath} → ${weights.length} Filament(e) geparst`);
        addEvent(this.printerId, 'success', `Druckdatei geladen: ${hit} (${weights.length} Slot(s))`);
        return;
      } catch (err: unknown) {
        console.warn(`[bambu] FTPS-Fehler (${dir}/${hit}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Fallback: an keinem festen Pfad gefunden → SD-Karte rekursiv durchsuchen.
    // Greift v. a. bei Drucken, die direkt am Drucker von der SD gestartet wurden
    // (MQTT meldet dann den Originalnamen mit Leerzeichen, Datei liegt in einem
    // eigenen Ordner statt in /cache/; gcode_file zeigt auf /data/… = interner
    // Speicher, per FTPS nicht erreichbar → wir müssen die SD selbst absuchen).
    console.log(`[bambu] FTPS: "${name}" an festen Pfaden nicht gefunden – durchsuche SD-Karte rekursiv…`);
    const hit = await this.searchSdForFile(name);
    if (hit) {
      const weights: FilamentWeight[] = parseFileBuffer(hit.path, hit.buf, this.plateIndex);
      this.snapshot = { ...this.snapshot, parsedFilamentWeights: weights, printPreview: this.preview(name, hit.buf) };
      console.log(`[bambu] Druckdatei via SD-Suche geladen: ${hit.path} → ${weights.length} Filament(e) geparst`);
      addEvent(this.printerId, 'success', `Druckdatei geladen (SD-Suche): ${hit.path.split('/').pop()} (${weights.length} Slot(s))`);
      return;
    }

    console.warn(`[bambu] Druckdatei nicht via FTPS abrufbar: ${filename}`);
    addEvent(this.printerId, 'warn', `Druckdatei nicht via FTPS gefunden: ${filename}`);
  }

  /**
   * Durchsucht die SD-Karte (FTPS-Wurzel) rekursiv nach einer Druckdatei, deren
   * Name zu `name` passt (Leerzeichen/Unterstriche gleichgesetzt) und auf
   * `.gcode.3mf`/`.3mf` endet. Eine einzige FTPS-Verbindung für den ganzen Lauf;
   * Tiefe + Rausch-Ordner begrenzt, damit grosse SD-Karten nicht ausufern.
   */
  private async searchSdForFile(name: string): Promise<{ path: string; buf: Buffer } | null> {
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
      const target = normalizeName(name);
      const match = await this.walkSd(ftp, '/', target, 0);
      if (!match) { ftp.close(); return null; }
      const writable = new BufferWritable();
      await ftp.downloadTo(writable, match);
      ftp.close();
      return { path: match, buf: writable.getBuffer() };
    } catch (err: unknown) {
      ftp.close();
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bambu] FTPS-SD-Suche fehlgeschlagen: ${msg}`);
      return null;
    }
  }

  private async walkSd(ftp: FTPClient, dir: string, target: string, depth: number): Promise<string | null> {
    const MAX_DEPTH = 3;
    const SKIP_DIRS = new Set(['timelapse', 'ipcam', 'logger', 'log']);
    let entries: FileInfo[];
    try {
      entries = await ftp.list(dir);
    } catch {
      return null;
    }
    // Erst Dateien im aktuellen Ordner prüfen…
    for (const e of entries) {
      if (!e.isFile) continue;
      const lower = e.name.toLowerCase();
      if (!lower.endsWith('.gcode.3mf') && !lower.endsWith('.3mf')) continue;
      const base = e.name.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, '');
      if (normalizeName(base) === target) return joinPath(dir, e.name);
    }
    // …dann Unterordner (bis MAX_DEPTH, Rausch-Ordner überspringen).
    if (depth >= MAX_DEPTH) return null;
    for (const e of entries) {
      if (!e.isDirectory || e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const found = await this.walkSd(ftp, joinPath(dir, e.name), target, depth + 1);
      if (found) return found;
    }
    return null;
  }

  amsSignature(): string {
    return (this.snapshot.amsSlots ?? [])
      .map(s => `${s.ams_unit}.${s.slot}:${s.tray_uuid ?? ''}:${s.material}:${s.color}`).join('|');
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
    // Wait for the printer's reply. Current Bambu firmware only executes control
    // commands over LAN in Developer Mode; otherwise it rejects them or does not answer —
    // report that instead of claiming success.
    const reply = new Promise<{ result?: string; reason?: string } | null>(resolve => {
      const timer = setTimeout(() => { this.pendingCommands.delete(seqId); resolve(null); }, 8_000);
      this.pendingCommands.set(seqId, (result, reason) => { clearTimeout(timer); resolve({ result, reason }); });
    });
    await new Promise<void>((resolve, reject) => {
      this.client!.publish(
        `device/${this.serial}/request`,
        JSON.stringify(payload),
        { qos: 0 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const r = await reply;
    const verificationFailed = (this.snapshot.hms ?? []).some(h => h.code === '0500_0500_0001_0007');
    if (!r || verificationFailed || (r.result && r.result.toLowerCase() !== 'success')) {
      const why = verificationFailed ? 'command verification failed (HMS 0500_0500_0001_0007)'
        : r ? `${r.result}${r.reason ? `: ${r.reason}` : ''}` : 'no reply';
      console.warn(`[bambu] Command ${cmd.type} rejected: ${why}`);
      throw new CommandRejectedError(why);
    }
    console.log(`[bambu] Command executed: ${cmd.type}`);
  }
}
