# Bambu-Lab-Drucker im LAN – worauf sich die Bridge stützt

Notizen zu den Teilen des Bambu-LAN-Protokolls, die die Bridge nutzt, mit den Eigenheiten von
Modellen und Firmware, auf die wir gestoßen sind. Geprüft an X1C-, X2D- und H2C-Druckern
(Firmware-Stand 2026-10). Einige Fakten wurden mit dem Projekt
[bambuddy](https://github.com/maziggy/bambuddy) abgeglichen. Es steht unter AGPL-3.0: Wir
übernehmen daraus Wissen über das Protokoll, niemals Code.

## Verbindungen

| Was | Port | Hinweise |
|---|---|---|
| MQTT (Status, Befehle) | 8883, TLS | Benutzer `bblp`, Passwort = LAN-Access-Code; Meldungen auf `device/<serial>/report`, Anfragen auf `device/<serial>/request` |
| FTPS (Druckdateien) | 990, implizites TLS | Benutzer `bblp`, Passwort = Access Code; siehe unten |
| Kamera X1/X2/H2/P2 | 322, RTSPS | „LAN Only Liveview“ muss am Drucker eingeschaltet sein, sonst `ipcam.rtsp_url = "disable"` |
| Kamera A1/P1 | 6000, TLS-JPEG | |
| Erkennung (SSDP) | UDP 2021/1990 | Drucker melden Seriennummer, Modellcode, Name und IP; nie den Access Code |

## Steuerbefehle brauchen den Developer Mode

Seit der „Autorisierungs“-Firmware von 2025 lehnen Drucker im normalen (Cloud-)Modus
Steuerbefehle über LAN-MQTT ab oder ignorieren sie: Pause, Fortsetzen, Stopp, Druckstart,
Temperatur- und AMS-Steuerung. Sie funktionieren nur mit **LAN-only-Modus + Developer Mode** am
Drucker; damit sind Bambu Cloud und Bambu Handy für diesen Drucker abgeschaltet. Eine Ablehnung
zeigt sich als Befehlsantwort mit `result != "success"`, als fehlende Antwort oder als HMS
`0500_0500_0001_0007` („MQTT command verification failed“). Die Bridge meldet das als
`command_rejected` (HTTP 409 auf `/printer/command`). Status, AMS-Daten, Dateien und Kamera
funktionieren in allen Modi.

Ein Befehl gilt immer genau einem Drucker: `/printer/command` erkennt ihn am
Flownt-Bridge-Token im `Authorization`-Header. `printerId` (lokal) und `flowntPrinterId` sind
optional; werden sie mitgeschickt, müssen sie zum Token passen, sonst antwortet die Bridge mit
403 `token_mismatch`.

## Druckzustand (`print.gcode_state`)

| gcode_state | Flownt-Status | job_state | Bedeutung |
|---|---|---|---|
| `IDLE`, `""` | idle | idle | nichts läuft |
| `PREPARE`, `SLICING` | printing | preparing | Aufheizen, Leveln, Kalibrieren – der Drucker ist belegt |
| `RUNNING` | printing | printing | |
| `PAUSE` | paused | paused | |
| `FINISH` | idle | finished | Auftrag fertig; die Druckplatte ist noch belegt |
| `FAILED` | error | failed | fehlgeschlagen oder gestoppt (die Firmware meldet einen manuellen Stopp als FAILED) |

- Ein Auftrag kann während `PREPARE` scheitern, ohne je `RUNNING` zu erreichen; er muss trotzdem
  als fehlgeschlagener Auftrag enden. Deshalb zählt `PREPARE` als Drucken.
- `print_error` ist ein 32-Bit-Wert, dargestellt als `MMMM_EEEE`. Untere Worte unter `0x4000`
  sind Statuswerte, keine Fehler.
- **HMS** (`print.hms`, Liste von `{attr, code}`): Der am Drucker angezeigte Code ist `attr`
  (obere/untere 16 Bit) + `code` (obere/untere 16 Bit) als Hex, `XXXX_XXXX_XXXX_XXXX`. Der
  Schweregrad ist `code >> 16`: 1 fatal, 2 schwer, 3 normal, 4 Info. Erklärung:
  `https://e.bambulab.com/index.php?e=<Code ohne _>&s=device_hms&lang=en` (leitet ins
  Bambu-Wiki weiter).

## AMS und Slot-Nummerierung

- AMS-Einheiten-IDs kommen aus `ams.ams[].id` und müssen nicht bei 0 beginnen (ein X1C mit zwei
  AMS meldete die Einheiten 1 und 2). Immer die IDs verwenden, nie Array-Positionen.
- Globale Slot-Nummer in Flownt: `unit * 4 + slot`. AMS-HT-Einheiten haben die IDs 128–135 mit
  je einem Slot. 254 = externe Spule, 255 = kein Slot.
- **`ams.tray_now` reicht bei Doppeldüsen-Druckern nicht** (H2D, H2C, X2D): Dort ist es nur der
  Slot innerhalb seiner Einheit (ein H2C, der aus Einheit 1, Slot 2 druckte, meldete
  `tray_now = "2"`). Die verlässliche Quelle auf allen aktuellen Firmwares ist
  `device.extruder.info[i].snow` = `(ams_id << 8) | slot` der Spule im Extruder `i`
  (65535 = keine), wobei der aktive Extruder in den Bits 4–7 von `device.extruder.state` steht.
- `print.mapping` (während eines Auftrags): ein Eintrag je Slicer-Filament (Index = Filament-ID
  − 1), Wert `(ams_id << 8) | slot`; 65535 = nicht genutzt oder externe Spule.
- `get_version` (`{"info":{"command":"get_version"}}`) listet Module auf; das AMS-Modell ergibt
  sich aus dem Präfix des Modulnamens: `ams/` AMS, `ams_f1/` AMS Lite, `n3f/` AMS 2 Pro,
  `n3s/` AMS HT.
- RFID: `tray_uuid` identifiziert eine Bambu-Spule (beide Tags einer Spule teilen sie; nur
  Nullen = kein Tag), `tray_info_idx` ist der Bambu-Filamentcode (z. B. `GFA00`, `GFB50`),
  `tray_sub_brands` die Produktlinie, `remain` der Füllstand in % (−1 unbekannt) und
  `tray_weight` das Nettogewicht der Spule in g.

## Druckdateien über FTPS

- **TLS-Session-Reuse ist Pflicht** auf aktueller Firmware (vsftpd `require_ssl_reuse`): Die
  TLS-Datenverbindung muss die Session der Steuerverbindung wiederaufnehmen, sonst antwortet
  der Drucker mit `522 SSL connection failed: session reuse required`. basic-ftp erfüllt das
  auf diesen Druckern nicht, deshalb nutzt die Bridge einen eigenen kleinen Client
  (`src/adapters/ftps.ts`), begrenzt auf TLS 1.2.
- A1 / A1 mini lehnen den verschlüsselten Datenkanal ab; der Client fällt einmalig auf `PROT C`
  zurück (unverschlüsselter Datenkanal, verschlüsselter Steuerkanal) und merkt sich das je
  Drucker.
- Nach einem Fehler auf Verbindungsebene lässt die Bridge FTPS am Drucker 5 Minuten in Ruhe
  (manche X2D-Firmware antwortet nach einem fehlgeschlagenen Handshake mit Unsinn).
- **Wo die Datei liegt:** FTPS liefert nur den externen Speicher (SD-Karte / USB-Stick).
  - X1/P1/A1 legen dort von jedem gesendeten Auftrag eine Kopie ab: `/cache/<name>.gcode.3mf`
    oder im Hauptverzeichnis.
  - H2D/H2C/H2S/X2D/P2S haben internen Speicher und legen aus Bambu Studio gesendete Aufträge
    dort ab, wenn beim Senden nicht die SD-Karte als Ziel gewählt wird. Solche Aufträge sind
    über FTPS nicht lesbar, also gibt es dafür keine Plattenvorschau und keine Gewichte aus dem
    Slicer. Auch Nachdrucke am Druckerdisplay laufen aus dem internen Speicher.
  - Der Drucker meldet beim Start die Quelle (`project_file`, `url`). `file:///userdata/…` oder
    `file:///data/…` heißt nicht zwingend, dass die Datei fehlt: Der X1C meldet Nachdrucke mit
    `file:///data/…`, die Datei liegt aber weiter in `/cache` auf der SD-Karte. Die Bridge sucht
    deshalb immer einmal auf der Karte.
  - Die Bridge fragt in diesem Fall den Bambu-Cloud-Auftragsverlauf ab
    (`GET /v1/user-service/my/tasks?deviceId=<Seriennummer>`, `amsDetailMapping[]` mit Gramm je
    Tray), sonst schätzt sie aus dem Rückgang der RFID-Restmenge (`remain`) zwischen Druckbeginn
    und -ende. Der Cloud-Verlauf kennt nur Aufträge, die über die Cloud gestartet wurden; per LAN
    gesendete Aufträge melden `subtask_id: ""` und `job_id: "0"`.
  - Vorschau: Ohne lesbare Druckdatei nimmt die Bridge das Plattenbild (`cover`, PNG) des
    Cloud-Auftrags, sonst eines früheren Laufs derselben Platte (gleicher Name, Planzeit ±10 %).
  - Zuordnung Cloud-Auftrag ↔ Druckauftrag: zuerst über `task_id`/`subtask_id`/`job_id`, sonst
    über denselben Drucker, Start- oder Endzeit (±20 min) und den Auftragsnamen.
  - Die Datei bleibt nach dem Druck auf der SD-Karte. Konnte die Bridge sie während des Drucks
    nicht laden, versucht sie es bis zu 30 Minuten nach Druckende erneut, bevor sie die
    Job-Meldung sendet.
- Dateinamen: Leerzeichen können zu `_` werden, und ein `/` im Auftragsnamen wird als `2f`
  gespeichert. Die Bridge probiert diese Varianten und listet danach `/cache`, `/` und `/model`.
- `gcode_file` (`/data/Metadata/plate_<n>.gcode`) gibt die gedruckte Platte an.

## Die .3mf-Druckdatei

- `Metadata/slice_info.config` (XML): je `<plate>` der `index`, `printer_model_id`
  (z. B. `BL-P001` X1C, `O1C2` H2C, `N6` X2D), `nozzle_diameters`, `prediction` (s), `weight` und
  je genutztem Filament ein `<filament>` mit `id` (Slicer-Filament, ab 1), `type`, `color`,
  `used_g`, `used_m`, `tray_info_idx` und bei Doppeldüsen-Druckern `group_id` (Düse).
- Aus Bambu Studio gesendete Dateien enthalten nur die gedruckte Platte. Ein Projekt mit mehreren
  gesliceten Platten führt jede Platte einzeln auf; die Bridge zählt deshalb nur die Platte, die
  gerade gedruckt wird.
- `Metadata/plate_<n>.png` ist das Vorschaubild der Platte (512×512) für die Druckvorschau.

## Nicht umgesetzt: Druckstart aus Flownt

Eine geslicete Datei hochzuladen und zu starten bräuchte den Developer Mode (siehe oben) und bei
Doppeldüsen-Druckern ein korrektes `nozzle_mapping`; eine falsche Zuordnung kann mit der einen
Düse leveln und mit der anderen über dem Druckbett drucken. Bewusst nicht gebaut.
