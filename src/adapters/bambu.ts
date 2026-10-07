import mqtt from 'mqtt';
import { Adapter, AmsHumidityUnit, AmsSlot, AmsUnitInfo, FilamentWeight, HmsAlert, JobFileResult, JobIds, JobResult, JobState, PrinterCommand, PrinterSnapshot, PrinterStatus } from './types.js';
import { extractPlatePreview, parseFileBuffer, parseSlicePrediction } from './bambu-file-parser.js';
import { DirEntry, FtpsError, FtpsOptions, FtpsSession, ftpsPausedUntil, withFtps } from './ftps.js';
import { addEvent } from '../events.js';
import { isActiveGcodeState, isNewJob, isTelemetry, jobIdentity, mergePrintState, nonZeroId, PrintState, toInt } from './bambu-state.js';

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
  url?: string;              // project_file echo: where the job's file is (file:///userdata/… = internal)
  task_id?: string;          // per-job id of LAN jobs (subtask_id is "" and job_id "0" there)
  gcode_start_time?: string | number; // job start, epoch s (not sent by all firmware)
  layer_num?: number;
  total_layer_num?: number;
  '3D'?: { layer_num?: number; total_layer_num?: number };
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

/** print_error low word of a job stopped by the user (printer screen, app or LAN stop). */
const PRINT_ERROR_USER_CANCEL = 0x8001;

/**
 * Job result including cancels: the firmware reports a stop as FAILED; it is a cancel
 * when print_error says "stopped by user" or when the bridge itself sent the stop.
 */
export function bambuJobResult(gcodeState: string, printError: number | undefined, stopRequested: boolean): JobResult | null {
  const r = mapJobResult(gcodeState);
  if (r !== 'failed') return r;
  if (stopRequested || (typeof printError === 'number' && (printError & 0xFFFF) === PRINT_ERROR_USER_CANCEL)) return 'aborted';
  return r;
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
  // Slot 255 = no tray. Seen as 0xFEFF on X2D while a job starts (tray_now 255, the job
  // then prints from AMS 0 slot 0) — it is not the external spool.
  if (slot === 0xFF && unit !== 0xFF) return 255;
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


// Leerzeichen und Unterstriche gleichsetzen: Bambu Studio bereinigt beim Senden
// "Modell v3" → "Modell_v3" (liegt in /cache/), ein SD-Start meldet aber den
// Originalnamen mit Leerzeichen. So matchen beide Schreibweisen.
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '_');
}

/** Raw Bambu job ids (non-zero only) for matching against the cloud task history. */
function rawJobIds(st: BambuPrint): JobIds {
  const ids: JobIds = {};
  const task = nonZeroId(st.task_id), sub = nonZeroId(st.subtask_id), job = nonZeroId(st.job_id);
  if (task) ids.taskId = task;
  if (sub) ids.subtaskId = sub;
  if (job) ids.jobId = job;
  return ids;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

type FetchResult = 'ok' | 'missing' | 'error';
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_MS = 2 * 60_000;

const isMissing = (e: unknown) => e instanceof FtpsError && e.code === 550;

/**
 * Searches the SD card for the print file (depth and noise folders limited, so large
 * cards stay cheap). Uses our own client's LIST: basic-ftp gets 522 on X1C/X2D/H2C.
 */
async function walkSd(s: FtpsSession, dir: string, matches: (name: string) => boolean, depth: number): Promise<string | null> {
  const MAX_DEPTH = 3;
  const SKIP_DIRS = new Set(['timelapse', 'ipcam', 'logger', 'log', 'cache', 'model']);
  let entries: DirEntry[];
  try { entries = await s.list(dir); } catch (e) { if (isMissing(e)) return null; throw e; }
  const file = entries.find(e => !e.isDir && matches(e.name));
  if (file) return joinPath(dir, file.name);
  if (depth >= MAX_DEPTH) return null;
  for (const e of entries) {
    if (!e.isDir || e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
    const found = await walkSd(s, joinPath(dir, e.name), matches, depth + 1);
    if (found) return found;
  }
  return null;
}

// Connection timing. The requested values: reconnect backoff 5 s → 60 s; a connected
// session without data is rebuilt after 90 s (a second client such as Bambu Handy/Studio
// can take over the session — the old one stays open but receives nothing). While the
// printer is in PREPARE (parsing the job) a reconnect can make the job fail with HMS
// 0500-4003, so there we only rebuild a session that is clearly dead (3 min silent).
export const BAMBU_TIMINGS = {
  reconnectMinMs: 5_000,
  reconnectMaxMs: 60_000,
  silenceMs: 90_000,
  prepareSilenceMs: 3 * 60_000,
  watchdogTickMs: 15_000,
  /** Periodic full report request (catches anything a partial frame missed). */
  pushallIntervalMs: 10 * 60_000,
  /** Subscribed but nothing arrives: usually a wrong / mis-cased serial in the topic. */
  noDataWarnMs: 60_000,
};
export type BambuTimings = typeof BAMBU_TIMINGS;

/** Test hooks; production code passes none. */
export interface BambuAdapterOptions {
  /** false = do not connect (feed frames via handleMessage). */
  autoConnect?: boolean;
  /** Broker URL instead of mqtts://<ip>:8883 (in-process test broker). */
  brokerUrl?: string;
  /** false = never fetch print files over FTPS. */
  fetchFiles?: boolean;
  /** FTPS port / timeouts (fake server in tests). */
  ftps?: FtpsOptions;
  /** Wait before fetching the print file again after a failed attempt. */
  fetchRetryMs?: number;
  timings?: Partial<BambuTimings>;
}

export class BambuAdapter implements Adapter {
  private readonly opts: BambuAdapterOptions;
  private readonly t: BambuTimings;
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
  // True from (re)connect until the first report with gcode_state: the snapshot holds the
  // last known state, which may be outdated.
  private stale = true;
  private client: mqtt.MqttClient | null = null;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private connectedAt = 0;
  private gotDataSinceConnect = false;
  private warnedNoData = false;
  private lastPushallAt = 0;
  // Identity of the current/last job (see jobIdentity) and its gcode_state, for detecting
  // a new print by its id rather than by a status edge.
  private jobKey: string | null = null;
  private lastGcodeState: string | undefined;
  private stopRequested = false; // we sent "stop" for the current job
  // Print file fetch of the current job (weights + preview); also covers jobs that were
  // running when the bridge started, not only new ones.
  private fetchState: { key: string; attempts: number; nextAt: number; done: boolean } | null = null;
  private fetching = false;
  // Last print start echoed by the printer (command project_file): tells where the file is.
  private lastProjectFile: { url: string; subtaskName: string } | null = null;
  private plateIndex: number | undefined; // from gcode_file ".../plate_<n>.gcode"
  private lastHumSig = ''; // fuer ein Log nur bei Aenderung der AMS-Feuchte
  private disposed = false;

  constructor(ip: string, serial: string, accessCode: string, printerId = '', opts: BambuAdapterOptions = {}) {
    this.ip = ip.replace(/^https?:\/\//, '');
    this.serial = serial;
    this.accessCode = accessCode;
    this.printerId = printerId;
    this.opts = opts;
    this.t = { ...BAMBU_TIMINGS, ...opts.timings };
    this.reconnectDelayMs = this.t.reconnectMinMs;
    if (opts.autoConnect === false) return;
    this.connect();
    this.watchdog = setInterval(() => this.onWatchdogTick(), this.t.watchdogTickMs);
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
    const old = this.client;
    this.client = null;
    old.removeAllListeners();
    // An 'error' emitted after this point (e.g. by the socket while closing) would be
    // unhandled and crash the process.
    old.on('error', () => { /* old session, ignore */ });
    try { old.end(true); } catch { /* ignore */ }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.t.reconnectMaxMs);
    console.log(`[bambu] Reconnect in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private isPreparing(): boolean {
    const gs = typeof this.state.gcode_state === 'string' ? this.state.gcode_state.toUpperCase() : '';
    return gs === 'PREPARE' || gs === 'SLICING';
  }

  private onWatchdogTick(): void {
    if (this.disposed || !this.connected) return;
    const now = Date.now();
    if (!this.gotDataSinceConnect && !this.warnedNoData && now - this.connectedAt >= this.t.noDataWarnMs) {
      this.warnedNoData = true;
      const s = Math.round((now - this.connectedAt) / 1000);
      console.warn(`[bambu] Connected to ${this.ip} but no data for ${s}s — check the serial number (topic device/${this.serial}/report, case-sensitive)`);
      addEvent(this.printerId, 'warn',
        `Verbunden, aber ${s} s keine Druckerdaten — Seriennummer prüfen (Groß-/Kleinschreibung): ${this.serial}`);
    }
    if (this.checkDataSilence(now)) return;
    if (now - this.lastPushallAt >= this.t.pushallIntervalMs) this.requestPushall();
  }

  /** Rebuilds a session that is connected but silent. Returns true if it did. */
  private checkDataSilence(now: number): boolean {
    if (this.lastMessageAt === 0) return false;
    const silentMs = now - this.lastMessageAt;
    const limit = this.isPreparing() ? this.t.prepareSilenceMs : this.t.silenceMs;
    if (silentMs < limit) return false;
    const s = Math.round(silentMs / 1000);
    console.warn(`[bambu] ${s}s keine Daten trotz Verbindung — Neuaufbau`);
    addEvent(this.printerId, 'warn',
      `${s} s keine Druckerdaten trotz Verbindung — Neuaufbau. (Evtl. hat ein anderes Gerät die Drucker-Verbindung übernommen, z. B. Bambu Handy/Studio)`);
    this.markOffline();
    this.connect();
    return true;
  }

  /** Connection lost: keep the last known state and job, only the status changes. */
  private markOffline(): void {
    this.connected = false;
    this.stale = true;
    this.snapshot = { ...this.snapshot, status: 'offline', stale: true };
  }

  private publish(payload: object, what: string): void {
    this.client?.publish(`device/${this.serial}/request`, JSON.stringify(payload), { qos: 0 },
      (err) => { if (err) console.error(`[bambu] ${what} error:`, err.message); });
  }

  /** Asks the printer for a full state report. */
  private requestPushall(): void {
    if (!this.client || !this.connected) return;
    this.lastPushallAt = Date.now();
    this.publish({ pushing: { command: 'pushall', sequence_id: '0' } }, 'pushall');
  }

  private connect(): void {
    if (this.disposed) return;
    this.teardownClient();
    const client = mqtt.connect(this.opts.brokerUrl ?? `mqtts://${this.ip}:8883`, {
      username: 'bblp',
      password: this.accessCode,
      rejectUnauthorized: false,
      reconnectPeriod: 0,       // kein Auto-Reconnect — manueller Backoff (scheduleReconnect)
      connectTimeout: 15_000,
      keepalive: 30,            // tote Verbindungen schneller erkennen (Default 60 s)
    });
    this.client = client;

    client.on('connect', () => {
      this.connected = true;
      this.reconnectDelayMs = this.t.reconnectMinMs;
      this.connectedAt = this.lastMessageAt = Date.now();
      this.gotDataSinceConnect = false;
      // Keep the last known state and job: a reconnect is not a new job. The snapshot is
      // marked stale until the next full report.
      this.stale = true;
      const gs = typeof this.state.gcode_state === 'string' ? this.state.gcode_state : undefined;
      this.snapshot = { ...this.snapshot, status: gs !== undefined ? mapState(gs) : this.snapshot.status, stale: true };
      console.log('[bambu] MQTT connected →', this.ip);
      addEvent(this.printerId, 'success', `Drucker verbunden: ${this.ip}`);
      client.subscribe(`device/${this.serial}/report`, err => {
        if (err) console.error('[bambu] Subscribe error:', err.message);
      });
      // Full state push right away (also after every reconnect: frames may have been missed).
      this.requestPushall();
      // Module list: tells which AMS model each unit is (AMS / AMS Lite / AMS 2 Pro / AMS HT).
      this.publish({ info: { command: 'get_version', sequence_id: '0' } }, 'get_version');
    });

    client.on('message', (_topic, payload) => this.handleMessage(payload));

    client.on('error', err => {
      this.markOffline();
      console.error('[bambu] MQTT error:', err.message);
      // "connack timeout": Drucker antwortet auf den Verbindungswunsch nicht — am A1/P1
      // typischerweise, weil der einzige lokale Slot (noch) belegt ist.
      const hint = err.message.includes('connack')
        ? ' (Drucker antwortet nicht — lokaler Verbindungs-Slot evtl. noch belegt)' : '';
      addEvent(this.printerId, 'warn', `MQTT-Fehler: ${err.message}${hint}`);
    });

    client.on('close', () => {
      const wasConnected = this.connected;
      this.markOffline();
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
    this.gotDataSinceConnect = true;
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
      if (p.command === 'project_file' && typeof p.url === 'string') {
        this.lastProjectFile = { url: p.url, subtaskName: typeof p.subtask_name === 'string' ? p.subtask_name : '' };
      }
      return;
    }
    if (typeof p.ipcam?.rtsp_url === 'string') this.cameraRtspUrl = p.ipcam.rtsp_url;

    const prevStatus = this.snapshot.status;
    this.state = mergePrintState(this.state, p);
    const st = this.state as BambuPrint;
    const gcodeState = typeof st.gcode_state === 'string' ? st.gcode_state : undefined;
    // No gcode_state seen yet (partial frame right after start): keep the last status.
    const newStatus = gcodeState !== undefined ? mapState(gcodeState) : prevStatus;
    // The first report with gcode_state after a (re)connect confirms the state.
    if (typeof p.gcode_state === 'string') this.stale = false;

    if (newStatus !== prevStatus) {
      console.log(`[bambu] State: ${gcodeState} → ${newStatus} (${st.mc_percent ?? '-'}%)`);
      if (gcodeState === 'FAILED' || gcodeState === 'RUNNING') {
        console.log('[bambu] Full status:', JSON.stringify(st).slice(0, 60_000));
      }
      if (st.hms?.length) console.log('[bambu] HMS warnings:', JSON.stringify(st.hms));
    }

    // A new print is recognised by its job id (subtask_id / job_id / task_id / file),
    // not by a status edge: a reconnect or a partial frame must not start a new job.
    const id = jobIdentity(st);
    const isNewPrint = isNewJob(this.jobKey, this.lastGcodeState, id.key, gcodeState);
    if (isActiveGcodeState(gcodeState) && id.key != null) this.jobKey = id.key;
    if (gcodeState !== undefined) this.lastGcodeState = gcodeState;
    if (isNewPrint) {
      console.log(`[bambu] New job: ${id.key} (${st.subtask_name ?? '-'})`);
      // Mapping is job state: a print without its own mapping (external spool!) must not
      // inherit the previous print's mapping, or its usage is booked to that AMS slot.
      if (!Array.isArray(p.mapping)) delete this.state.mapping;
      this.stopRequested = false;
      this.requestPushall(); // full state at print start (mapping, AMS)
    }
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
    if (this.jobKey && this.snapshot.printFile && (newStatus === 'printing' || newStatus === 'paused')) {
      this.maybeFetchPrintFile(this.jobKey, this.snapshot.printFile);
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
    const layerNum = toInt(st.layer_num ?? st['3D']?.layer_num);
    const totalLayers = toInt(st.total_layer_num ?? st['3D']?.total_layer_num);
    const startS = toInt(st.gcode_start_time);
    return {
      status,
      stale: this.stale,
      // The printer's current/last job, also when it is no longer active (FINISH/FAILED
      // after a bridge restart must still match the persisted job session).
      jobKey: jobIdentity(st).key ?? this.jobKey,
      jobResult: gcodeState !== undefined ? bambuJobResult(gcodeState, st.print_error, this.stopRequested) : prev.jobResult,
      printFile: st.subtask_name || undefined,
      sourceJobId: jobIdentity(st).sourceJobId,
      layerNum,
      totalLayers,
      jobStartedAtS: startS != null && startS > 1_000_000_000 ? startS : undefined,
      stopRequested: this.stopRequested,
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
      jobIds: rawJobIds(st),
      plateIndex: this.plateIndex ?? null,
      fileInternal: st.subtask_name ? this.isInternalStorageJob(st.subtask_name) : undefined,
      parsedFilamentWeights: isNewPrint ? null : prev.parsedFilamentWeights,
      printPreview: isNewPrint ? null : prev.printPreview,
      estimatedDurationMin: isNewPrint ? null : prev.estimatedDurationMin,
    };
  }

  /** Slicer weights, plate preview and predicted time of the job's print file. */
  private applyPrintFile(jobName: string, filename: string, buf: Buffer): FilamentWeight[] {
    const weights = parseFileBuffer(filename, buf, this.plateIndex);
    const predictionS = parseSlicePrediction(buf, this.plateIndex);
    this.snapshot = {
      ...this.snapshot,
      parsedFilamentWeights: weights,
      printPreview: this.preview(jobName, buf),
      estimatedDurationMin: predictionS != null ? Math.round(predictionS / 60) : this.snapshot.estimatedDurationMin,
    };
    return weights;
  }

  /**
   * Fetches the job's print file (weights + preview) once per job. A failed attempt
   * (timeout, connection reset) is retried later; a file that is not on the SD card is
   * not looked for again for this job.
   */
  private maybeFetchPrintFile(jobKey: string, printFile: string): void {
    if (this.fetching || this.opts.fetchFiles === false) return;
    const f = this.fetchState;
    if (f && f.key === jobKey && (f.done || Date.now() < f.nextAt)) return;
    const state = f && f.key === jobKey ? f : { key: jobKey, attempts: 0, nextAt: 0, done: false };
    this.fetchState = state;
    if (this.isInternalStorageJob(printFile)) {
      state.done = true;
      console.log(`[bambu] "${printFile}" is stored in the printer's internal storage — not reachable over FTPS, no slicer weights/preview`);
      addEvent(this.printerId, 'info', `Druckdatei liegt im internen Speicher des Druckers — keine Slicer-Gewichte/Vorschau (${printFile})`);
      return;
    }
    // A pause after an earlier connection failure is not an attempt: wait it out.
    const pausedUntil = ftpsPausedUntil(this.ip);
    if (pausedUntil) { state.nextAt = pausedUntil + 1_000; return; }
    state.attempts++;
    this.fetching = true;
    this.fetchPrintFile(printFile)
      .catch((err): FetchResult => { console.error('[bambu] fetchPrintFile:', err); return 'error'; })
      .then(result => {
        if (result !== 'error' || state.attempts >= FETCH_MAX_ATTEMPTS) {
          state.done = true;
          if (result === 'error') addEvent(this.printerId, 'warn', `Druckdatei nach ${state.attempts} Versuchen nicht geladen: ${printFile}`);
        } else {
          state.nextAt = Date.now() + (this.opts.fetchRetryMs ?? FETCH_RETRY_MS) * state.attempts;
        }
      })
      .finally(() => { this.fetching = false; });
  }

  /**
   * Reads a finished job's file again for its slicer weights, without touching the live
   * snapshot (it may already belong to the next job). The file stays on the SD card after
   * the print, so this recovers jobs whose fetch failed or was cut short while printing.
   */
  async refetchJobWeights(printFile: string, plateIndex: number | null): Promise<JobFileResult> {
    if (this.isInternalStorageJob(printFile)) return { kind: 'internal' };
    if (ftpsPausedUntil(this.ip)) return { kind: 'error', message: 'FTPS paused' };
    try {
      const hit = await this.findPrintFile(printFile);
      if (!hit) return { kind: 'missing' };
      const weights = parseFileBuffer(hit.path, hit.buf, plateIndex ?? undefined);
      return weights.length ? { kind: 'ok', weights } : { kind: 'missing' };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The printer echoed the print start with a file in its internal storage (X2D/H2C). */
  private isInternalStorageJob(printFile: string): boolean {
    const pf = this.lastProjectFile;
    return !!pf && pf.subtaskName === printFile && /^file:\/\/\/(userdata|data)\//i.test(pf.url);
  }

  /** Plate thumbnail of the job's .3mf, tied to the print file it belongs to. */
  private preview(printFile: string, buf: Buffer): PrinterSnapshot['printPreview'] {
    const png = extractPlatePreview(buf, this.plateIndex);
    return png ? { printFile, png } : null;
  }

  private async fetchPrintFile(name: string): Promise<FetchResult> {
    console.log(`[bambu] FTPS: Lade Druckdatei "${name}"…`);
    let hit: { path: string; buf: Buffer } | null;
    try {
      hit = await this.findPrintFile(name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bambu] FTPS-Fehler (${name}): ${msg}`);
      addEvent(this.printerId, 'warn', `FTPS-Fehler: ${msg.slice(0, 80)}`);
      return 'error';
    }
    if (!hit) {
      // Typical for H2C/H2D/X2D jobs kept in internal storage: expected, reported once.
      console.warn(`[bambu] Druckdatei nicht via FTPS abrufbar (nicht auf der SD-Karte): ${name}`);
      addEvent(this.printerId, 'warn', `Druckdatei nicht via FTPS gefunden: ${name}`);
      return 'missing';
    }
    const weights = this.applyPrintFile(name, hit.path, hit.buf);
    console.log(`[bambu] Druckdatei geladen: ${hit.path} → ${weights.length} Filament(e) geparst`);
    addEvent(this.printerId, 'success', `Druckdatei geladen: ${hit.path.split('/').pop()} (${weights.length} Slot(s))`);
    return 'ok';
  }

  /**
   * Looks for a job's print file on the SD card and downloads it (null: not found).
   * FTPS root is the SD card. Files sent from Bambu Studio are "{name}.gcode.3mf" in
   * /cache/; Bambu Studio replaces spaces with underscores, while MQTT often reports the
   * original name (e.g. SD start), and a "/" in the job name is stored as "2f" (URL
   * encoding without "%"). So: fixed candidates first, then the folder listings, then a
   * bounded walk of the card — all in one FTPS session.
   */
  private async findPrintFile(name: string): Promise<{ path: string; buf: Buffer } | null> {
    const safe = name.replace(/\//g, '2f');
    const nameVariants = [...new Set([safe, safe.replace(/ /g, '_')])];
    const candidates = nameVariants.flatMap(n => [`/cache/${n}.gcode.3mf`, `/cache/${n}.3mf`, `/${n}.gcode.3mf`, `/${n}.3mf`]);
    const target = normalizeName(safe);
    const matches = (file: string) => /\.3mf$/i.test(file)
      && normalizeName(file.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, '')) === target;
    return await withFtps(this.ip, this.accessCode, async s => {
        for (const path of candidates) {
          try { return { path, buf: await s.retr(path) }; } catch (e) { if (!isMissing(e)) throw e; }
        }
        for (const dir of ['/cache', '/', '/model']) {
          let entries: DirEntry[];
          try { entries = await s.list(dir); } catch (e) { if (isMissing(e)) continue; throw e; }
          const file = entries.find(e => !e.isDir && matches(e.name));
          if (file) { const path = joinPath(dir, file.name); return { path, buf: await s.retr(path) }; }
        }
        // Prints started on the printer from the SD card sit in their own folder.
        const path = await walkSd(s, '/', matches, 0);
        return path ? { path, buf: await s.retr(path) } : null;
      }, this.opts.ftps);
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
    if (cmd.type === 'stop') this.stopRequested = true;
    console.log(`[bambu] Command executed: ${cmd.type}`);
  }
}
