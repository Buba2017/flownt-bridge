// AmsSlot, AmsHumidityUnit und PrinterStatus leben jetzt im geteilten Contract
// (contract.ts, generiert aus supabase/functions/_shared/contract.ts im Haupt-Repo).
// Re-Export, damit bestehende Importe aus adapters/types.js weiter funktionieren.
export type { AmsSlot, AmsHumidityUnit, AmsUnitInfo, HmsAlert, JobState, PrinterStatus } from '../contract.js';
import type { AmsSlot, AmsHumidityUnit, AmsUnitInfo, HmsAlert, JobState, PrinterStatus } from '../contract.js';

// Normalisierter Job-Ausgang (Stufe C). Vom Adapter beim Terminal-Zustand gesetzt; sonst null.
// completed = sauber beendet · aborted = abgebrochen (User-Stop/Cancel) · failed = Fehler.
export type JobResult = 'completed' | 'aborted' | 'failed';

export interface FilamentWeight {
  filamentIndex: number; // 0-basierter globaler AMS-Index: T0=0, T1=1, T4=AMS2-Slot0
  grams: number;
  color?: string;        // Slicer-Filamentfarbe (#RRGGBB) aus slice_info.config — für Mehrfarb-Slot-Zuordnung per Farbe
  /** 0-based position of the filament in the slicer's list (Bambu slice_info ids start at 1). */
  slicerOrder?: number;
  /** Filament type the slicer used, e.g. "PLA" (Bambu slice_info `type`). */
  filamentType?: string;
}

/** Raw job ids the printer reports (Bambu task_id / subtask_id / job_id), for matching
 *  the job against the Bambu Cloud task history. */
export interface JobIds {
  taskId?: string;
  subtaskId?: string;
  jobId?: string;
}

/** Result of reading a finished job's print file again (after the job ended). */
export type JobFileResult =
  | { kind: 'ok'; weights: FilamentWeight[] }
  | { kind: 'internal' }   // file in the printer's internal storage, never readable
  | { kind: 'missing' }    // not on the SD card
  | { kind: 'error'; message: string };

export interface PrinterSnapshot {
  status: PrinterStatus;
  jobResult?: JobResult | null; // gesetzt am Terminal-Übergang eines Drucks; sonst null/undefined
  printFile?: string;
  sourceJobId?: string | null;  // eindeutige Druck-/Job-ID (für Backend-Dedup gegen Re-Emission)
  progressPct?: number;
  tempHotend?: number;
  tempBed?: number;
  etaSec?: number;
  amsSlots?: AmsSlot[];
  activeMqttSlot?: number;
  amsHumidity?: AmsHumidityUnit[];
  amsUnits?: AmsUnitInfo[];
  filamentMapping?: number[];     // Bambu print.mapping: Slicer-Filament-id (1-basiert) → physischer Tray-Code; 65535 = ungenutzt/extern
  parsedFilamentWeights?: FilamentWeight[] | null;
  printPreview?: { printFile: string; png: Buffer } | null; // slicer plate thumbnail of the running job
  jobState?: JobState;          // finer job state (preparing / finished / failed …)
  hms?: HmsAlert[];             // active printer health messages
  printError?: string | null;   // "MMMM_EEEE" of the current/last job
  cloudWeightG?: number | null;
  /** Last known state after a (re)connect, not yet confirmed by a full report. Job
   *  start/end must not be derived from a stale snapshot. */
  stale?: boolean;
  /** Identity of the current/last job (changes with every new print). Adapters that
   *  cannot tell leave it unset; the bridge then falls back to the print file. */
  jobKey?: string | null;
  layerNum?: number;            // current layer (Bambu layer_num)
  totalLayers?: number;         // layers of the job (Bambu total_layer_num)
  /** Job start reported by the printer, epoch seconds (Bambu gcode_start_time). */
  jobStartedAtS?: number;
  /** Slicer-predicted print time of the job in minutes (from the print file). */
  estimatedDurationMin?: number | null;
  /** The bridge sent a stop for the current job (a following FAILED is a cancel). */
  stopRequested?: boolean;
  /** Raw job ids of the current/last job (Bambu). */
  jobIds?: JobIds;
  /** Printed plate of the current/last job (Bambu gcode_file plate_<n>). */
  plateIndex?: number | null;
  /** The job's file sits in the printer's internal storage (not readable over FTPS). */
  fileInternal?: boolean;
  powerW?: number | null;       // aktuelle Wirkleistung vom Smart-Plug (Shelly), falls konfiguriert
  energyWhUsed?: number | null; // gemessener Energieverbrauch des Drucks in Wh (Zähler Ende − Start)
}

export type PrinterCommand =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export interface Adapter {
  getSnapshot(): Promise<PrinterSnapshot>;
  /** LAN camera metadata only; credentials remain in the local printer config. */
  getCameraRtspUrl?(): string | null;
  sendCommand?(cmd: PrinterCommand): Promise<void>;
  /** Cheap fingerprint of the AMS contents (spools, RFID, material, colour). When it
   *  changes, the bridge pushes immediately instead of waiting for the poll interval,
   *  so a newly inserted spool shows up in Flownt within seconds. */
  amsSignature?(): string;
  /** Reads a job's print file again after the job ended (weights only, no preview); used
   *  when the fetch during the print failed. Adapters without print files omit it. */
  refetchJobWeights?(printFile: string, plateIndex: number | null): Promise<JobFileResult>;
  /** Ressourcen freigeben (MQTT-Client, Timer) — MUSS bei Config-Änderung/Löschen
   *  aufgerufen werden, sonst laufen alte Verbindungen als Geister weiter. */
  dispose?(): void;
}
