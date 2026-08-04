// AmsSlot, AmsHumidityUnit und PrinterStatus leben jetzt im geteilten Contract
// (contract.ts, generiert aus supabase/functions/_shared/contract.ts im Haupt-Repo).
// Re-Export, damit bestehende Importe aus adapters/types.js weiter funktionieren.
export type { AmsSlot, AmsHumidityUnit, PrinterStatus } from '../contract.js';
import type { AmsSlot, AmsHumidityUnit, PrinterStatus } from '../contract.js';

// Normalisierter Job-Ausgang (Stufe C). Vom Adapter beim Terminal-Zustand gesetzt; sonst null.
// completed = sauber beendet · aborted = abgebrochen (User-Stop/Cancel) · failed = Fehler.
export type JobResult = 'completed' | 'aborted' | 'failed';

export interface FilamentWeight {
  filamentIndex: number; // 0-basierter globaler AMS-Index: T0=0, T1=1, T4=AMS2-Slot0
  grams: number;
  color?: string;        // Slicer-Filamentfarbe (#RRGGBB) aus slice_info.config — für Mehrfarb-Slot-Zuordnung per Farbe
}

export interface PrinterSnapshot {
  status: PrinterStatus;
  jobResult?: JobResult | null; // gesetzt am Terminal-Übergang eines Drucks; sonst null/undefined
  printFile?: string;
  progressPct?: number;
  tempHotend?: number;
  tempBed?: number;
  etaSec?: number;
  amsSlots?: AmsSlot[];
  activeMqttSlot?: number;
  amsHumidity?: AmsHumidityUnit[];
  filamentMapping?: number[];     // Bambu print.mapping: Slicer-Filament-id (1-basiert) → physischer Tray-Code; 65535 = ungenutzt/extern
  parsedFilamentWeights?: FilamentWeight[] | null;
  cloudWeightG?: number | null;
  powerW?: number | null;       // aktuelle Wirkleistung vom Smart-Plug (Shelly), falls konfiguriert
  energyWhUsed?: number | null; // gemessener Energieverbrauch des Drucks in Wh (Zähler Ende − Start)
}

export type PrinterCommand =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export interface Adapter {
  getSnapshot(): Promise<PrinterSnapshot>;
  sendCommand?(cmd: PrinterCommand): Promise<void>;
}
