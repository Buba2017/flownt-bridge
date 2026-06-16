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
import type { AmsSlot, AmsHumidityUnit, FilamentWeight, PrinterStatus } from './adapters/types.js';

/** Kanonische Event-Typen, die die Bridge an Flownt sendet. */
export type EventType = 'heartbeat' | 'status_update' | 'job_complete';

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
  filament_weights?: FilamentWeight[];
  cloud_weight_g?: number;
  energy_wh?: number;
}
