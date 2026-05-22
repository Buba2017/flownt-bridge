export interface AmsSlot {
  ams_unit: number;    // 0–3 (für daisy-chained AMS)
  slot: number;        // 0–3
  material: string;    // "PLA", "PETG", …
  color: string;       // "#FF6600" (normalisiert von Bambu "0xFFAA00")
  remain: number;      // 0–100 %
  tray_weight: number; // Gesamtgewicht der Spule in g (für optionale Gramm-Schätzung)
}

export interface AmsHumidityUnit {
  ams_unit: number; // 0–3
  humidity: number; // 1–5 (Bambu-Skala: 1=trocken, 5=sehr feucht)
  temp: number;     // °C
}

export interface PrinterSnapshot {
  status: 'idle' | 'printing' | 'error' | 'offline';
  printFile?: string;
  progressPct?: number;
  tempHotend?: number;
  tempBed?: number;
  etaSec?: number;
  amsSlots?: AmsSlot[];         // AMS-Zustand aus MQTT
  activeMqttSlot?: number;      // tray_now: globaler Index über alle AMS-Einheiten
  amsHumidity?: AmsHumidityUnit[]; // Feuchtigkeit + Temperatur pro AMS-Unit
}

export interface Adapter {
  getSnapshot(): Promise<PrinterSnapshot>;
}
