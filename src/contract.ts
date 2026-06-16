// ── Bridge → Flownt: Event-/Ingest-Vertrag (Single Source of Truth) ──────────────
//
// Stufe A (rein additiv): Dieses Modul verankert die HEUTE bereits gesendete Form als
// typisierten Vertrag — es ersetzt das frühere `Record<string, unknown>` in bridge.ts,
// ohne Felder, Werte oder Verhalten zu ändern. Beide Adapter (Bambu, Moonraker) liefern
// `PrinterSnapshot` (adapters/types.ts); die kanonische Event-Ableitung passiert zentral
// in bridge.ts und wird über diesen Vertrag an `bridge-ingest` (Backend) gesendet.
//
// Spätere Stufen: B abstrahiert die Slot-/Spulen-Identität (AMS heute → NFC später) als
// eigenes `MaterialLine`-Modell; C bringt Moonraker auf Parität (job_failed, Slot-Ref).
import type { AmsSlot, AmsHumidityUnit, PrinterStatus } from './adapters/types.js';

/** Kanonische Event-Typen, die die Bridge an Flownt sendet. */
export type EventType = 'heartbeat' | 'status_update' | 'job_complete' | 'job_failed';

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
  color?: string;
  slotRef: SlotRef;                               // abstrahierte Slot-/Lagerplatz-Identität
  measureSource: 'slicer_file' | 'bambu_cloud';   // Quelle der Gewichtsmessung
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
  // Status (status_update + job_complete)
  printer_status?: PrinterStatus;
  print_file?: string;
  progress_pct?: number;
  temp_hotend?: number;
  temp_bed?: number;
  eta_s?: number;
  duration_min?: number;
  live_power_w?: number;
  ams_state?: AmsSlot[];
  ams_active_slot?: number;
  ams_humidity?: AmsHumidityUnit[];
  // Nur job_complete: verbrauchtes Material + optionale Mess-/Energie-Quellen
  filament_weights?: MaterialLine[];
  cloud_weight_g?: number;
  energy_wh?: number;
}
