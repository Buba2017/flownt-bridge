import fetch from 'node-fetch';
import { PrinterConfig, FLOWNT_EDGE_URL } from './config.js';
import type { PrinterBridgeState } from './server.js';
import { Adapter, PrinterSnapshot, AmsSlot } from './adapters/types.js';
import { EventType, IngestBody, SlotRef } from './contract.js';
import { BambuCloudClient } from './bambu-cloud.js';
import { ShellyClient } from './smartplug/shelly.js';
import { addEvent } from './events.js';

async function push(
  cfg: PrinterConfig,
  snapshot: PrinterSnapshot,
  eventType: EventType = 'status_update',
  durationMin?: number,
  slotSource: SlotRef['source'] = 'slicer_order',
): Promise<string | undefined> {
  const body: IngestBody = {
    auth_token: cfg.flowntAuthToken,
    event_type: eventType,
    printer_status: snapshot.status,
    print_file: snapshot.printFile,
    progress_pct: snapshot.progressPct,
    temp_hotend: snapshot.tempHotend,
    temp_bed: snapshot.tempBed,
    eta_s: snapshot.etaSec,
  };
  if (durationMin != null) body.duration_min = durationMin;
  if (snapshot.powerW != null) body.live_power_w = snapshot.powerW;
  if (snapshot.amsSlots?.length) body.ams_state = snapshot.amsSlots;
  if (snapshot.activeMqttSlot != null) body.ams_active_slot = snapshot.activeMqttSlot;
  if (snapshot.amsHumidity?.length) body.ams_humidity = snapshot.amsHumidity;
  if (eventType === 'job_complete') {
    if (snapshot.parsedFilamentWeights?.length) {
      // Stufe B: pro Materialzeile die quell-abstrahierte Slot-Referenz mitführen.
      // `filamentIndex` bleibt unverändert als Kompat-Feld (Backend liest weiterhin dieses Feld).
      body.filament_weights = snapshot.parsedFilamentWeights.map(fw => ({
        filamentIndex: fw.filamentIndex,
        grams: fw.grams,
        color: fw.color,
        slotRef: { source: slotSource, value: fw.filamentIndex },
        measureSource: 'slicer_file' as const,
      }));
    }
    if (snapshot.cloudWeightG != null) body.cloud_weight_g = snapshot.cloudWeightG;
    if (snapshot.energyWhUsed != null) body.energy_wh = snapshot.energyWhUsed;
  }

  const res = await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bridge-ingest ${res.status}: ${text}`);
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return typeof data.print_log_id === 'string' ? data.print_log_id : undefined;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

export async function runBridge(
  adapter: Adapter,
  cfg: PrinterConfig,
  state: PrinterBridgeState,
  isCancelled: () => boolean,
): Promise<void> {
  console.log(`[${cfg.name}] Verbindung wird aufgebaut…`);

  const bambuCloud = (cfg.bambuCloudEmail && cfg.bambuCloudPassword)
    ? new BambuCloudClient(cfg.bambuCloudEmail, cfg.bambuCloudPassword)
    : null;

  const smartPlug = (cfg.smartPlugType === 'shelly' && cfg.smartPlugUrl)
    ? new ShellyClient(cfg.smartPlugUrl)
    : null;
  if (smartPlug) addEvent(cfg.id, 'info', `Smart-Plug aktiv: ${cfg.smartPlugUrl}`);

  // Initial heartbeat to verify token
  try {
    const heartbeat: IngestBody = { auth_token: cfg.flowntAuthToken, event_type: 'heartbeat' };
    await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeat),
    });
    console.log(`[${cfg.name}] Auth OK ✓`);
    state.error = null;
    addEvent(cfg.id, 'success', 'Verbindung zu Flownt hergestellt ✓');
  } catch (e) {
    console.error(`[${cfg.name}] Heartbeat fehlgeschlagen:`, e);
    state.error = 'Keine Verbindung zu Flownt. Bitte Token und Server-URL prüfen.';
    addEvent(cfg.id, 'warn', 'Heartbeat fehlgeschlagen — Token oder Verbindung prüfen');
  }

  let consecutiveErrors = 0;
  let prevStatus: PrinterSnapshot['status'] | null = null;
  let printStartedAt: number | null = null;
  let lastActiveSlot: number | null = null;   // physischer AMS-Slot (tray_now), global: unit*4+slot
  let lastAmsSlots: AmsSlot[] = [];           // letzter AMS-Status (Farbe je physischem Slot) — Fallback-Zuordnung per Farbe
  let lastFilamentMapping: number[] = [];     // Bambu print.mapping (Slicer-Filament-id → physischer Tray-Code) — primäre, deterministische Zuordnung
  let lastEnergyWh: number | null = null;     // letzter Energiezähler-Stand vom Smart-Plug (Wh)
  let energyStartWh: number | null = null;    // Zählerstand bei Druckstart (für Verbrauchs-Differenz)

  while (!isCancelled()) {
    try {
      let snapshot = await adapter.getSnapshot();

      // Smart-Plug (Shelly): Momentanleistung lesen und in den Snapshot mergen.
      // Fehlertolerant — ein nicht erreichbarer Plug darf den Druckerstatus nicht stören.
      if (smartPlug) {
        const reading = await smartPlug.read();
        if (reading) {
          snapshot = { ...snapshot, powerW: Math.round(reading.powerW) };
          lastEnergyWh = reading.energyWh;
        }
      }

      state.snapshot = snapshot;

      // Job-Ende erkennen: aktiv (printing/paused) → terminal (idle ODER error).
      // Ausgang aus dem normalisierten jobResult des Adapters; Fallback aus dem Status.
      let eventType: EventType = 'status_update';
      let durationMin: number | undefined;
      const wasActive = prevStatus === 'printing' || prevStatus === 'paused';
      const isTerminal = wasActive && (snapshot.status === 'idle' || snapshot.status === 'error');
      if (isTerminal) {
        const outcome = snapshot.jobResult ?? (snapshot.status === 'error' ? 'failed' : 'completed');
        eventType = outcome === 'completed' ? 'job_complete' : 'job_failed';
        if (printStartedAt != null) {
          durationMin = Math.round((Date.now() - printStartedAt) / 60_000);
        }
        printStartedAt = null;
        // Gemessener Stromverbrauch = Energiezähler(Ende) − Energiezähler(Start) — auch bei Abbruch sinnvoll
        if (smartPlug && energyStartWh != null && lastEnergyWh != null) {
          const usedWh = lastEnergyWh - energyStartWh;
          if (usedWh >= 0 && usedWh < 100_000) { // Guard gegen Zählerreset / Ausreißer
            snapshot = { ...snapshot, energyWhUsed: usedWh };
            addEvent(cfg.id, 'info', `Stromverbrauch: ${(usedWh / 1000).toFixed(3)} kWh`);
          }
        }
        energyStartWh = null;
        if (eventType === 'job_failed') {
          addEvent(cfg.id, 'warn', `Druck ${outcome === 'aborted' ? 'abgebrochen' : 'fehlgeschlagen'} — kein Materialabzug`);
          console.log(`[${cfg.name}] Job ${outcome} → Abbruch-Log (${durationMin ?? '?'} min, kein Abzug)`);
        } else {
          console.log(`[${cfg.name}] Job abgeschlossen → Drucklog-Eintrag (${durationMin ?? '?'} min)`);
        }
      }
      // Only (re-)start timer when transitioning into printing from a non-print state
      if (snapshot.status === 'printing' && prevStatus !== 'printing' && prevStatus !== 'paused') {
        printStartedAt = Date.now();
        energyStartWh = lastEnergyWh; // Energiezähler-Stand bei Druckstart merken
        addEvent(cfg.id, 'info', `Druck gestartet: ${snapshot.printFile ?? '–'}`);
      }

      prevStatus = snapshot.status;

      // Aktiven physischen AMS-Slot während des Drucks merken (0–15; ≥254 = externe Spule, ignorieren)
      if (snapshot.status === 'printing'
          && typeof snapshot.activeMqttSlot === 'number'
          && snapshot.activeMqttSlot >= 0 && snapshot.activeMqttSlot < 16) {
        lastActiveSlot = snapshot.activeMqttSlot;
      }
      // AMS-Status + ams_mapping während des Drucks merken (kommen nicht in jeder MQTT-Nachricht).
      if (snapshot.status === 'printing' && snapshot.amsSlots?.length) {
        lastAmsSlots = snapshot.amsSlots;
      }
      if (snapshot.status === 'printing' && snapshot.filamentMapping?.length) {
        lastFilamentMapping = snapshot.filamentMapping;
      }

      // Filament-Zuordnung: der filamentIndex aus dem Parser ist die SLICER-Filament-id (slice_info),
      // NICHT der physische AMS-Slot. Reihenfolge der Strategien:
      //  1. PRIMÄR & deterministisch: Bambu print.mapping (mapping[id-1] → Tray-Code; Code: unit=code>>8, slot=code&0xFF → global unit*4+slot)
      //  2. Fallback Einfarb: aktiver physischer Slot (tray_now)
      //  3. Fallback Mehrfarb: Zuordnung per Farbe gegen den AMS-Live-Status
      // Quelle der Slot-Identität für diese Buchung (Stufe B): default Slicer-Reihenfolge,
      // wird in den Bambu-AMS-Pfaden auf 'ams' angehoben. Künftig 'nfc'.
      let slotSource: SlotRef['source'] = 'slicer_order';
      let mappedByAmsMapping = false;
      if (eventType === 'job_complete' && snapshot.parsedFilamentWeights?.length && lastFilamentMapping.length) {
        let cnt = 0;
        const remapped = snapshot.parsedFilamentWeights.map(fw => {
          const code = lastFilamentMapping[fw.filamentIndex - 1];
          if (code == null) return fw;
          if (code >= 65535) return { ...fw, filamentIndex: 254 }; // ungenutzt/externe Spule → kein AMS-Slot-Link
          const amsUnit = (code >> 8) & 0xFF;
          const slot = code & 0xFF;
          if (amsUnit > 3 || slot > 3) return fw; // unerwartete Kodierung → roh lassen
          const gi = amsUnit * 4 + slot;
          if (gi !== fw.filamentIndex) cnt++;
          return { ...fw, filamentIndex: gi };
        });
        snapshot = { ...snapshot, parsedFilamentWeights: remapped };
        mappedByAmsMapping = true;
        slotSource = 'ams';
        addEvent(cfg.id, 'info', `Filament-Zuordnung via Bambu ams_mapping (${remapped.length} Filament(e), ${cnt} korrigiert)`);
      }

      // Fallback Einfarb (nur ohne ams_mapping): Verbrauch dem aktiven physischen AMS-Slot zuordnen.
      if (!mappedByAmsMapping && eventType === 'job_complete' && snapshot.parsedFilamentWeights?.length === 1) {
        const fw = snapshot.parsedFilamentWeights[0];
        if (lastActiveSlot != null) {
          const slotLabel = `${String.fromCharCode(65 + Math.floor(lastActiveSlot / 4))}${(lastActiveSlot % 4) + 1}`;
          if (fw.filamentIndex !== lastActiveSlot) {
            snapshot = { ...snapshot, parsedFilamentWeights: [{ ...fw, filamentIndex: lastActiveSlot }] };
          }
          slotSource = 'ams';
          addEvent(cfg.id, 'info', `Filamentverbrauch → AMS-Slot ${slotLabel} (${fw.grams} g)`);
        } else {
          addEvent(cfg.id, 'warn', 'Aktiver AMS-Slot unbekannt — Filament evtl. nicht verknüpft');
        }
      }

      // Fallback Mehrfarb (nur ohne ams_mapping): Zuordnung per Farbe gegen den AMS-Live-Status.
      if (!mappedByAmsMapping && eventType === 'job_complete' && (snapshot.parsedFilamentWeights?.length ?? 0) > 1) {
        const slots = snapshot.amsSlots?.length ? snapshot.amsSlots : lastAmsSlots;
        if (slots.length) {
          const normHex = (c?: string) => c ? '#' + c.replace(/^#/, '').replace(/^0x/i, '').slice(0, 6).toUpperCase() : '';
          let remappedCount = 0;
          const remapped = snapshot.parsedFilamentWeights!.map(fw => {
            if (!fw.color) return fw;
            const want = normHex(fw.color);
            const matches = slots.filter(s => normHex(s.color) === want);
            if (matches.length === 1) {
              const gi = matches[0].ams_unit * 4 + matches[0].slot;
              if (gi !== fw.filamentIndex) { remappedCount++; return { ...fw, filamentIndex: gi }; }
            }
            return fw;
          });
          if (remappedCount > 0) {
            snapshot = { ...snapshot, parsedFilamentWeights: remapped };
            slotSource = 'ams';
            addEvent(cfg.id, 'info', `Mehrfarb-Druck: ${remappedCount} Filament(e) per Farbe dem AMS-Slot zugeordnet (Fallback)`);
          }
        } else {
          addEvent(cfg.id, 'warn', 'Mehrfarb-Druck: kein ams_mapping/AMS-Status — Filamente evtl. nach Slicer-Reihenfolge zugeordnet');
        }
      }

      // Cloud-Gewicht via Bambu API NUR holen, wenn FTPS nichts geliefert hat.
      // Bambus Login verschickt sonst bei jedem Druckende einen Verification-Code per Mail.
      const ftpsGotWeights = (snapshot.parsedFilamentWeights?.length ?? 0) > 0;
      if (eventType === 'job_complete' && bambuCloud && cfg.adapterSerial && !ftpsGotWeights) {
        const cloudWeight = await bambuCloud.getLatestTaskWeightWithRetry(cfg.adapterSerial);
        if (cloudWeight != null) snapshot = { ...snapshot, cloudWeightG: cloudWeight };
      }

      // Backend only accepts: idle, printing, maintenance, offline, error
      // Map "paused" → "printing" (job is still active)
      const pushSnapshot: PrinterSnapshot = snapshot.status === 'paused'
        ? { ...snapshot, status: 'printing' }
        : snapshot;

      const printLogId = await push(cfg, pushSnapshot, eventType, durationMin, slotSource);
      state.lastPushAt = new Date();
      state.error = null;
      consecutiveErrors = 0;
      if (eventType === 'job_complete') {
        const idHint = printLogId ? ` (${printLogId.slice(0, 8)}…)` : '';
        addEvent(cfg.id, 'success', `Drucklog erstellt${idHint}: ${snapshot.printFile ?? '–'}`);
      }

      const progress = snapshot.progressPct != null ? ` ${snapshot.progressPct}%` : '';
      const file = snapshot.printFile ? ` "${snapshot.printFile}"` : '';
      console.log(`[${cfg.name}] ${new Date().toISOString()} → ${snapshot.status.toUpperCase()}${file}${progress}`);
    } catch (err) {
      consecutiveErrors++;
      const backoff = Math.min(consecutiveErrors * 5_000, 60_000);
      state.error = `Verbindungsfehler (${consecutiveErrors}×). Nächster Versuch in ${backoff / 1000}s.`;
      console.error(`[${cfg.name}] Fehler (${consecutiveErrors}×):`, err);
      if (consecutiveErrors === 1) addEvent(cfg.id, 'warn', `Verbindungsfehler: ${String(err).slice(0, 80)}`);
      await sleep(backoff);
      continue;
    }

    await sleep(cfg.pollingIntervalMs);
  }
}
