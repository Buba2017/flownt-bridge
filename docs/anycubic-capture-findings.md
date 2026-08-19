# Anycubic-Captures — Auswertung (2026-08-18)

Drei Tester-Captures (`~/Desktop/Anycubic Integration/`), ausgewertet mit
`scripts/anycubic-capture-summary.mjs` (Zusammenfassung + `--dump`-Modus für Einzel-Payloads).

| Capture | Gerät | typeId | FW | Dauer | Inhalt |
|---|---|---|---|---|---|
| `…1786391031912` (4.6 MB, 8212 Msgs) | Kobra S1 | 20025 | 2.7.2.7 | 102 min | **2 echte Drucke**: 1× Nutzer-Abbruch, 1× 3MF-Druck komplett bis `finished` |
| `…1786535180115` (151 KB, 196 Msgs) | Kobra X | 20030 | 1.2.0.6 | 3 min | Idle, aber ACE-Box-Struktur komplett |
| `…1786621841553` (4.2 MB, 5499 Msgs) | Kobra X | 20030 | 1.2.0.6 | 89 min | **Kompletter Druck** (Shark-Testmodell) von Start bis `finished` |

## Validiert ✅

- **Druck-Telemetrie** (`print/report`, redundant in `info/report` → `data.project`):
  `progress` 0–100, `curr_layer`/`total_layers`, `print_time`/`remain_time` (**Minuten**),
  `supplies_usage` (zählt während des Drucks hoch), `filename`, Temps in `print/update.settings`.
- **Druckende**: `type:"print", action:"start", state:"finished"` (Envelope!) mit `progress:100`,
  finalem `supplies_usage` (Shark: 6530). Danach `info/report` → `last_project.state:"finished"`.
- **Abbruch**: `action:"stop"`, Envelope-State `"stopping"` → `"stoped"` (sic, ein p!),
  `code:10601`, `msg:"用户发起"` (= vom Nutzer initiiert). `supplies_usage` bleibt im Payload.
- **Gesehene Print-States**: `checking`, `auto_leveling`, `flow_calibrating`, `preheating`,
  `printing`, `updated` (print/update), `stopping`, `stoped`, `finished`.
  Drucker-Gesamtstatus: `info.data.state` = `free` | `busy`.
- **ACE-Box (Kobra X, `multiColorBox/getInfo`)**: `model_id:40002`, 4 Slots mit
  `color` (RGB-Array), `color_group` (RGBA), `type` ("PLA" / "PLA Matte" / "PLA Silk" / "PETG"),
  `sku` (z. B. "AHPLRR-107"), `consumables_percent`, `weight` (1000 = g Spule),
  `loaded_slot` (aktiver Slot während des Drucks, z. B. 2; idle: -1), `humidity`, `drying_status`.
  → mappt sauber auf den `AmsSlot`-Contract.
- **Externe Spule (S1, `extfilbox/reportInfo`)**: `color` (RGB), `type:"PLA"`, `loaded`,
  `current_status`/`status_type`; `filament/replace`-Events beim Spulenwechsel.
- **Job-Identifikation**: USB-/Display-Druck → `taskid:"-1"` + `localtask:""`;
  Slicer-Druck → `localtask` (UUID) bzw. `task_id` (Cloud). Für Drucklog-Dedup:
  `localtask`/`taskid` + `filename` + Startzeit.
- Der S1-Envelope-Fund aus der ersten Capture (State im Envelope, kein Client-Cert) gilt
  unverändert auch für die Kobra X.

## Offen ⚠️

- **Einheit von `supplies_usage`**: Shark (46 min, PLA 0.2) = 6530, BierHelm (62 min, PLA 0.08) = 2268.
  Kandidaten: **mm** (→ 19,4 g bzw. 6,8 g) oder **mg** (→ 6,5 g bzw. 2,3 g). Die Protokoll-Doku
  behauptete „Gramm" — das ist mit 6530 widerlegt. Klärung: Tester nach Slicer-Gewichtsschätzung
  des exakten Plates fragen (oder Druck wiegen); eine Zahl genügt.
- `extfilbox` (externe Spule, S1) hat noch kein Contract-Pendant — Live-Farbe/-Material der
  externen Spule wird vorerst nicht gemeldet.
- ACE-`humidity` war in allen Captures 0 (Skala unklar) — bewusst nicht gemeldet.
- ~3700 Nachrichten je Capture auf Response-Topics ohne Nutzdaten (nur `msgid`) — im Adapter ignoriert.

## Replay-Verifikation (2026-08-19)

Der finalisierte Adapter wurde mit `scripts/anycubic-replay.mjs` gegen alle drei Captures
gespielt (Nachricht für Nachricht durch `onMessage`, Job-Ende-Erkennung wie `bridge.ts`):

- **S1**: Abbruch → `job_failed (aborted)`, JobId `690746197`, kein Materialabzug ✓;
  zweiter Druck → `job_complete`, 68 min, 6,71 g (bei Einheit mm) ✓ — der S1-Druck ist
  entgegen erster Sichtung **komplett** in der Capture (inkl. `finished`).
- **Kobra X**: Shark → `job_complete`, 55 min, 19,32 g (mm), JobId = `localtask`-UUID ✓;
  ACE-Slots mit Material/Farbe/Rest-% korrekt gemappt ✓.
- Idle-Capture: keine Fehl-Events ✓.

## Nächste Schritte

1. `supplies_usage`-Einheit bestätigen (Tester-Rückfrage läuft) → ggf. `SUPPLIES_UNIT`
   in `src/adapters/anycubic.ts` auf `'mg'` stellen (eine Zeile).
2. Verdrahten in die Bridge (`index.ts`-Adapter-Registry) + Frontend-Adapter-Option
   „Anycubic (LAN)" → dann Tester-Lauf mit echter Bridge.
3. Später: `extfilbox` → Externe Spule (Contract-Erweiterung), ACE-Feuchte-Skala klären.
