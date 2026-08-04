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

/** Kanonische Event-Typen, die die Bridge an Flownt sendet. */
export type EventType = 'heartbeat' | 'status_update' | 'job_complete' | 'job_failed';

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

/** Ein AMS-Slot im Live-Zustand (Element von `ams_state` / `printers.live_ams_state`). */
export interface AmsSlot {
  ams_unit: number;    // 0–3 (für daisy-chained AMS)
  slot: number;        // 0–3
  material: string;    // "PLA", "PETG", …
  color: string;       // "#FF6600" (normalisiert von Bambu "0xFFAA00")
  remain: number;      // 0–100 %
  tray_weight: number; // Gesamtgewicht der Spule in g (für optionale Gramm-Schätzung)
}

/** Luftfeuchte je AMS-Einheit (Element von `ams_humidity` / `printers.live_ams_humidity`). */
export interface AmsHumidityUnit {
  ams_unit: number; // 0–3
  humidity: number; // 1–5 (Bambu-Skala: 1=trocken, 5=sehr feucht)
  temp: number;     // °C
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
  bridge_version?: string;  // gemeldete Bridge-Version (für Update-/Abhängigkeits-Hinweise in Flownt)
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
