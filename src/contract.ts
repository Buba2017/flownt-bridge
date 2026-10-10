// AUTO-GENERIERT aus supabase/functions/_shared/contract.ts — NICHT editieren!
// Änderungen in der kanonischen Quelle machen, dann: npm run sync:contract
// ── Bridge → Flownt: Event-/Ingest-Vertrag (Single Source of Truth) ──────────────
//
// KANONISCHE QUELLE: supabase/functions/_shared/contract.ts
// Konsumenten:
//   - Backend  : supabase/functions/bridge-ingest/index.ts (direkter Import)
//   - Frontend : src/App.tsx, src/components/* (direkter `import type`)
//   - Bridge   : bridge/src/contract.ts — GENERIERTE KOPIE (eigenes Repo, daher kein
//                direkter Import). Nach Änderungen hier: `npm run sync:contract`;
//                Drift wird von `npm run check:contract` erkannt.
//
// Diese Datei ist bewusst selbst-enthaltend (keine Imports), damit sie unverändert in
// Deno (Edge Function), Node ESM (Bridge) und Vite (Frontend) funktioniert.
//
// Stufen-Historie: Stufe A verankerte die gesendete Form als typisierten Vertrag;
// Stufe B abstrahierte die Slot-/Spulen-Identität (`MaterialLine`/`SlotRef`);
// C bringt Moonraker auf Parität (job_failed, Slot-Ref).

/**
 * Contract version. Bump on every change to the wire format; the bridge sends it as
 * `contract_version`, bridge-ingest warns (but still accepts) when it is older.
 * 1 = everything before the field existed, 2 = job timing/outcome/partial usage/tray_uuid,
 * 3 = more usage sources (Bambu Cloud per slot, AMS remaining-% estimate), slicer filament
 * identity per line, `material_unknown`, cloud token secrets.
 */
export const CONTRACT_VERSION = 3;

/** Kanonische Event-Typen, die die Bridge an Flownt sendet. */
export type EventType = 'heartbeat' | 'status_update' | 'job_complete' | 'job_failed' | 'job_file';

/**
 * Drucker-Status auf Adapter-/Snapshot-Ebene. Hinweis zur Wire-Ebene: die Bridge mappt
 * `paused` → `printing` vor dem Senden; `bridge-ingest` akzeptiert stattdessen zusätzlich
 * das nutzergesetzte `maintenance` (siehe INGEST_ACCEPTED_STATUSES).
 */
export type PrinterStatus = 'idle' | 'printing' | 'paused' | 'error' | 'offline';

/**
 * Von `bridge-ingest` akzeptierte Werte für `printer_status` auf dem Wire.
 * Bewusst als `readonly string[]` typisiert, damit der Check gegen beliebige
 * Status-Strings (inkl. dem nie gesendeten `paused`) kompiliert.
 */
export const INGEST_ACCEPTED_STATUSES: readonly string[] = ['idle', 'printing', 'maintenance', 'offline', 'error'];

/**
 * Finer job state than `printer_status` (Bambu gcode_state):
 * - `preparing`: heating, levelling, calibrating before the first layer (PREPARE/SLICING).
 *   `printer_status` is already `printing` then — the printer is busy.
 * - `finished` / `failed`: the last job ended (FINISH/FAILED); the plate may still be full.
 */
export type JobState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'failed';

/** Active printer health message (Bambu HMS). */
export interface HmsAlert {
  /** "XXXX_XXXX_XXXX_XXXX", as shown on the printer and in the Bambu wiki. */
  code: string;
  severity: 'fatal' | 'serious' | 'common' | 'info' | 'unknown';
}

/** Ein AMS-Slot im Live-Zustand (Element von `ams_state` / `printers.live_ams_state`). */
export interface AmsSlot {
  ams_unit: number;    // 0–3 (für daisy-chained AMS)
  slot: number;        // 0–3
  material: string;    // "PLA", "PETG", …
  color: string;       // "#FF6600" (normalisiert von Bambu "0xFFAA00")
  remain: number;      // 0–100 %
  tray_weight: number; // Gesamtgewicht der Spule in g (für optionale Gramm-Schätzung)
  // Bambu RFID spool data (only for Bambu spools with a readable tag; null otherwise).
  /** Spool identity from the RFID tag — identical for both tags of a spool. */
  tray_uuid?: string | null;
  /** UID of the RFID chip that was read. */
  tag_uid?: string | null;
  /** Bambu filament code (tray_info_idx), e.g. "GFA00" = PLA Basic. */
  filament_code?: string | null;
  /** Product line, e.g. "PLA Basic", "PLA Matte", "Support for PLA". */
  sub_brand?: string | null;
  diameter_mm?: number | null;
  nozzle_temp_min?: number | null;
  nozzle_temp_max?: number | null;
}

/** Detected AMS / multi-material unit (element of `ams_units` / `printers.live_ams_units`). */
export interface AmsUnitInfo {
  /** Unit id as reported by the printer (AMS 0–3; AMS HT starts at 128). */
  ams_unit: number;
  /** Model from the printer's module list (Bambu get_version), null if unknown. */
  model: 'AMS' | 'AMS Lite' | 'AMS 2 Pro' | 'AMS HT' | null;
  slot_count: number;
  /** Unit can heat/dry filament (AMS 2 Pro, AMS HT). */
  can_dry: boolean;
  drying?: { active: boolean; temp_c?: number | null; remaining_min?: number | null } | null;
}

/** Luftfeuchte je AMS-Einheit (Element von `ams_humidity` / `printers.live_ams_humidity`). */
export interface AmsHumidityUnit {
  ams_unit: number;       // 0–3
  humidity: number;       // 1–5 Trockenheits-Stufe im MQTT-Wert: 5=trocken/gut, 1=sehr feucht
                          // (invertiert ggü. der Bambu-A–E-Anzeige, A=trocken). Frontend-Mapping in AmsVisual.
  humidity_pct?: number;  // echte rel. Luftfeuchte in % — nur AMS 2 Pro / AMS HT; Original-AMS liefern nur die Stufe
  temp: number;           // °C (Innentemperatur der AMS-Einheit)
}

/**
 * Quell-abstrahierte Slot-/Lagerplatz-Referenz (Stufe B).
 * Entkoppelt die Identität von der Vendor-Quelle: heute AMS-Readout, künftig NFC-Tag.
 *  - `ams`          → `value` = globaler AMS-Index (unit*4+slot); 254 = externe Spule (kein AMS-Link)
 *  - `slicer_order` → `value` = 0-basierte Slicer-Filament-Reihenfolge (kein physischer Slot bekannt, z. B. Moonraker)
 *  - `nfc`          → `value` = (künftig) NFC-Tag-abgeleitete Slot-/Spulen-Identität
 */
export interface SlotRef {
  source: 'ams' | 'slicer_order' | 'nfc';
  value: number;
}

/**
 * Eine verbrauchte Materialzeile im `job_complete`. Trägt die Gramm, die quell-abstrahierte
 * Slot-Referenz und die Messquelle. Die gematchte Spule (spoolRef) wird im Backend
 * (bridge-ingest) gegen den Bestand aufgelöst und von der Bridge NICHT gesetzt.
 * `filamentIndex` bleibt als Kompatibilitäts-Feld mit unveränderter Bedeutung erhalten —
 * das Backend liest weiterhin dieses Feld (kein Bruch).
 */
export interface MaterialLine {
  filamentIndex: number;                          // Kompat — heutige Semantik, unverändert
  grams: number;
  /** Filament colour the slicer used for this line ("#RRGGBB"). */
  color?: string;
  /** Filament type the slicer used for this line, e.g. "PLA", "ABS-GF" (contract ≥ 3). Shown
   *  on the print log when no spool can be matched. */
  filament_type?: string | null;
  slotRef: SlotRef;                               // abstrahierte Slot-/Lagerplatz-Identität
  /**
   * Source of `grams`:
   * - `slicer_file` / `bambu_cloud`: full usage of a finished job.
   * - `estimated_partial`: a failed/cancelled job; slicer grams scaled by the progress
   *   reached (`estimated_grams` holds the unscaled slicer value).
   * - `template`: slicer grams of an earlier run of the same job (same printer, same name,
   *   planned time within 10 %), e.g. from the Bambu Cloud history (contract ≥ 3).
   * - `ams_remain`: estimate from the drop of the RFID remaining-% between job start and end
   *   times the spool's nominal weight (contract ≥ 3). Coarse: only used when nothing else is
   *   known, the backend replaces it with a template where one exists.
   */
  measureSource: 'slicer_file' | 'bambu_cloud' | 'estimated_partial' | 'ams_remain' | 'template';
  /** Slicer estimate for the whole job in g (contract ≥ 2). */
  estimated_grams?: number;
  /**
   * RFID spool identity (Bambu tray_uuid) seen in the slot this line was printed from,
   * null for spools without a readable tag (contract ≥ 2). The backend books against the
   * spool with this `rfid_uid` first and only falls back to the slot's storage location.
   */
  tray_uuid?: string | null;
}

/**
 * Print file of a job (Bambu .gcode.3mf from the SD card), stored for the print log
 * (contract ≥ 3). Two steps through bridge-ingest with event_type 'job_file':
 *   1. announce it (`done` absent): Flownt answers `exists` (same content stored already,
 *      it is linked to the job) or `upload` with a signed URL the bridge PUTs the file to;
 *   2. after the upload, the same body with `done: true` links the stored file to the job.
 * Files are keyed by SHA-256, so a plate printed again is stored once per printer.
 */
export interface JobFileRef {
  source_job_id: string;
  file_name: string;
  /** Lower-case hex SHA-256 of the file. */
  sha256: string;
  size_bytes: number;
  done?: boolean;
}

export interface JobFileResponse {
  status: 'exists' | 'upload' | 'stored' | 'too_large';
  /** Absolute URL for an HTTP PUT of the file (status 'upload'). */
  upload_url?: string;
}

/** Largest print file Flownt stores. */
export const JOB_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** How a job ended (contract ≥ 2). */
export type JobOutcome = 'completed' | 'failed' | 'cancelled';

/** Slicer plate thumbnail of a print job (Bambu: Metadata/plate_<n>.png in the .3mf). */
export interface PrintPreview {
  print_file: string;
  png_base64: string;
}

/**
 * Wire-Body des POST an `${FLOWNT_EDGE_URL}/bridge-ingest`.
 * Pflicht: `auth_token` + `event_type`. Alle übrigen Felder sind optional und entsprechen
 * 1:1 den heute gesendeten Schlüsseln. `filament_weights`/`cloud_weight_g`/`energy_wh`
 * werden ausschließlich bei `job_complete` befüllt.
 */
export interface IngestBody {
  auth_token: string;
  event_type: EventType;
  bridge_version?: string;  // gemeldete Bridge-Version (für Update-/Abhängigkeits-Hinweise in Flownt)
  // Status (status_update + job_complete)
  printer_status?: PrinterStatus;
  print_file?: string;
  progress_pct?: number;
  temp_hotend?: number;
  temp_bed?: number;
  eta_s?: number;
  duration_min?: number;
  /** Unique job id (job_complete and, from contract 2, job_failed). The backend books a
   *  job at most once per (printer, source_job_id), so the bridge may resend freely. */
  source_job_id?: string;
  live_power_w?: number;
  ams_state?: AmsSlot[];
  ams_active_slot?: number;
  ams_humidity?: AmsHumidityUnit[];
  ams_units?: AmsUnitInfo[];
  /** Plate preview of the running job (PNG rendered by the slicer, taken from the print
   *  file). Sent once per job; `print_file` identifies the job it belongs to. */
  print_preview?: PrintPreview;
  job_state?: JobState;
  /** Active HMS messages (empty array = none). */
  hms?: HmsAlert[];
  /** Printer error code "MMMM_EEEE" of the current/last job, null if none. */
  print_error?: string | null;
  /** Wire format version of this body (CONTRACT_VERSION); absent = 1. */
  contract_version?: number;
  // job_complete / job_failed (contract ≥ 2): timing and outcome
  /** Job start, ISO 8601 UTC (from the printer's job start where available). */
  started_at?: string;
  /** Job end, ISO 8601 UTC, taken when the bridge saw the job end (not when it was sent). */
  finished_at?: string;
  /** Slicer-predicted print time in minutes. */
  estimated_duration_min?: number;
  outcome?: JobOutcome;
  /** Why a job failed: printer error "MMMM_EEEE" or the most severe HMS code; null if unknown. */
  failure_reason?: string | null;
  /** Progress (0–100) reached before a job failed or was cancelled. */
  last_progress_pct?: number;
  // job_complete (full) / job_failed (partial, contract ≥ 2): verbrauchtes Material +
  // optionale Mess-/Energie-Quellen
  filament_weights?: MaterialLine[];
  cloud_weight_g?: number;
  energy_wh?: number;
  /**
   * True when the bridge found no usage source at all for this job (no slicer file, no
   * cloud record, no RFID estimate; contract ≥ 3). The log is then flagged "material
   * missing" instead of silently booking 0 g.
   */
  material_unknown?: boolean;
  /** event_type 'job_file' only (contract ≥ 3). */
  job_file?: JobFileRef;
}

// ── Bridge link (bridge-sync): pairing, central configuration, discovery ──────────
//
// A bridge is paired once with a one-time code from Flownt (Printers → Bridge). After
// that it syncs periodically: it reports LAN-discovered printers and per-printer state,
// and receives the printers assigned to it plus printer secrets (LAN access codes)
// encrypted to its own RSA-OAEP (SHA-256) public key. Flownt never stores secrets in
// plaintext; a delivered secret is deleted once the bridge acknowledges it.

/** A printer seen on the LAN (Bambu SSDP announcement). */
export interface DiscoveredDevice {
  serial: string;
  /** Vendor model code from the announcement, e.g. "BL-P001" (X1C), "N6" (X2D). */
  model_code: string | null;
  /** Device name as set on the printer, e.g. "3DP-1 (H2C)". */
  name: string | null;
  ip: string;
  vendor: 'bambu';
  seen_at: string;
}

export interface BridgePairRequest {
  action: 'pair';
  pairing_code: string;
  /** SPKI PEM of the bridge's RSA-OAEP key pair. */
  public_key: string;
  name?: string;
  bridge_version?: string;
}

export interface BridgePairResponse {
  bridge_id: string;
  bridge_token: string;
  name: string;
}

/** Per-printer state the bridge reports back (no secrets). */
export interface LinkedPrinterState {
  printer_id: string;
  has_access_code: boolean;
  connected: boolean;
  /** The bridge holds a Bambu Cloud session for this printer (cloud task history; optional). */
  has_cloud_token?: boolean;
}

export interface BridgeSyncRequest {
  action: 'sync';
  bridge_token: string;
  bridge_version?: string;
  /** Public HTTPS base URL of this bridge (camera streaming), if configured. */
  public_url?: string | null;
  discovered: DiscoveredDevice[];
  printers: LinkedPrinterState[];
  /** Secret ids applied since the last sync; Flownt deletes them. */
  acked_secrets: string[];
}

/** A printer assigned to this bridge in Flownt. */
export interface LinkedPrinterConfig {
  printer_id: string;
  name: string;
  adapter_type: 'bambu' | 'moonraker' | 'prusa';
  adapter_url: string;
  device_serial: string;
  /** Per-printer ingest token (printer_bridge_configs.auth_token). */
  auth_token: string;
  enabled: boolean;
}

export interface BridgeSecret {
  id: string;
  printer_id: string;
  /**
   * - `access_code`: the printer's LAN access code.
   * - `bambu_cloud_token`: Bambu Cloud session of the account the printer is bound to,
   *   JSON `{"access_token","refresh_token","expires_at"}` (contract ≥ 3). The bridge reads the
   *   cloud task history with it to book usage of jobs whose file it cannot read.
   */
  kind: 'access_code' | 'bambu_cloud_token';
  /** base64 RSA-OAEP(SHA-256) ciphertext for the bridge's public key. */
  ciphertext: string;
}

export interface BridgeSyncResponse {
  bridge_id: string;
  name: string;
  printers: LinkedPrinterConfig[];
  secrets: BridgeSecret[];
}

/**
 * Bambu SSDP model codes → model names in the printer catalog (best effort; unknown
 * codes fall back to the model in parentheses of the device name, e.g. "3DP-1 (H2C)").
 */
export const BAMBU_MODEL_CODES: Readonly<Record<string, string>> = {
  'BL-P001': 'X1C', 'BL-P002': 'X1', 'C13': 'X1E',
  'C11': 'P1P', 'C12': 'P1S',
  'N1': 'A1 mini', 'N2S': 'A1',
  'O1D': 'H2D', 'O1C2': 'H2C',
  'N6': 'X2D',
};
