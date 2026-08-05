# Anycubic Kobra LAN-Protokoll — Dossier (Spike)

Konsolidiert aus zwei unabhängigen Home-Assistant-Integrationen, die dasselbe Protokoll
belegen (starke Bestätigung — beide unabhängig reverse-engineert):

- `grunna/ha-anycubic-kobra-x-lan` (roher MQTT-Nachbau, Python)
- `stribor/anycubic_kobrax` (paho-mqtt, plus Capture-Skript `scripts/capture_mqtt.py`)

Getestet bestätigt auf **Kobra X** und **Kobra S1**. Protokoll ist modellagnostisch —
`type_id`/`device_id` kommen dynamisch aus der Discovery, keine modellspezifischen Zweige.
`type_id` Default `20030`. Kobra-2-Serie: unklar, hat evtl. keinen LAN-Modus.

> **Status: unvalidiert.** Alles hier stammt aus fremdem RE-Code, nicht aus Anycubic-Doku.
> Vor Adapter-Bau gegen echte Hardware mit `scripts/anycubic-probe.mjs` verifizieren.

---

## 1. Credential-Discovery (HTTP, Port 18910)

Die MQTT-Zugangsdaten sind **nicht** konstant und **nicht** aus der Seriennummer ableitbar —
sie werden pro Sitzung vom Drucker geholt und AES-entschlüsselt.

1. **GET** `http://<host>:18910/info`
   → liefert `token` (≥32 Zeichen), `ctrlInfoUrl`, `modelName`, `modelId`/`modeId`, `usn` u.a.
2. Signatur bilden:
   - `ts = String(Date.now())`
   - `nonce` = 6 zufällige alphanumerische Zeichen
   - `sign = md5( md5(token[:16]) + ts + nonce )`  (md5 = lowercase hex)
3. **POST** `ctrlInfoUrl?ts=<ts>&nonce=<nonce>&sign=<sign>&did=<DID>`
   - `did` = clientseitig generierte Hex-ID (`randomBytes(16).hex.toUpperCase()`), beliebig aber stabil
   - Antwort muss `code == 200` haben; Nutzlast unter `data`: `info` (base64 AES-Ciphertext), `token` (IV)
4. **AES-128-CBC entschlüsseln**, PKCS7-Padding entfernen:
   - Key = `token[16:32]` (aus Schritt 1, 16 Byte)
   - IV  = `data.token` (aus Schritt 3, 16 Byte)
   - Klartext = JSON-Bundle:

```
{ broker, deviceId, deviceType, devicecrt, devicepk, ip,
  modeId, modelId, modelName, username, password }
```

Aus dem Bundle:
- `username` / `password` → MQTT-Auth
- `deviceId` → `printer_id` (Topic-Segment)
- `modeId` (Fallback `modelId`) → `type_id` (Topic-Segment) — **`modeId` bevorzugen**, Kobra S1 Combo hatte `modelId` fehlend
- `broker` → MQTT-Host/Port (URL; Fallback Host = `ip`, Port = 9883)
- `devicecrt` / `devicepk` → optionales Client-Zertifikat (PEM). **Divergenz:** grunna nutzt es NICHT (nur unverifiziertes TLS); stribor lädt es optional in den TLS-Context. → Beim Probe erst OHNE Client-Cert versuchen.

---

## 2. MQTT-Verbindung (Port 9883, TLS)

- **Broker**: aus `broker`-URL im Bundle, sonst `<host>:9883`
- **TLS**: Broker-Zertifikat **nicht** verifizieren (`rejectUnauthorized: false`). Kein `O=AnyCubic`-Check nötig (beide Repos verifizieren gar nicht).
- **MQTT 3.1.1**, Keepalive 60 s, Clean Session
- **client_id**: frei, z.B. `flownt_anycubic_<8hex>`. Muss stabil/eindeutig sein (Kollision → gegenseitiges Trennen).
- **Auth**: `username`/`password` aus dem Bundle.

### Topics

Basis: `anycubic/anycubicCloud/v1`

- **Subscribe** (Wildcard über alle Reports):
  `anycubic/anycubicCloud/v1/printer/+/<type_id>/<device_id>/#`
- **Publish (Query)**:
  `anycubic/anycubicCloud/v1/web/printer/<type_id>/<device_id>/<query_type>`

### Query-Mechanik (Poll, kein Auto-Push)

Reports müssen aktiv angefragt werden. Pro Poll-Runde für jeden Typ publizieren:

```json
{ "type": "<query_type>", "action": "query", "timestamp": <ms>, "msgid": "<uuid>", "data": null }
```

Sonderfall `multiColorBox`: `"action": "getInfo"` statt `"query"`.

Query-Typen: `status, info, tempature, fan, light, peripherie, multiColorBox`
(Achtung: „tempature" ist die tatsächliche, falsch geschriebene Schreibweise im Protokoll.)

Poll-Intervall: 30 s (Default beider Integrationen). Antworten kommen asynchron auf den
Subscribe-Topics; `report.type` bzw. das Topic-Segment `<type>/report` ordnet sie zu.
Nutzdaten liegen unter `report.data`.

---

## 3. Relevante Report-Payloads (`report.data`)

### Status / Info
- Druckerzustand: `status.data.state` bzw. `info.data.state`
- Firmware: `info.data.version`; Modell: `info.data.model`; IP: `info.data.ip`
- Laufender Job bevorzugt unter `info.data.project` (sonst `print.data`)

### Temperaturen (Typ `tempature`)
- `curr_nozzle_temp`, `curr_hotbed_temp`, `target_nozzle_temp`, `target_hotbed_temp`

### Job / Fortschritt (`project` bzw. `print.data`)
- `filename` / `name` — Dateiname
- `progress` — Prozent (int)
- `remain_time` — **Minuten** (×60 für Sekunden)
- `print_time` — **Minuten**
- `curr_layer`, `total_layers`
- `task_id` / `taskid`
- `state` (String) oder `print_status` (int, siehe State-Map)

### Filamentverbrauch (Gramm — direkt aus dem Report!)
- Bevorzugt: `project.estimate_supplies_usage_g` (Gramm)
- Fallback: `project.supplies_usage` (Länge mm) → Gramm:
  `g = round( (π·(1.75/2)·1.75/2 · mm · 1.23) / 1000, 2 )` (1,75 mm, Faktor 1,23)
- Ggf. per-Filament: `print_filaments_weight` (bei Multi-Color — an echter Hardware prüfen)

### Multi-Color-Box / ACE (Typ `multiColorBox`, `action: getInfo`)
`data.multi_color_box` = Liste von Boxen. Pro Box: `status`, `temp`, `humidity`,
`loaded_slot`, `slots[]`. Pro Slot: `index`, `type` (Material), `consumables_percent`
(Restmenge %), `weight`, `color` = `[R,G,B]`, `sku`.

---

## 4. State-Maschine (Druck-Ausgang)

Klassifikation der `state`-Strings (lowercased), aus stribor `_record_print_event`,
bestätigt durch grunna `PRINT_STATUS_MAP`:

| Flownt-jobResult | Anycubic-Rohwerte |
|---|---|
| `completed` | `finished`, `finish`, `completed`, `done` (print_status int `2`) |
| `aborted`   | `cancelled`, `canceled`, `stopping`, `stopped`, `stoped` |
| `failed`    | `failed`, `error` (int `3`) — ODER `payload.code` vorhanden und ∉ {0, 200} |
| (kein)      | `printing`, `preheating`, `checking`, `auto_leveling`, `resuming`, `paused`, `downloading`, … |

`print_status`-Int-Map (grunna): `1=printing, 2=finished, 3=failed, 4=downloading,
5=checking, 6=preheating, 7=slicing, 9=auto_leveling, 10=vibrating, 11=flow_calibrating, 12=drying`.

Codes `0`/`200` = OK; alles andere = Fehler.

---

## 5. Mapping auf Flownt `PrinterSnapshot`

| PrinterSnapshot | Quelle |
|---|---|
| `status` | `state` → idle/printing/paused/error (paused → printing beim Push) |
| `jobResult` | State-Map oben (nur am Terminal-Übergang) |
| `printFile` | `project.filename`/`name` |
| `progressPct` | `project.progress` |
| `etaSec` | `project.remain_time` × 60 |
| `tempHotend` | `curr_nozzle_temp` |
| `tempBed` | `curr_hotbed_temp` |
| `parsedFilamentWeights` | aus `estimate_supplies_usage_g` (Gesamt; bei Multi-Color via multiColorBox-Slots/`print_filaments_weight` splitten) |
| `amsSlots` | `multiColorBox.slots[]` → {ams_unit, slot=index, material=type, color, remain=consumables_percent, tray_weight=weight} |
| `activeMqttSlot` | `multiColorBox.loaded_slot` |

**Wichtiger Unterschied zu Bambu/Prusa:** Der Filamentverbrauch kommt fertig in Gramm aus
dem Report — **kein** Datei-Download/Slicer-Parsing nötig. Das vereinfacht den Adapter
gegenüber Bambu (kein FTPS) erheblich.

---

## 6. Nicht-Ziele / Read-only

Wie bei allen Flownt-Adaptern: **read-only**. Steuerbefehle (pause/resume/stop via
`.../print`, Temperatur, Licht, Achsen) existieren im Protokoll und in beiden Repos, werden
aber bewusst NICHT implementiert.

## 7. Offene Punkte für den Hardware-Test

1. Funktioniert der MQTT-Connect OHNE Client-Cert (grunna) oder braucht es `devicecrt`/`devicepk` (stribor)?
2. Liefert `estimate_supplies_usage_g` bei euren Druckern real Werte? Bei Single-Color reicht das.
3. Multi-Color (ACE): Sind per-Slot-Gramm verfügbar oder nur Gesamtverbrauch + Slot-Prozente?
4. Exakte `state`-Strings am Terminal-Übergang (finished vs. done etc.) am echten Druckende mitschneiden.
5. Kobra X vs. S1: identische Payloads? (Erwartung ja — bitte beide Captures vergleichen.)

## 8. Beobachtetes Verhalten beim Testen (2026-08)

- **LAN-Modus-Toggle stört die Slicer-Fernsteuerung (Anycubic-seitig, nicht unser Tool):** Beim ersten Tester (2026-08-06) verschwand der Drucker nach dem Aktivieren des LAN-Modus aus der Fernsteuerung von Anycubic Slicer Next; ein Deaktivieren half nicht, **ein Power-Cycle des Druckers schon**. Ursache liegt in Anycubics Cloud-/Slicer-Binding beim Moduswechsel, nicht im read-only Probe-Tool (nur `query`/`getInfo`, keine Steuer-/Bind-/Schreibbefehle, Verbindung nur solange das Tool läuft). Konsequenz für den Adapter/das Onboarding: Nutzer vorab darauf hinweisen (Neustart des Druckers als Recovery), und die mögliche „ein aktiver Controller pro Gerät"-Regel des Brokers im Hinterkopf behalten (→ eindeutige, kurzlebige Client-ID; nicht dauerhaft parallel zum Slicer verbinden, solange nicht geklärt).

## 9. Erste echte Capture — Kobra S1, 2026-08 (494 Nachrichten, Drucker IDLE)

**Modell:** `modelName="Anycubic Kobra S1"`, `typeId=20025`, `device_id=6d8abef5…` (32-hex).
Achtung: als „Kobra X" gelabelt, aber das Gerät meldet **S1** (typeId 20025 ≠ Default 20030) — echte Kobra-X-Capture steht noch aus.

**Bestätigt (der riskante Teil funktioniert):**
- **MQTT-Connect OHNE Client-Cert** (nur `username`/`password`, `rejectUnauthorized:false`) → alle 7 Query-Typen liefern Reports. grunna-Ansatz gilt; `devicecrt`/`devicepk` nicht nötig.
- **Envelope-Struktur:** Jede Nachricht ist `{type, action, code, state, msgid, timestamp, data:{…}}`. Der **Drucker-/Job-Status liegt im Envelope (`state`)**, nicht unter `data`. Bei `status` (`action:workReport`) ist `data:null` und nur `state` gesetzt (idle: `"free"`); `info` (`action:report`) hat `state:"done"` + volle `data`.
- **Query-ACKs** kommen auf `.../printer/public/<typeId>/<deviceId>/response` mit Payload nur `{msgid}` → ignorieren (Topic endet auf `/response`, kein `type`).
- **Temperatur-Felder bestätigt** (`tempature.data`): `curr_nozzle_temp`, `curr_hotbed_temp`, `target_nozzle_temp`, `target_hotbed_temp` **+ `curr/target_chamber_temp`** (S1 ist geschlossen).
- **info.data-Keys:** `state, project, temp, urls, model, version, ip, printerName, features, last_project, print_speed_mode, fan_speed_pct, aux_fan_speed_pct, box_fan_level`.

**NOCH NICHT validiert (Drucker war die ganze Zeit idle → keine Druckdaten):**
- Kein aktiver Druck: `status.state` durchg. `"free"`, `info.state` `"done"`, `info.data.project=null`, `last_project=null`.
- **Kein `estimate_supplies_usage_g`, kein Fortschritt/Dateiname, keine State-Übergänge** → Verbrauchsbuchung + Terminal-Erkennung weiterhin offen.
- **`multi_color_box:[]` leer** (kein/keine ACE erkannt) → ACE-Slot-Struktur weiter offen.
- **Nötig:** eine Capture **WÄHREND** eines echten Drucks (kurzer Druck komplett + einmal Abbruch), idealerweise mit ACE.

Adapter-Korrekturen aus dieser Capture umgesetzt (`anycubic.ts`): Envelope-`state` erfasst, `/response` ignoriert, `type` nur aus Envelope, jobResult nur aus aktivem Job (nicht aus persistentem `info:"done"`).
