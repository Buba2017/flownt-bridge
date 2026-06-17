# Flownt Bridge — Event-/Daten-Vertrag (Architektur)

Interne Referenz für den **normalisierten Drucker-Datenvertrag**. Ziel: jeder Plattform-Adapter
(Bambu, Klipper/Moonraker, perspektivisch PrusaLink/OctoPrint) bildet auf **dieselbe** kanonische
Form ab, damit Flownt darüber eine herstellerunabhängige MES-Datenschicht legen kann.

## Architekturmodell: Snapshot-Polling, zentrale Event-Ableitung

Adapter **emittieren keine Events**, sie liefern **Zustands-Snapshots**:

- `Adapter` (`src/adapters/types.ts`): `getSnapshot(): Promise<PrinterSnapshot>` (+ optional `sendCommand`).
- `runBridge()` (`src/bridge.ts`) pollt den Snapshot, **erkennt Übergänge** und sendet typisierte
  Events an die Flownt Edge Function `bridge-ingest`. Vorteil: die Event-Ableitung ist **zentral**
  und damit über alle Adapter konsistent.

## Single Source of Truth

- **Zustand:** `PrinterSnapshot` (`src/adapters/types.ts`) — Status, Temps, Fortschritt, AMS, `jobResult`,
  `parsedFilamentWeights`, Energie/Leistung. Beide Adapter implementieren das.
- **Wire-/Event-Vertrag:** `src/contract.ts` — `EventType`, `IngestBody`, `SlotRef`, `MaterialLine`.
  `bridge.ts` baut ausschließlich diese Typen (kein `Record<string,unknown>` mehr).

## Kanonische Events (`EventType`)

`heartbeat` · `status_update` · `job_complete` · `job_failed`

Job-Ende = Übergang **(printing|paused) → (idle|error)**. Der Ausgang kommt aus dem vom Adapter
normalisierten `PrinterSnapshot.jobResult` (`completed|aborted|failed`; Fallback: `error→failed`,
`idle→completed`):
- `completed` → `job_complete` (Materialabzug).
- `aborted|failed` → `job_failed` (**kein** Materialabzug; Dauer + gemessene Energie werden geloggt,
  Backend legt einen `aborted`-Drucklog an).

`job_started`/`state_changed`/`spool_assigned` sind **bewusst nicht** als eigene Events ausgeführt —
sie stecken in `status_update` + `printer_status`; das Spulen-Matching passiert backend-seitig.

## Material & Slot-Identität (`MaterialLine` / `SlotRef`)

- **Gewichtsquelle vereinheitlicht:** beide Adapter parsen die Druckdatei mit demselben
  `parseFileBuffer` (3MF slice_info / Slic3r_PE / GCode); `measureSource` (`slicer_file|bambu_cloud`)
  führt die Quelle als Metadatum mit.
- **Vendor-abstrahierte Slot-Referenz:** `SlotRef { source: 'ams'|'slicer_order'|'nfc', value }`.
  Bambu-AMS-Pfade setzen `source:'ams'` (value = globaler AMS-Index unit*4+slot); Moonraker
  `source:'slicer_order'` (value = Slicer-Reihenfolge). NFC ist künftig nur ein weiterer `source`.
- `filamentIndex` bleibt als **Kompat-Feld** erhalten — `bridge-ingest` löst heute darüber
  `(unit,slot)` auf (`unit=⌊idx/4⌋`, `slot=idx%4`) → `printer_ams_slots` → Lagerort → Spule → Abzug.

## Adapter-Spezifika

| Aspekt | Bambu (`bambu.ts`) | Moonraker (`moonraker.ts`) |
|---|---|---|
| Transport | MQTT 8883 + FTPS 990 | HTTP (`/printer/objects/query`, `/server/files/gcodes`) |
| Status | `gcode_state` → `mapState` | `print_stats.state` → `mapState` |
| `jobResult` | `FINISH→completed`, `FAILED→failed` (Stop meldet FAILED) | `complete→completed`, `cancelled→aborted`, `error→failed` |
| Slot-Identität | AMS (ams_mapping/aktiver Slot/Farbe) → `source:'ams'` | Slicer-Reihenfolge → `source:'slicer_order'`; Lagerort via „Material-Slots" in der App |
| Befehle | Pause/Resume/Stop | — |

## Stand (Audit, 2026-06-16) — „verankert & konform" für Vertrag + Moonraker-Datenpfad

Umgesetzt in 3 Stufen: **A** Vertrag typisiert · **B** `SlotRef`/`MaterialLine` (vendor-abstrahiert) ·
**C1** Job-Ausgang normalisiert + `job_failed` (kein Fehlabzug, behebt Moonraker-Abbruch=Erfolg) ·
**C2** Material-Slot-Zuordnung für Moonraker (App-UI, `printer_ams_slots`).

**Bewusst offen (nicht-blockierend):**
- Backend wertet `slotRef.source` noch nicht aktiv aus (NFC-Zukunft); heute `value == filamentIndex`.
- Moonraker-Komfort vs. Bambu: Live-Slot-Status (Feuchte/Farben), Steuerbefehle, `eta`, **>4 Tools** (große MMU; aktuell auf 4 Material-Slots gedeckelt = `filamentIndex 0–3`).

## Versionierung & Versions-Awareness

**Single Source der Bridge-Version:** `src/version.ts` (`BRIDGE_VERSION`). Bei jedem Release zusammen
mit `package.json` `"version"` anheben — und in der App `RECOMMENDED_BRIDGE_VERSION` in
`src/lib/version.ts`.

**Wie die Version sichtbar wird (erledigt, live ab v0.4.1):**
- *Auf der Bridge selbst:* Footer „Flownt Bridge vX.Y.Z" auf jeder Web-UI-Seite + `GET /api/version`
  (liefert `{version}`) + Startup-Log `[flownt-bridge] vX.Y.Z startet…`.
- *Meldung an Flownt:* nur **Monitoring**-Instanzen senden `bridge_version` im Ingest-Body (Heartbeat/Push,
  ab v0.4.0). `bridge-ingest` schreibt es nach `printer_bridge_configs.bridge_version`. Reine
  Etikettendruck-Instanzen melden nichts (haben keine Drucker → kein Push).
- *In der App:* Drucker-Modal („Bridge-Verbindung" → „Bridge-Version: vX") + amber „Update"-Badge auf der
  Druckerkarte, wenn gemeldete Version < `RECOMMENDED_BRIDGE_VERSION` (`bridgeUpdateAvailable()`).

**Feature-Gating nach Mindestversion — bewusst NICHT gebaut (Idee für später, kein offener Task):**
Würde bedeuten: eine Flownt-Funktion, die zwingend eine neuere Bridge braucht, erkennt eine zu alte Bridge
und schickt gezielt zum Update statt still zu scheitern. Heute **kein Bedarf** — die einzigen
Bridge-Aktionen (Etikettendruck `/dymo/print`, Remote-Befehle `/printer/command`) laufen auf 0.3.0+ und
fangen Ausfälle bereits ab (Etikettendruck fällt auf den Browser-Druckdialog zurück). Wird erst zusammen
mit dem ersten Feature gebaut, das eine echte Mindestversion erfordert.
**Technische Grenze, die das Design dann bestimmt:** lokales, proaktives Prüfen geht nur über `/api/version`
— das existiert erst **ab 0.4.1**. Mindestversionen **≥ 0.4.1** sind damit lokal sauber prüfbar, ältere
nicht (eine 0.4.0-Bridge ohne `/api/version` würde fälschlich als „zu alt" gelten). Für Monitoring-Features
ist die Version dagegen sauber aus der DB bekannt (ab 0.4.0).
