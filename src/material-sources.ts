import type { AmsSlot } from './adapters/types.js';
import type { MaterialLine } from './contract.js';
import { EXTERNAL_SLOT, slotIndex } from './job-materials.js';

// Usage sources for jobs whose print file the bridge could not read (H2C/X2D jobs in the
// printer's internal storage, files missing on the SD card, FTPS failures). Pure
// functions, so the matching and the arithmetic are unit-tested (material-sources.test.ts).
//
// Order used by the bridge: slicer file (exact, see job-materials.ts) → Bambu Cloud task
// (the slicer weights per AMS tray, recorded by Bambu for jobs the cloud knows) → RFID
// remaining-% drop (estimate, Bambu spools only) → none: the job goes out flagged
// `material_unknown`.

/** One AMS tray used by a cloud task (`amsDetailMapping[]`). */
export interface CloudAmsUse {
  /** Bambu tray id: AMS unit × 4 + slot, 128+ for AMS HT, 254/255 for the external spool. */
  ams: number;
  weight: number;
  filamentType?: string;
  color?: string;
}

/** A print task from the Bambu Cloud history (`GET /v1/user-service/my/tasks`). */
export interface CloudTask {
  id: string;
  deviceId: string;
  title: string;
  startTime: number | null;   // epoch ms
  endTime: number | null;     // epoch ms
  weight: number | null;      // total grams
  /** Slicer-predicted print time in seconds. */
  costTime: number | null;
  /** Bambu task status: 2 = finished, 3 = failed/cancelled (others: running, queued). */
  status: number | null;
  /** Plate thumbnail (PNG, signed URL valid for a while), null if none. */
  cover: string | null;
  ams: CloudAmsUse[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const time = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** "FF6600FF" / "#ff6600" → "#FF6600"; undefined otherwise. */
export function normalizeHex(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim());
  return m ? `#${m[1].toUpperCase()}` : undefined;
}

/** Parses the `hits` of a cloud task response; malformed entries are skipped. */
export function parseCloudTasks(data: unknown): CloudTask[] {
  const hits = (data && typeof data === 'object' ? (data as { hits?: unknown }).hits : null);
  if (!Array.isArray(hits)) return [];
  const out: CloudTask[] = [];
  for (const h of hits) {
    if (!h || typeof h !== 'object') continue;
    const x = h as Record<string, unknown>;
    const id = x.id != null ? String(x.id) : '';
    const deviceId = typeof x.deviceId === 'string' ? x.deviceId : '';
    if (!id || !deviceId) continue;
    const mapping = Array.isArray(x.amsDetailMapping) ? x.amsDetailMapping : [];
    const ams: CloudAmsUse[] = [];
    for (const m of mapping) {
      if (!m || typeof m !== 'object') continue;
      const y = m as Record<string, unknown>;
      const tray = num(y.ams);
      const weight = num(y.weight);
      if (tray == null || weight == null || weight <= 0) continue;
      ams.push({
        ams: tray, weight,
        filamentType: typeof y.filamentType === 'string' && y.filamentType ? y.filamentType : undefined,
        color: normalizeHex(y.targetColor) ?? normalizeHex(y.sourceColor),
      });
    }
    out.push({
      id, deviceId,
      title: typeof x.title === 'string' ? x.title : typeof x.designTitle === 'string' ? x.designTitle : '',
      startTime: time(x.startTime), endTime: time(x.endTime), weight: num(x.weight),
      costTime: num(x.costTime), status: num(x.status),
      cover: typeof x.cover === 'string' && /^https:\/\//.test(x.cover) ? x.cover : null, ams,
    });
  }
  return out;
}

/** Bambu tray id → Flownt slot index (unit*4+slot, 128+ AMS HT, 254 external); null if unusable. */
export function cloudSlot(tray: number): number | null {
  if (!Number.isInteger(tray)) return null;
  if (tray < 0 || tray === 254 || tray === 255 || tray === 65535) return EXTERNAL_SLOT;
  if (tray >= 128 && tray < 254) return tray;
  if (tray < 64) return tray;
  return null;
}

const normTitle = (s: string) => s.toLowerCase().replace(/\.(gcode\.)?3mf$/i, '').replace(/[\s_]+/g, ' ').trim();

export interface TaskCriteria {
  serial: string;
  /** Raw printer ids of the job (task_id / subtask_id / job_id). */
  ids: string[];
  startedAt: number;
  finishedAt: number;
  title?: string;
}

const WINDOW_MS = 20 * 60_000;

/**
 * The cloud task of a job: by id when the printer reported one the cloud knows, else the
 * task on the same printer whose start (or end) is closest to the job's, within 20 min.
 * Without a matching title the time difference must be under 10 min.
 */
export function matchCloudTask(tasks: CloudTask[], c: TaskCriteria): CloudTask | null {
  const own = tasks.filter(t => t.deviceId.toUpperCase() === c.serial.toUpperCase());
  const ids = new Set(c.ids.filter(Boolean));
  const byId = own.find(t => ids.has(t.id));
  if (byId) return byId;
  const title = c.title ? normTitle(c.title) : '';
  let best: { t: CloudTask; d: number } | null = null;
  for (const t of own) {
    const ds = t.startTime != null ? Math.abs(t.startTime - c.startedAt) : Infinity;
    const de = t.endTime != null ? Math.abs(t.endTime - c.finishedAt) : Infinity;
    const d = Math.min(ds, de);
    if (d > WINDOW_MS) continue;
    const titleOk = !!title && normTitle(t.title) === title;
    if (!titleOk && d > WINDOW_MS / 2) continue;
    const score = titleOk ? d : d + WINDOW_MS; // a matching title wins over a closer time
    if (!best || score < best.d) best = { t, d: score };
  }
  return best?.t ?? null;
}

export interface TemplateCriteria {
  serial: string;
  title: string;
  /** Planned print time of this job in minutes (printer's estimate at the start). */
  estimatedMin: number;
  /** Only runs started before this (epoch ms). */
  before: number;
}

/**
 * An earlier finished run of the same job: same printer, same title, planned time within
 * 10 % (at least 5 min). Jobs of the same name differ per plate (6.7 g / 33 min up to
 * 237 g / 632 min for one "Oberschale"), so the time is what tells the plate apart.
 */
export function templateCloudTask(tasks: CloudTask[], c: TemplateCriteria): CloudTask | null {
  if (!(c.estimatedMin > 0) || !c.title) return null;
  const title = normTitle(c.title);
  const tol = Math.max(0.1 * c.estimatedMin, 5);
  const fits = tasks.filter(t => t.deviceId.toUpperCase() === c.serial.toUpperCase() && t.status === 2
    && normTitle(t.title) === title && t.costTime != null && Math.abs(t.costTime / 60 - c.estimatedMin) <= tol
    && (t.startTime ?? 0) < c.before && t.ams.length > 0);
  fits.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  return fits[0] ?? null;
}

/**
 * Cloud task whose plate thumbnail fits a running job: the job's own task (by id, or same
 * title started within 20 min), else an earlier finished run of the same plate.
 */
export function previewTask(tasks: CloudTask[], c: TaskCriteria & { estimatedMin: number | null }): CloudTask | null {
  const withCover = tasks.filter(t => t.cover);
  const own = matchCloudTask(withCover, c);
  if (own && (!c.title || normTitle(own.title) === normTitle(c.title))) return own;
  return c.estimatedMin && c.title
    ? templateCloudTask(withCover, { serial: c.serial, title: c.title, estimatedMin: c.estimatedMin, before: c.startedAt })
    : null;
}

const trayUuidOf = (slots: AmsSlot[], idx: number): string | null => {
  if (idx === EXTERNAL_SLOT) return null;
  return slots.find(s => slotIndex(s.ams_unit, s.slot) === idx)?.tray_uuid ?? null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Material lines from a cloud task. `fraction` < 1 (failed/cancelled job) scales the
 * slicer weights by the share printed, like the slicer-file path does.
 */
export function cloudTaskLines(
  task: CloudTask, slots: AmsSlot[], fraction: number | null = null,
  opts: { template?: boolean; activeSlot?: number | null } = {},
): MaterialLine[] {
  const partial = fraction != null && fraction < 1;
  const lines: MaterialLine[] = [];
  // A template's single filament was printed from whatever slot it sat in back then; this
  // run used the slot the printer reported as active.
  const single = task.ams.length === 1 && opts.template && opts.activeSlot != null ? opts.activeSlot : null;
  for (const u of task.ams) {
    const idx = single ?? cloudSlot(u.ams);
    if (idx == null) continue;
    const grams = round2(u.weight * (partial ? Math.max(0, fraction!) : 1));
    if (grams <= 0) continue;
    lines.push({
      filamentIndex: idx, grams, color: u.color, filament_type: u.filamentType ?? null,
      slotRef: { source: 'ams', value: idx },
      measureSource: partial ? 'estimated_partial' : opts.template ? 'template' : 'bambu_cloud',
      estimated_grams: round2(u.weight),
      tray_uuid: trayUuidOf(slots, idx),
    });
  }
  return lines;
}

/**
 * Usage estimate from the RFID remaining-% of each slot between the job's first and last
 * AMS state: (start − end) % × the spool's nominal weight. Only slots that kept the same
 * RFID spool and report a remaining value (Bambu spools) count. A job adopted mid-print
 * (start taken at p % progress, p < 50) is extrapolated to the whole job; later adoptions
 * give no estimate. Resolution is about 1 % of the spool (10 g on a 1 kg spool).
 */
export function amsRemainLines(start: AmsSlot[] | undefined, end: AmsSlot[], startProgressPct = 0): MaterialLine[] {
  if (!start?.length || !end.length || startProgressPct >= 50) return [];
  const scale = startProgressPct > 0 ? 100 / (100 - startProgressPct) : 1;
  const lines: MaterialLine[] = [];
  for (const e of end) {
    if (!e.tray_uuid || !(e.remain >= 0)) continue;
    const s = start.find(x => x.ams_unit === e.ams_unit && x.slot === e.slot);
    if (!s || s.tray_uuid !== e.tray_uuid || !(s.remain >= 0)) continue;
    const drop = s.remain - e.remain;
    if (drop <= 0 || drop > 100) continue;
    const nominal = e.tray_weight > 0 ? e.tray_weight : s.tray_weight > 0 ? s.tray_weight : 1000;
    const grams = Math.round((drop / 100) * nominal * scale);
    if (grams <= 0) continue;
    const idx = slotIndex(e.ams_unit, e.slot);
    lines.push({
      filamentIndex: idx, grams, color: normalizeHex(e.color), filament_type: e.material || null,
      slotRef: { source: 'ams', value: idx },
      measureSource: 'ams_remain',
      tray_uuid: e.tray_uuid,
    });
  }
  return lines;
}
