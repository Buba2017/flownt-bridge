import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { Adapter, AmsSlot, FilamentWeight, JobResult, PrinterSnapshot } from './types.js';

// ── Anycubic Kobra LAN-Adapter (SPIKE — unvalidiert) ─────────────────────────────
// Bindet Anycubic Kobra X / S1 (und vermutlich Kobra 3-Serie) über den lokalen
// LAN-Modus an: Credential-Discovery per HTTP (Port 18910, AES-CBC) → persistentes
// MQTT über TLS (Port 9883) → periodische Report-Queries. Read-only.
//
// Protokoll-Details + Belege: docs/anycubic-lan-protocol.md
// Muster: persistente MQTT-Verbindung wie BambuAdapter (nicht HTTP-Poll wie Moonraker).
//
// ⚠️ MIT «TODO(hw)» markierte Stellen müssen gegen echte Payloads aus scripts/
//    anycubic-probe.mjs bestätigt/justiert werden, bevor das produktiv geht.

const CTRL_PORT = 18910;
const MQTT_PORT_FALLBACK = 9883;
const QUERY_TYPES = ['status', 'info', 'tempature', 'fan', 'light', 'peripherie', 'multiColorBox'] as const;
const QUERY_INTERVAL_MS = 15_000;

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

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const nonce = (n: number) => Array.from({ length: n }, () =>
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[crypto.randomInt(62)]).join('');

// state-String → Flownt-Status. paused bleibt hier paused (bridge.ts mappt es beim Push).
function mapState(state: string): PrinterSnapshot['status'] {
  const s = state.toLowerCase();
  if (['printing', 'updated', 'resuming', 'resumed', 'preheating', 'checking', 'auto_leveling',
       'downloading', 'slicing', 'vibrating', 'flow_calibrating'].includes(s)) return 'printing';
  if (['pausing', 'paused'].includes(s)) return 'paused';
  if (['failed', 'error'].includes(s)) return 'error';
  return 'idle'; // finished, stopped, cancelled, idle, ready, standby, …
}

// Normalisierter Job-Ausgang. finished≠stopped (Abbruch darf nicht als Erfolg abgebucht werden).
function mapJobResult(state: string, code?: number): JobResult | null {
  const s = state.toLowerCase();
  if (['finished', 'finish', 'completed', 'done'].includes(s)) return 'completed';
  if (['cancelled', 'canceled', 'stopping', 'stopped', 'stoped'].includes(s)) return 'aborted';
  if (['failed', 'error'].includes(s) || (code != null && code !== 0 && code !== 200)) return 'failed';
  return null;
}

// supplies_usage (mm) → Gramm (1,75 mm, Faktor 1,23) — Fallback wenn kein *_g-Feld.
function mmToGrams(mm: number): number {
  return Math.round((((Math.PI * (1.75 / 2) * 1.75) / 2) * mm * 1.23) / 1000 * 100) / 100;
}

export class AnycubicAdapter implements Adapter {
  private host: string;
  private printerId: string;
  private client: mqtt.MqttClient | null = null;
  private queryTimer: ReturnType<typeof setInterval> | null = null;
  private snapshot: PrinterSnapshot = { status: 'offline' };
  // Letzte Roh-Reports je Typ (msg.data). Reports kommen getrennt; Snapshot wird zusammengesetzt.
  private reports: Record<string, Record<string, unknown>> = {};
  // Envelope-State je Typ (msg.state) — der Drucker-/Job-Status liegt auf dem Envelope,
  // nicht unter msg.data (bei 'status' ist msg.data sogar null). Bestätigt an S1-Capture.
  private envState: Record<string, string> = {};

  constructor(host: string, printerId = '') {
    this.host = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.printerId = printerId;
    this.connect().catch(err => console.error('[anycubic] init:', err));
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
    const cred = await this.discover();
    const typeId = String(cred.modeId ?? cred.modelId);
    const deviceId = cred.deviceId;
    let host = this.host, port = MQTT_PORT_FALLBACK;
    try { const u = new URL(cred.broker ?? ''); host = u.hostname || this.host; port = Number(u.port) || MQTT_PORT_FALLBACK; } catch { /* Fallback */ }

    const base = `anycubic/anycubicCloud/v1/web/printer/${typeId}/${deviceId}`;
    const subTopic = `anycubic/anycubicCloud/v1/printer/+/${typeId}/${deviceId}/#`;

    // TODO(hw): grunna verbindet ohne Client-Cert, stribor lädt devicecrt/devicepk optional.
    // Erst ohne testen; falls Connect scheitert, cred.devicecrt/devicepk via `cert`/`key` ergänzen.
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
      this.snapshot = { status: 'idle' };
      console.log('[anycubic] MQTT connected →', host);
      this.client!.subscribe(subTopic, err => { if (err) console.error('[anycubic] subscribe:', err.message); });
      this.queryAll(base);
      this.queryTimer = setInterval(() => this.queryAll(base), QUERY_INTERVAL_MS);
    });

    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    this.client.on('reconnect', () => { this.snapshot = { ...this.snapshot, status: 'offline' }; });
    this.client.on('error', err => { this.snapshot = { ...this.snapshot, status: 'offline' }; console.error('[anycubic] mqtt:', err.message); });
    this.client.on('close', () => { this.snapshot = { ...this.snapshot, status: 'offline' }; });
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
    // Query-Bestätigungen (.../response, Payload nur {msgid}) tragen keine Nutzdaten.
    if (topic.endsWith('/response')) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    // Typ steht im Envelope; NICHT aus dem Topic ableiten (dort steht die device_id).
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (!type) return;
    // Envelope trägt state (Drucker-/Job-Status); die eigentlichen Felder liegen unter msg.data.
    if (typeof msg.state === 'string') this.envState[type] = msg.state;
    this.reports[type] = (msg.data ?? {}) as Record<string, unknown>;
    this.rebuildSnapshot();
  }

  // Setzt den Snapshot aus den zuletzt empfangenen Reports zusammen.
  // Bestätigt am S1-Capture (idle): tempature-Feldnamen, Envelope-state, /response-ACKs.
  // TODO(hw): NOCH OFFEN bis zu einer Capture WÄHREND eines Drucks — Live-Druckstatus-Quelle
  // (Erwartung: envState['status'] → 'printing'), Terminal-Strings (finished/stopped/failed),
  // Job-Felder (progress/remain_time/filename) und Gramm (estimate_supplies_usage_g).
  private rebuildSnapshot(): void {
    const info = this.reports['info'] ?? {};
    const temp = this.reports['tempature'] ?? {};
    // Aktiver Job: info.data.project (im Leerlauf null → kein jobResult, kein Fehl-Abzug).
    const project = (info.project ?? {}) as Record<string, unknown>;
    const jobState = String(project.state ?? '');
    // Live-Druckerstatus: aktiver Job > status-Envelope ('free' idle) > info-Envelope ('done').
    const liveState = jobState || this.envState['status'] || this.envState['info'] || '';
    const code = typeof project.code === 'number' ? project.code : undefined;
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

    this.snapshot = {
      status: mapState(liveState),
      // jobResult nur aus einem aktiven Job ableiten — nicht aus dem persistenten
      // info-Envelope 'done' (das würde bei jedem Poll fälschlich 'completed' melden).
      jobResult: jobState ? mapJobResult(jobState, code) : null,
      printFile: (project.filename ?? project.name) as string | undefined,
      progressPct: num(project.progress),
      etaSec: num(project.remain_time) != null ? (project.remain_time as number) * 60 : undefined,
      tempHotend: num(temp.curr_nozzle_temp),
      tempBed: num(temp.curr_hotbed_temp),
      parsedFilamentWeights: this.deriveWeights(project),
      amsSlots: this.deriveAmsSlots(),
      activeMqttSlot: this.deriveActiveSlot(),
    };
  }

  // TODO(hw): Bei Multi-Color liefert das Protokoll evtl. print_filaments_weight (per Slot).
  // Vorerst nur Gesamtverbrauch als eine Zeile (filamentIndex 0); Slot-Zuordnung übernimmt
  // bridge.ts wie bei Moonraker/Prusa per Material-Slot-Konfiguration.
  private deriveWeights(project: Record<string, unknown>): FilamentWeight[] | null {
    const g = project.estimate_supplies_usage_g;
    if (typeof g === 'number' && g > 0) return [{ filamentIndex: 0, grams: g }];
    const mm = project.supplies_usage;
    if (typeof mm === 'number' && mm > 0) return [{ filamentIndex: 0, grams: mmToGrams(mm) }];
    return null;
  }

  // TODO(hw): multiColorBox-Struktur an echten getInfo-Payloads bestätigen.
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

  private deriveActiveSlot(): number | undefined {
    const box = this.reports['multiColorBox'];
    const boxes = box?.multi_color_box as Array<Record<string, unknown>> | undefined;
    const loaded = boxes?.[0]?.loaded_slot;
    return typeof loaded === 'number' ? loaded : undefined;
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    return this.snapshot;
  }
}
