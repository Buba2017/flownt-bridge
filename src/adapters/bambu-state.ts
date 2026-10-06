// Merging of Bambu MQTT reports into one cached printer state.
//
// Printers do not always send the full state: P1/A1 send deltas, X1/X2/H2 send partial
// frames between full ones (only the changed keys, an AMS frame with one unit, a tray
// with only {id, state}). Rebuilding the snapshot from each message made missing keys
// look like "idle" / "no progress" / "no AMS". Here every push_status is merged key by
// key into a cached copy; the snapshot is always derived from that cache.
//
// Everything in this file is pure (no I/O, no timers) so captured frames can be tested.

/** The merged `print` object of the printer's push_status reports. */
export type PrintState = Record<string, any>;

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Normalized id of an element in an id-keyed array ("1" and 1 are the same unit). */
function elementId(v: unknown): string | null {
  if (!isObj(v) || v.id == null) return null;
  const n = typeof v.id === 'number' ? v.id : parseInt(String(v.id), 10);
  return Number.isFinite(n) ? String(n) : String(v.id);
}

// AMS internal temperature above this is a sensor glitch / unit without a sensor.
const MAX_AMS_TEMP_C = 100;

/**
 * Arrays whose elements carry an `id` are merged per element (AMS units, trays, the
 * extruder list, virtual slots …): a frame that lists one unit must not wipe the
 * others. All other arrays (hms, mapping, …) are complete lists and replace the cache.
 */
function mergeArray(prev: unknown, next: unknown[], path: string): unknown[] {
  const ids = next.map(elementId);
  if (next.length === 0 || ids.some(id => id == null)) return next.map(v => clone(v));
  const out = new Map<string, unknown>();
  if (Array.isArray(prev)) for (const v of prev) { const id = elementId(v); if (id != null) out.set(id, v); }
  next.forEach((v, i) => out.set(ids[i]!, mergeValue(out.get(ids[i]!), v, `${path}[]`)));
  return [...out.entries()]
    .sort(([a], [b]) => (Number(a) - Number(b)) || a.localeCompare(b))
    .map(([, v]) => v);
}

function mergeValue(prev: unknown, next: unknown, path: string): unknown {
  if (Array.isArray(next)) return mergeArray(prev, next, path);
  if (isObj(next)) {
    const out: Record<string, unknown> = isObj(prev) ? { ...prev } : {};
    for (const [k, v] of Object.entries(next)) {
      if (path === 'ams.ams[]' && k === 'temp') {
        const t = parseFloat(String(v));
        if (!Number.isFinite(t) || t > MAX_AMS_TEMP_C) continue; // keep the last plausible value
      }
      out[k] = mergeValue(out[k], v, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return next;
}

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

/** Hex bit field as sent by the printer ("9b0", "ef"); null when absent/invalid. */
export function hexBits(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !/^[0-9a-f]+$/i.test(v.trim())) return null;
  return parseInt(v.trim(), 16);
}

export const toInt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Applies the AMS presence bits after a merge:
 * - `ams_exist_bits`: bit n = AMS unit n is connected. Units that are gone are dropped
 *   (only for ids 0–15; AMS HT units are not covered by this field).
 * - `tray_exist_bits`: bit (unit*4 + slot) = a spool is in that slot. This is the only
 *   reliable presence signal — an empty slot and a spool without RFID tag can both look
 *   like `state` 9/10 with an empty type. A slot whose bit is clear loses its cached
 *   spool data, so a removed spool disappears.
 */
function applyPresence(ams: Record<string, any>): void {
  if (!Array.isArray(ams.ams)) return;
  const unitBits = hexBits(ams.ams_exist_bits);
  if (unitBits != null) {
    ams.ams = ams.ams.filter((u: any) => {
      const id = toInt(u?.id);
      return id == null || id >= 16 || (unitBits & (1 << id)) !== 0;
    });
  }
  const trayBits = hexBits(ams.tray_exist_bits);
  if (trayBits == null) return;
  for (const unit of ams.ams) {
    const uid = toInt(unit?.id);
    if (uid == null || uid >= 16 || !Array.isArray(unit.tray)) continue;
    unit.tray = unit.tray.map((t: any) => {
      const sid = toInt(t?.id);
      if (sid == null || sid > 3) return t;
      const present = Math.floor(trayBits / 2 ** (uid * 4 + sid)) % 2 === 1;
      return present ? t : { id: t.id, ...(t.state != null ? { state: t.state } : {}) };
    });
  }
}

/**
 * Merges one push_status `print` object into the cached state and returns the new state
 * (inputs are not modified). Keys missing from the frame keep their cached value.
 */
export function mergePrintState(cache: PrintState, incoming: PrintState): PrintState {
  const merged = mergeValue(cache, incoming, '') as PrintState;
  // Per-frame fields that must not stick around as telemetry.
  delete merged.result;
  delete merged.reason;
  if (isObj(merged.ams)) {
    merged.ams = { ...merged.ams };
    applyPresence(merged.ams);
  }
  return merged;
}

/**
 * Whether a `print` message is telemetry to merge. Anything that is not a push_status
 * — command replies and the printer echoing commands from other clients (gcode_line,
 * project_file, …) — carries command fields, not state. A push_status that answers one
 * of our own commands (result/reason for our sequence_id) is treated the same.
 */
export function isTelemetry(p: PrintState, isOwnCommandReply: boolean): boolean {
  if (p.command !== 'push_status') return false;
  if (isOwnCommandReply && (p.result != null || p.reason != null)) return false;
  return true;
}

const nonZeroId = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s && !/^0+$/.test(s) ? s : null;
};

export interface JobIdentity {
  /** Changes with every new print; null when the printer reports no job at all. */
  key: string | null;
  /** Globally unique job id for the backend's dedup, only when the printer has one. */
  sourceJobId: string | null;
}

/**
 * Identity of the printer's current/last job. Cloud jobs carry `subtask_id` / `job_id`;
 * jobs sent over LAN report `subtask_id: ""` and `job_id: "0"` (seen on X1C, X2D, H2C),
 * only `task_id` changes per job there. That id is a small printer-local number, so it
 * identifies a new print but is not unique enough for the backend dedup. Last resort:
 * the file name.
 */
export function jobIdentity(p: PrintState): JobIdentity {
  const sub = nonZeroId(p.subtask_id);
  if (sub) return { key: `subtask:${sub}`, sourceJobId: sub };
  const job = nonZeroId(p.job_id);
  if (job) return { key: `job:${job}`, sourceJobId: job };
  const task = nonZeroId(p.task_id);
  if (task) return { key: `task:${task}`, sourceJobId: null };
  const name = typeof p.subtask_name === 'string' ? p.subtask_name.trim() : '';
  if (name) return { key: `file:${name}`, sourceJobId: null };
  return { key: null, sourceJobId: null };
}

const ACTIVE = new Set(['PREPARE', 'SLICING', 'RUNNING', 'PAUSE']);
const ENDED = new Set(['FINISH', 'FAILED', 'IDLE', '']);
export const isActiveGcodeState = (s: string | undefined) => s !== undefined && ACTIVE.has(s.toUpperCase());

/**
 * A new print started: the job identity changed while the printer is busy, or the
 * printer went from an ended state back to busy (the same file printed again).
 */
export function isNewJob(prevKey: string | null, prevGcodeState: string | undefined, key: string | null, gcodeState: string | undefined): boolean {
  if (!isActiveGcodeState(gcodeState) || key == null) return false;
  if (key !== prevKey) return true;
  return prevGcodeState !== undefined && ENDED.has(prevGcodeState.toUpperCase());
}
