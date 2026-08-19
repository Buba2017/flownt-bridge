import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { Adapter, AmsSlot, FilamentWeight, JobResult, PrinterSnapshot } from './types.js';

// ── Anycubic Kobra LAN-Adapter ────────────────────────────────────────────────────
// Bindet Anycubic Kobra X / S1 (und vermutlich Kobra 3-Serie) über den lokalen
// LAN-Modus an: Credential-Discovery per HTTP (Port 18910, AES-CBC) → persistentes
// MQTT über TLS (Port 9883) → periodische Report-Queries. Read-only.
//
// Protokoll-Details: docs/anycubic-lan-protocol.md
// Validierung: docs/anycubic-capture-findings.md — Payloads/States/ACE bestätigt an
// echten Drucken (Kobra S1 FW 2.7.2.7, Kobra X FW 1.2.0.6, 2026-08).
// Muster: persistente MQTT-Verbindung wie BambuAdapter (nicht HTTP-Poll wie Moonraker).

const CTRL_PORT = 18910;
const MQTT_PORT_FALLBACK = 9883;
const QUERY_TYPES = ['status', 'info', 'tempature', 'fan', 'light', 'peripherie', 'multiColorBox'] as const;
const QUERY_INTERVAL_MS = 15_000;
const RECONNECT_DELAY_MS = 30_000;  // Discovery-Retry (LAN-Modus aus / Drucker aus)
const STALE_AFTER_MS = 90_000;      // Watchdog: Queries laufen alle 15 s → 90 s ohne Report = tot

// supplies_usage ist der kumulative Materialverbrauch aus den print-Reports — in MILLIGRAMM.
// Bestätigt 2026-08-19 per Anycubic-App-Auftragsbericht der Testerin: Shark-Testdruck
// (Kobra X, supplies_usage final 6530) wird dort als „6 g" ausgewiesen → mg (6,53 g).
// ('mm' hätte 19,3 g ergeben; die frühe Doku-Annahme „direkt Gramm" war ebenfalls falsch.)
const SUPPLIES_UNIT: 'mm' | 'mg' = 'mg';

interface AnycubicCredentials {
  broker?: string;
  deviceId: string;
  modeId?: string | number;
  modelId?: string | number;
  modelName?: string;
  username: string;
  password: string;
  devicecrt?: string;
  devicepk?: string;
}

// Zustand des aktuellen bzw. zuletzt beendeten Drucks. Wird aus print-Reports und
// info.data.project zusammengeführt; nach dem Terminal-Report bleibt er (inkl. result
// und finalem supplies_usage) gelatcht, bis der nächste Druck startet — bridge.ts
// konsumiert jobResult genau am Übergang printing → idle.
interface JobTracker {
  state: string;
  file?: string;
  sourceJobId?: string;
  progress?: number;
  remainMin?: number;
  suppliesUsage?: number;
  result: JobResult | null;
}

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const nonce = (n: number) => Array.from({ length: n }, () =>
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[crypto.randomInt(62)]).join('');

// Job-/Envelope-State → Flownt-Status. paused bleibt hier paused (bridge.ts mappt beim Push).
// Gesehene aktive States: checking, auto_leveling, flow_calibrating, preheating, printing,
// updated (print/update), stopping. 'stopping' zählt noch als aktiv — terminal ist erst 'stoped'.
function mapState(state: string): PrinterSnapshot['status'] {
  const s = state.toLowerCase();
  if (['printing', 'updated', 'resuming', 'resumed', 'preheating', 'heating', 'checking',
       'auto_leveling', 'leveling', 'downloading', 'slicing', 'vibrating', 'flow_calibrating',
       'stopping'].includes(s)) return 'printing';
  if (['pausing', 'paused'].includes(s)) return 'paused';
  if (['failed', 'error'].includes(s)) return 'error';
  return 'idle'; // finished, stoped, free, …
}

// Normalisierter Job-Ausgang — NUR echte Terminal-States (Capture-belegt: finished, stoped).
// finished ≠ stoped (Abbruch darf nicht als Erfolg abgebucht werden). Bewusst NICHT dabei:
// 'done' (das ist der Envelope-ACK-State jedes info/tempature-Reports, nie ein Job-Ende)
// und 'stopping' (noch aktiv; der stop-Report mit 'stoped' folgt Sekunden später).
function mapJobResult(state: string): JobResult | null {
  const s = state.toLowerCase();
  if (['finished', 'finish', 'completed'].includes(s)) return 'completed';
  if (['stoped', 'stopped', 'cancelled', 'canceled'].includes(s)) return 'aborted';
  if (['failed', 'error'].includes(s)) return 'failed';
  return null;
}

// supplies_usage → Gramm (1,75-mm-Filament, Dichte-Faktor 1,23 g/m wie beim GCode-Parser).
function suppliesToGrams(v: number): number {
  if (SUPPLIES_UNIT === 'mg') return Math.round(v / 10) / 100;
  return Math.round((((Math.PI * (1.75 / 2) * 1.75) / 2) * v * 1.23) / 1000 * 100) / 100;
}

// "/test_model/Shark_PLA_0.2_46m11s.gcode" → "Shark_PLA_0.2_46m11s.gcode"
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export class AnycubicAdapter implements Adapter {
  private host: string;
  private printerId: string;
  private client: mqtt.MqttClient | null = null;
  private queryTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastMsgAt = 0;
  private snapshot: PrinterSnapshot = { status: 'offline' };
  // Letzte Roh-Reports je Typ (msg.data). Reports kommen getrennt; Snapshot wird zusammengesetzt.
  private reports: Record<string, Record<string, unknown>> = {};
  // Envelope-State je Typ (msg.state) — Drucker-/Job-Status liegt auf dem Envelope,
  // nicht unter msg.data (bei 'status' ist msg.data sogar null). Capture-bestätigt (S1 + X).
  private envState: Record<string, string> = {};
  private job: JobTracker | null = null;

  constructor(host: string, printerId = '') {
    this.host = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.printerId = printerId;
    void this.connect();
  }

  // ── Credential-Discovery (HTTP 18910 + AES-128-CBC) ──
  private async discover(): Promise<AnycubicCredentials> {
    const info = await fetch(`http://${this.host}:${CTRL_PORT}/info`, { signal: AbortSignal.timeout(10_000) })
      .then(r => r.json()) as Record<string, string>;
    const token = info.token;
    const ctrlUrl = info.ctrlInfoUrl;
    if (!token || token.length < 32 || !ctrlUrl) {
      throw new Error('Anycubic /info unvollständig — LAN-Modus am Drucker aktiv?');
    }
    const ts = String(Date.now());
    const n = nonce(6);
    const sign = md5(md5(token.slice(0, 16)) + ts + n);
    const did = crypto.randomBytes(16).toString('hex').toUpperCase();
    const ctrl = await fetch(`${ctrlUrl}?ts=${ts}&nonce=${n}&sign=${sign}&did=${did}`,
      { method: 'POST', signal: AbortSignal.timeout(10_000) }).then(r => r.json()) as
      { code: number; data: { info: string; token: string } };
    if (ctrl.code !== 200) throw new Error(`Anycubic ctrlInfo code=${ctrl.code}`);

    const decipher = crypto.createDecipheriv('aes-128-cbc',
      Buffer.from(token.slice(16, 32), 'utf8'), Buffer.from(ctrl.data.token, 'utf8'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctrl.data.info, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as AnycubicCredentials;
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    let cred: AnycubicCredentials;
    try {
      cred = await this.discover();
    } catch (err) {
      // Discovery scheitert, solange der LAN-Modus aus ist → gelassen weiterprobieren.
      console.error('[anycubic] discovery:', (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    const typeId = String(cred.modeId ?? cred.modelId);
    const deviceId = cred.deviceId;
    let host = this.host, port = MQTT_PORT_FALLBACK;
    try { const u = new URL(cred.broker ?? ''); host = u.hostname || this.host; port = Number(u.port) || MQTT_PORT_FALLBACK; } catch { /* Fallback */ }

    const base = `anycubic/anycubicCloud/v1/web/printer/${typeId}/${deviceId}`;
    const subTopic = `anycubic/anycubicCloud/v1/printer/+/${typeId}/${deviceId}/#`;

    // Capture-bestätigt (S1 + Kobra X): Connect funktioniert OHNE Client-Cert,
    // nur username/password aus der Discovery.
    this.client = mqtt.connect(`mqtts://${host}:${port}`, {
      username: cred.username,
      password: cred.password,
      rejectUnauthorized: false,
      protocolVersion: 4,
      keepalive: 60,
      clientId: `flownt_anycubic_${crypto.randomBytes(4).toString('hex')}`,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
    });

    this.client.on('connect', () => {
      this.lastMsgAt = Date.now();
      this.snapshot = { ...this.snapshot, status: 'idle' };
      console.log('[anycubic] MQTT connected →', host);
      this.client!.subscribe(subTopic, err => { if (err) console.error('[anycubic] subscribe:', err.message); });
      this.queryAll(base);
      if (this.queryTimer) clearInterval(this.queryTimer);
      this.queryTimer = setInterval(() => this.queryAll(base), QUERY_INTERVAL_MS);
    });

    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    this.client.on('reconnect', () => { this.snapshot = { ...this.snapshot, status: 'offline' }; });
    this.client.on('error', err => { this.snapshot = { ...this.snapshot, status: 'offline' }; console.error('[anycubic] mqtt:', err.message); });
    this.client.on('close', () => { this.snapshot = { ...this.snapshot, status: 'offline' }; });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private queryAll(base: string): void {
    for (const type of QUERY_TYPES) {
      this.client?.publish(`${base}/${type}`, JSON.stringify({
        type, action: type === 'multiColorBox' ? 'getInfo' : 'query',
        timestamp: Date.now(), msgid: crypto.randomUUID(), data: null,
      }));
    }
  }

  private onMessage(topic: string, payload: Buffer): void {
    this.lastMsgAt = Date.now();
    // Query-Bestätigungen (.../response, Payload nur {msgid}) tragen keine Nutzdaten.
    if (topic.endsWith('/response')) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    // Typ steht im Envelope; NICHT aus dem Topic ableiten (dort steht die device_id).
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (!type) return;
    if (typeof msg.state === 'string') this.envState[type] = msg.state;
    const data = (msg.data ?? {}) as Record<string, unknown>;
    this.reports[type] = data;

    // print-Reports (action start/update/stop) kommen unaufgefordert und tragen den
    // Job-State im ENVELOPE (printing/stopping/stoped/finished) + Job-Felder in data.
    if (type === 'print' && typeof msg.state === 'string') this.trackJob(msg.state, data);
    // info.data.project ist die redundante Poll-Quelle desselben Jobs (null im Leerlauf).
    if (type === 'info' && data.project && typeof data.project === 'object') {
      const p = data.project as Record<string, unknown>;
      if (typeof p.state === 'string') this.trackJob(p.state, p);
    }

    this.rebuildSnapshot();
  }

  // Führt Job-Infos aus print-Reports und info.project in den Tracker zusammen.
  private trackJob(state: string, data: Record<string, unknown>): void {
    const terminal = mapJobResult(state);
    // Neuer Druck nach gelatchtem Ende → Tracker frisch aufsetzen (sonst klebt das
    // alte jobResult/Gewicht am neuen Druck).
    if (!terminal && this.job?.result) this.job = null;
    const job: JobTracker = this.job ?? { state: '', result: null };

    job.state = state;
    if (terminal) job.result = terminal;
    const file = data.display_filename ?? data.filename;
    if (typeof file === 'string' && file) job.file = basename(file);
    // Job-ID fürs Backend-Dedup: Cloud-task_id wenn vorhanden, sonst Slicer-localtask
    // (UUID). USB-/Display-Drucke haben beides nicht (taskid "-1", localtask "") → undefined.
    const taskid = String(data.taskid ?? data.task_id ?? '');
    const localtask = String(data.localtask ?? '');
    job.sourceJobId = (taskid && taskid !== '-1' ? taskid : '') || localtask || job.sourceJobId;
    if (typeof data.progress === 'number') job.progress = data.progress;
    if (typeof data.remain_time === 'number') job.remainMin = data.remain_time;
    // Kumulativ — beim Terminal-Report steht hier der finale Verbrauch (Capture-belegt).
    if (typeof data.supplies_usage === 'number' && data.supplies_usage > 0) job.suppliesUsage = data.supplies_usage;

    this.job = job;
  }

  // Setzt den Snapshot aus den zuletzt empfangenen Reports zusammen.
  private rebuildSnapshot(): void {
    const info = this.reports['info'] ?? {};
    const temp = this.reports['tempature'] ?? {};
    const infoTemp = (info.temp ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

    const job = this.job;
    // Live-Status: Job-State (auch terminal → mappt auf idle) > status-Envelope
    // ('free'/'busy') > info-Envelope. 'busy' ohne Job-Report bleibt bewusst idle
    // (kann auch Trocknen/Filamentwechsel sein, kein Druck).
    const liveState = job?.state || this.envState['status'] || this.envState['info'] || '';

    this.snapshot = {
      status: mapState(liveState),
      // jobResult bleibt nach dem Terminal-Report gelatcht (bridge.ts konsumiert ihn am
      // Übergang printing → idle); trackJob räumt ihn beim nächsten Druckstart weg.
      jobResult: job?.result ?? null,
      printFile: job?.file,
      sourceJobId: job?.sourceJobId,
      progressPct: job?.progress,
      etaSec: job?.remainMin != null ? job.remainMin * 60 : undefined,
      tempHotend: num(temp.curr_nozzle_temp) ?? num(infoTemp.curr_nozzle_temp),
      tempBed: num(temp.curr_hotbed_temp) ?? num(infoTemp.curr_hotbed_temp),
      parsedFilamentWeights: job?.suppliesUsage
        ? [{ filamentIndex: 0, grams: suppliesToGrams(job.suppliesUsage) }]
        : null,
      amsSlots: this.deriveAmsSlots(),
      activeMqttSlot: this.deriveActiveSlot(),
    };
  }

  // ACE-Box → AmsSlot (Capture-bestätigt an Kobra X, model_id 40002, 4 Slots):
  // color = RGB-Array, type = "PLA"/"PLA Matte"/…, consumables_percent = Rest-%,
  // weight = Spulen-Gesamtgewicht in g. Ohne ACE (S1): multi_color_box = [] → undefined.
  // TODO: extfilbox (externe Spule, S1) hat noch kein Contract-Pendant; humidity der ACE
  // war in allen Captures 0 (Skala unklar) → bewusst nicht gemeldet.
  private deriveAmsSlots(): AmsSlot[] | undefined {
    const box = this.reports['multiColorBox'];
    const boxes = box?.multi_color_box as Array<Record<string, unknown>> | undefined;
    if (!boxes?.length) return undefined;
    const slots: AmsSlot[] = [];
    boxes.forEach((b, unit) => {
      const list = (b.slots ?? []) as Array<Record<string, unknown>>;
      list.forEach((s, i) => {
        const color = Array.isArray(s.color) && s.color.length >= 3
          ? '#' + (s.color as number[]).slice(0, 3).map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase()
          : '';
        slots.push({
          ams_unit: unit,
          slot: typeof s.index === 'number' ? s.index : i,
          material: String(s.type ?? ''),
          color,
          remain: typeof s.consumables_percent === 'number' ? s.consumables_percent : 0,
          tray_weight: typeof s.weight === 'number' ? s.weight : 0,
        });
      });
    });
    return slots.length ? slots : undefined;
  }

  // loaded_slot = physisch geladener ACE-Slot (Capture: 2 während des Drucks, -1 idle).
  private deriveActiveSlot(): number | undefined {
    const box = this.reports['multiColorBox'];
    const boxes = box?.multi_color_box as Array<Record<string, unknown>> | undefined;
    const loaded = boxes?.[0]?.loaded_slot;
    return typeof loaded === 'number' && loaded >= 0 ? loaded : undefined;
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    // Watchdog: TCP kann stehen bleiben, ohne dass 'close' feuert. Queries laufen alle
    // 15 s — bleiben Reports 90 s aus, ist die Verbindung tot (oder LAN-Modus aus).
    if (this.snapshot.status !== 'offline' && this.lastMsgAt && Date.now() - this.lastMsgAt > STALE_AFTER_MS) {
      return { ...this.snapshot, status: 'offline' };
    }
    return this.snapshot;
  }

  dispose(): void {
    this.disposed = true;
    if (this.queryTimer) { clearInterval(this.queryTimer); this.queryTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.client?.removeAllListeners();
    this.client?.end(true);
    this.client = null;
  }
}
