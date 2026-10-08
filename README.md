# Flownt Bridge

Die Flownt Bridge verbindet 3D-Drucker im lokalen Netzwerk mit [Flownt](https://flownt.app):
Live-Status, Temperaturen, Fortschritt, AMS-Belegung und automatische Drucklogs mit
Materialverbrauch. Zusätzlich kann sie Etiketten auf einem lokalen Dymo-Drucker ausgeben und
Bambu-Kameras in Flownt anzeigen.

Die Bridge läuft auf einem Rechner im selben Netzwerk wie die Drucker (Mac, Windows-PC,
Raspberry Pi, Linux-Server) und baut alle Verbindungen zu Flownt selbst auf. Am Router muss
kein Port geöffnet werden.

## Unterstützte Drucker

| Drucker | Anbindung |
|---|---|
| Bambu Lab | MQTT und FTPS im LAN, mit Access Code |
| Klipper / Moonraker | Moonraker-HTTP-API |
| Prusa Link | Prusa-Link-HTTP-API, nur lesend |

Technische Details zur Bambu-Anbindung stehen in [docs/BAMBU_LAN.md](docs/BAMBU_LAN.md).

---

## Installation

### Variante A – Installer (empfohlen)

Der Installer erkennt Betriebssystem und Architektur, lädt die passende fertige Binary aus
den [Releases](https://github.com/Buba2017/flownt-bridge/releases/latest), prüft sie gegen
die `SHA256SUMS` des Releases, richtet den Autostart ein und startet die Bridge. Node.js wird
nicht benötigt. Erneutes Ausführen aktualisiert auf die neueste Version.

Unterstützt werden nur 64-Bit-Systeme (`arm64`/`aarch64` und `x86_64`/`amd64`). Ein
32-Bit-Raspberry-Pi-OS wird abgelehnt.

**macOS und Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh | bash
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.ps1 | iex
```

Was der Installer einrichtet:

| System | Installationsort | Autostart |
|---|---|---|
| macOS | `~/.flownt-bridge/` | launchd-Agent `app.flownt.bridge` (startet bei Anmeldung) |
| Linux, mit `sudo` | `/opt/flownt-bridge/` | systemd-System-Dienst `flownt-bridge` |
| Linux, ohne `sudo` | `~/.flownt-bridge/` | systemd-User-Dienst `flownt-bridge` (läuft dank „linger“ auch ohne Anmeldung) |
| Windows | `%LOCALAPPDATA%\flownt-bridge\` | geplante Aufgabe `FlowntBridge` bei Anmeldung, sonst Verknüpfung im Autostart-Ordner |

Für einen dauerhaften Betrieb auf einem Raspberry Pi oder Server den Installer mit `sudo`
ausführen:

```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh | sudo bash
```

Weitere Installer-Optionen:

- `FLOWNT_VERSION=v<x.y.z>` installiert ein bestimmtes Release.
- `FLOWNT_SKIP_CHECKSUM=1` überspringt die Prüfsumme. Nur für ältere Releases gedacht, die ohne
  `SHA256SUMS` veröffentlicht wurden.
- Unter Linux übernimmt der Installer Einstellungen für den Dienst, siehe
  [Betrieb auf einem Server](#betrieb-auf-einem-server-und-eigene-flownt-instanz).

### Variante B – Binary manuell

Die Datei für dein System aus den
[Releases](https://github.com/Buba2017/flownt-bridge/releases/latest) laden:

| System | Datei |
|---|---|
| Mac (Apple Silicon) | `flownt-bridge-macos-arm64` |
| Mac (Intel) | `flownt-bridge-macos-x64` |
| Windows | `flownt-bridge-win-x64.exe` |
| Linux / Raspberry Pi (64-Bit, ARM) | `flownt-bridge-linux-arm64` |
| Linux (64-Bit, x86) | `flownt-bridge-linux-x64` |

**Mac:** einmalig ausführbar machen und die Quarantäne entfernen:
```bash
chmod +x flownt-bridge-macos-arm64 && xattr -d com.apple.quarantine flownt-bridge-macos-arm64
```

**Windows:** die `.exe` doppelklicken. Bei einer SmartScreen-Warnung **„Weitere Informationen“
→ „Trotzdem ausführen“** wählen.

Eine manuell gestartete Binary läuft nur, solange das Fenster offen ist. Wer sie dauerhaft
betreiben will, nimmt Variante A oder einen Prozessmanager wie `pm2`:

```bash
npm install -g pm2
pm2 start ./flownt-bridge-macos-arm64 --name flownt-bridge
pm2 save && pm2 startup
```

### Variante C – Aus dem Quellcode

Benötigt Node.js 18 oder neuer.

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge && npm install && npm start
```

---

## Einrichtung

Die Web-Oberfläche der Bridge läuft unter **http://localhost:7432**. Beim Start öffnet die
Bridge sie automatisch im Browser, solange noch kein Drucker eingerichtet ist (unter Linux
nur, wenn eine grafische Oberfläche vorhanden ist).

Beim ersten Aufruf wählst du die Rolle dieser Bridge: **Drucker überwachen**, **Etiketten
drucken** oder **Beides**. Die Rolle lässt sich jederzeit ändern.

### Kopplung mit Flownt (empfohlen)

1. In Flownt unter **„Drucker & Geräte“ → „Bridge koppeln“** einen Kopplungscode erzeugen.
2. In der Bridge unter **„Mit Flownt koppeln“** den Code und optional einen Namen für diese
   Bridge eingeben.

Danach kommen Drucker und Access Codes automatisch aus Flownt, und die Bridge gleicht sich
regelmäßig mit Flownt ab. In der Bridge muss nichts weiter eingetragen werden.

Auf einem Rechner ohne Browser (z. B. Server) koppelt die Bridge beim Start einmalig über die
Umgebungsvariable `FLOWNT_PAIRING_CODE`, optional mit `FLOWNT_BRIDGE_NAME`.

### Access Codes für Bambu-Drucker

Ohne Access Code kann die Bridge keine Verbindung zu einem Bambu-Drucker aufbauen. Fehlt ein
Code, zeigt die Statusseite einen Hinweis mit zwei Wegen:

- **Mit Bambu Cloud anmelden:** Die Bridge meldet sich einmalig bei deinem Bambu-Lab-Konto an
  (mit E-Mail-Bestätigungscode bzw. Zwei-Faktor-Code) und übernimmt die Access Codes der
  Drucker, deren Seriennummer übereinstimmt. Passwort und Anmelde-Token werden nicht
  gespeichert; die Verbindung zu den Druckern läuft danach nur lokal.
- **Codes manuell eingeben:** Der Access Code steht am Druckerdisplay unter
  **Einstellungen → Netzwerk** (bzw. WLAN).

### Drucker manuell einrichten (ohne Kopplung)

Ohne Kopplung legst du jeden Drucker in der Bridge an und trägst das Token aus Flownt ein
(**Drucker & Geräte** → Drucker bearbeiten → **Bridge** → Token kopieren).

**Bambu Lab:** IP-Adresse, Seriennummer und Access Code, alle drei am Druckerdisplay unter
**Einstellungen → Netzwerk**. Der Drucker muss dafür nicht im LAN-only-Modus sein und kann mit
der Bambu-App verbunden bleiben.

> Pause, Fortsetzen und Stopp aus Flownt funktionieren bei Bambu nur, wenn am Drucker
> **LAN-only-Modus und Developer Mode** aktiv sind. Sonst lehnt der Drucker die Befehle ab, und
> die Bridge meldet `command_rejected`. Status, AMS, Druckdateien und Kamera funktionieren in
> jedem Modus. Details in [docs/BAMBU_LAN.md](docs/BAMBU_LAN.md).

**Filamentverbrauch.** Die Bridge bucht den Verbrauch eines Druckauftrags aus der ersten Quelle,
die etwas liefert:

1. **Druckdatei** (Slicer-Gewichte je Filament) von der SD-Karte, während des Drucks oder bis zu
   30 Minuten nach Druckende.
2. **Bambu-Cloud-Auftragsverlauf** (Slicer-Gewichte je AMS-Slot), wenn die Druckdatei nicht
   lesbar ist, etwa bei H2C/X2D-Aufträgen im internen Speicher. Dafür in Flownt unter
   **Drucker & Geräte → Mit Bambu Lab anmelden** die Option „Cloud-Verlauf für die
   Materialbuchung nutzen“ wählen. Flownt verschlüsselt die Cloud-Sitzung mit dem Schlüssel
   dieser Bridge; die Bridge erneuert sie selbst. Alternativ gehen Zugangsdaten zur Bambu Cloud
   in der lokalen Konfiguration, aber nur für Konten ohne Anmeldecode per E-Mail.
3. **Früherer gleicher Auftrag:** das Slicer-Gewicht eines früheren Laufs derselben Platte auf
   demselben Drucker (gleicher Name, Planzeit ±10 %), aus dem Cloud-Verlauf oder aus Flownt.
4. **Schätzung aus der RFID-Restmenge** (nur Bambu-Spulen). Sie ist grob und dient nur, wenn
   nichts anderes vorliegt.

Liefert keine Quelle etwas, meldet die Bridge den Auftrag als „Material fehlt“; in Flownt lässt
sich das Material dann im Drucklog nachtragen.

**Klipper / Moonraker:** Drucker-URL (z. B. `http://192.168.1.100`) und, falls in Moonraker
eingerichtet, ein API-Key.

**Prusa Link:** Drucker-URL und API-Key (am Druckerdisplay unter **Einstellungen → Netzwerk →
PrusaLink**). Prusa Link wird nur gelesen: Live-Status, Fortschritt, Temperaturen, Restzeit
und Drucklogs mit Filamentverbrauch, der nach bestem Bemühen aus der Druckdatei
(`.gcode` / `.bgcode`) gelesen wird.

Mit **„Speichern & Verbinden“** startet die Verbindung; ein grüner Punkt zeigt, dass der Drucker
verbunden ist.

---

## Betrieb auf einem Server und eigene Flownt-Instanz

Die Bridge liest die folgenden optionalen Umgebungsvariablen. Sie liest **keine** `.env`-Datei;
die Werte müssen in der Umgebung des Prozesses stehen, z. B. über systemd `Environment=` bzw.
`EnvironmentFile=`. Eine kommentierte Vorlage ist [.env.example](.env.example).

| Variable | Standard | Zweck |
|---|---|---|
| `FLOWNT_EDGE_URL` | Backend von flownt.app | Edge-Functions-URL einer eigenen Flownt-Instanz, z. B. `https://<project-ref>.supabase.co/functions/v1` |
| `FLOWNT_BRIDGE_HOST` | `127.0.0.1` und `::1` | Bind-Adresse. Nur wenn sie gesetzt ist (z. B. `0.0.0.0`), ist die Oberfläche aus dem LAN erreichbar; die Bridge warnt dann im Log |
| `FLOWNT_BRIDGE_PORT` | `7432` | Port der Web-Oberfläche. Flownt spricht die Bridge im Browser unter Port 7432 an |
| `FLOWNT_BRIDGE_ADMIN_PASSWORD` | – | Passwort für die Oberfläche (Login mit Sitzung, die 12 Stunden nach der letzten Nutzung abläuft). Skripte senden es als `Authorization: Bearer …`. **Pflicht, sobald die Bridge im LAN erreichbar ist** |
| `FLOWNT_ALLOWED_ORIGINS` | – | Zusätzliche Browser-Origins, die die Bridge ansprechen dürfen (kommagetrennt, z. B. `https://flownt.example.com`). `FLOWNT_CAMERA_ORIGINS` gilt weiter als Alias |
| `FLOWNT_BRIDGE_ALLOWED_HOSTS` | – | Zusätzliche Hostnamen, unter denen die Oberfläche aufgerufen werden darf (Schutz gegen DNS-Rebinding) |
| `FLOWNT_PUBLIC_URL` | – | Öffentliche HTTPS-Adresse der Bridge, z. B. für einen Kamera-Tunnel. Wird bei jedem Abgleich an Flownt gemeldet; ihr Hostname ist automatisch erlaubt |
| `FLOWNT_FFMPEG_PATH` | `ffmpeg` aus dem `PATH` | FFmpeg für RTSP-Kameras, siehe [CAMERA.md](CAMERA.md) |
| `FLOWNT_PAIRING_CODE` | – | Koppelt die Bridge beim Start einmalig mit Flownt, solange sie noch nicht gekoppelt ist |
| `FLOWNT_BRIDGE_NAME` | – | Name der Bridge bei der Kopplung über `FLOWNT_PAIRING_CODE` |
| `FLOWNT_LOG_FILE` / `--log-file <pfad>` | – | Log in eine Datei mit Rotation (5 MB × 3) statt nur auf stdout |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` oder `error` |

**Einstellungen über den Installer (nur Linux):** Der Installer speichert `FLOWNT_BRIDGE_HOST`,
`FLOWNT_BRIDGE_ADMIN_PASSWORD`, `FLOWNT_ALLOWED_ORIGINS`, `FLOWNT_EDGE_URL` und
`FLOWNT_BRIDGE_ALLOWED_HOSTS` in `flownt-bridge.env` neben der Binary (Dateirechte 0600). Die
Datei bleibt bei Updates erhalten. Alle anderen Variablen trägst du selbst in diese Datei ein.
Die Installer für macOS und Windows speichern keine Umgebungsvariablen.

```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh \
  | sudo FLOWNT_BRIDGE_HOST=0.0.0.0 FLOWNT_BRIDGE_ADMIN_PASSWORD='ein-langes-passwort' bash
```

Ohne Freigabe im LAN erreichst du die Oberfläche per SSH-Tunnel:
`ssh -L 7432:127.0.0.1:7432 <user>@<server>` und dann `http://localhost:7432` öffnen.

**Beispiel für eine eigene systemd-Unit** mit eigenem Systembenutzer und einem selbst gebauten
Bundle:

```ini
[Unit]
Description=Flownt Bridge
After=network-online.target
Wants=network-online.target

[Service]
User=flownt-bridge
Environment=HOME=/var/lib/flownt-bridge
Environment=FLOWNT_BRIDGE_HOST=127.0.0.1
Environment=FLOWNT_EDGE_URL=https://<project-ref>.supabase.co/functions/v1
ExecStart=/usr/bin/node /opt/flownt-bridge/bundle.cjs
Restart=always
RestartSec=15
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/flownt-bridge

[Install]
WantedBy=multi-user.target
```

### Dateien und Logs

Konfiguration und Zustand liegen im Ordner `.flownt-bridge` im Home-Verzeichnis des Benutzers,
unter dem die Bridge läuft:

| Datei | Inhalt |
|---|---|
| `config.json` | Drucker, Tokens, Access Codes, Kopplung, Einstellungen (Dateirechte 0600) |
| `outbox.json` | Druckende-Meldungen, die noch an Flownt zugestellt werden müssen |
| `jobs/` | Zustand laufender Druckaufträge, damit ein Neustart mitten im Druck nichts verliert |
| `bridge-key.pem` | Schlüssel der Bridge; Flownt verschlüsselt Access Codes für diese Bridge |

Logs:

| Installation | Logs |
|---|---|
| Linux, System-Dienst | `journalctl -fu flownt-bridge` |
| Linux, User-Dienst | `journalctl --user -fu flownt-bridge` |
| macOS | `~/.flownt-bridge/bridge.log` |
| Windows | `%LOCALAPPDATA%\flownt-bridge\bridge.log` |

Dienst steuern (Linux, System-Dienst): `sudo systemctl stop|restart flownt-bridge`.

### Deinstallation

`sudo bash uninstall.sh` entfernt den Linux-System-Dienst und `/opt/flownt-bridge`. Der
Ordner `~/.flownt-bridge/` mit der Konfiguration bleibt erhalten. Für macOS, Windows und den
Linux-User-Dienst gibt es kein Deinstallationsskript.

---

## Statusseite

Die Statusseite unter **http://localhost:7432** zeigt je Drucker:

- Status (z. B. bereit, druckt, offline) mit Dateiname, Fortschritt, Temperaturen und Restzeit
- AMS-Slots mit Farbe, Material, Füllstand und aktivem Slot
- AMS-Feuchte als Stufe von 1 bis 5 und die AMS-Temperatur. Den genauen Feuchtewert in Prozent
  meldet die Bridge nur an Flownt.
- die letzten Ereignisse, farblich nach Erfolg, Information und Warnung

Die Seite aktualisiert sich alle 8 Sekunden. Als JSON gibt es denselben Stand unter
`http://localhost:7432/api/state` (mit Login, wenn ein Admin-Passwort gesetzt ist).

---

## Zuverlässigkeit

- **Outbox:** Meldungen über das Druckende werden gespeichert und so lange wiederholt, bis Flownt
  sie angenommen hat, auch über Neustarts hinweg. Flownt erkennt doppelte Meldungen.
- **Druckaufträge über Neustarts:** Der Zustand eines laufenden Drucks wird gespeichert, damit
  Dauer und Zuordnung nach einem Neustart erhalten bleiben.
- **Abgebrochene oder fehlgeschlagene Drucke** werden ohne vollen Materialabzug gemeldet; der
  Teilverbrauch wird aus Schichten bzw. Fortschritt geschätzt, mit Fehlergrund.
- **Drucke, die erst während des Drucks erkannt werden** (z. B. nach einem Neustart der Bridge):
  Wenn der Drucker keine Startzeit liefert, schätzt die Bridge sie aus Fortschritt und Restzeit.
- **Schutz vor versehentlichem Entfernen:** Würde ein Abgleich alle oder mehr als die Hälfte der
  von Flownt verwalteten Drucker entfernen, behält die Bridge sie zunächst und entfernt sie erst,
  wenn mehrere Abgleiche über einige Minuten dasselbe Ergebnis liefern. Access Codes entfernter
  Drucker bleiben 24 Stunden erhalten, damit ein zurückkehrender Drucker seinen Code wieder
  bekommt.

---

## Strommessung mit Shelly

Pro Drucker lässt sich optional die IP-Adresse eines Shelly-Zwischensteckers eintragen. Die
Bridge misst dann Leistung und Energie je Druck und meldet sie an Flownt.

---

## Etikettendruck (Dymo)

Mit der Rolle **Etiketten drucken** oder **Beides** druckt Flownt Etiketten direkt aus dem
Browser über die Bridge:

1. Flownt schickt den Druckauftrag an `http://localhost:7432/dymo/print`.
2. Die Bridge versucht zuerst die REST-API von Dymo Connect (Port 41951).
3. Klappt das nicht, druckt sie über den Systemdruckdienst (CUPS unter macOS).

Die Seite **Etikettendruck** in der Bridge listet die erkannten Systemdrucker und bietet einen
Testdruck.

**Wenn der Drucker nach einem Fehler offline ist (macOS):** Systemeinstellungen → Drucker &
Scanner → DYMO LabelWriter → Druckwarteschlange öffnen, hängende Aufträge löschen und den
Drucker wieder aktivieren.

---

## Kamera

Bambu-Kameras lassen sich über die Bridge in Flownt anzeigen. Einrichtung, Verhalten und
Sicherheit: [CAMERA.md](CAMERA.md).

---

## Sicherheitsmodell der lokalen API

| Endpunkt | Wer darf ihn aufrufen |
|---|---|
| Oberfläche (`/`, `/setup/*`, `/pair`, `/access-codes`, `/bambu-cloud`, `/api/state` …) | Mit `FLOWNT_BRIDGE_ADMIN_PASSWORD` nur nach Login. Jeder POST braucht ein CSRF-Token und denselben Origin wie die aufgerufene Adresse (funktioniert auch über SSH-Tunnel). Gespeicherte Tokens, Access Codes und Passwörter werden nie wieder angezeigt; leere Geheimnis-Felder behalten den gespeicherten Wert |
| `GET /api/version` | Alle; CORS nur für erlaubte Origins. Liefert `{ version, command_auth }` |
| `GET /healthz` | Dieser Rechner; von anderswo nur mit dem Admin-Passwort als Bearer-Token |
| `GET /diagnostics.zip` | Nur dieser Rechner, nach Login |
| `POST /printer/command` | Erlaubter Origin **und** `Authorization: Bearer <Flownt-Bridge-Token des Druckers>`. Ohne `Origin` (Skripte) nur von diesem Rechner. Nur Pause, Fortsetzen und Stopp, nur bei Bambu |
| `POST /dymo/print` | Erlaubter Origin aus einem Browser auf diesem Rechner, oder `Authorization: Bearer <Token eines Druckers dieser Bridge>` |
| `GET /camera/stream` | `Authorization: Bearer <Token des Druckers>`; für Browser zusätzlich ein erlaubter Origin |

**Erlaubte Origins:** `https://flownt.app`, `https://www.flownt.app`, `capacitor://localhost`,
`https://localhost`, `http://localhost:<port>` / `http://127.0.0.1:<port>` / `http://[::1]:<port>`,
dazu `FLOWNT_ALLOWED_ORIGINS` und die Adressen unter **Einstellungen → Weitere Flownt-Adressen**.

**Erlaubte Hostnamen (Schutz gegen DNS-Rebinding):** IP-Adressen, `localhost` und
`*.localhost`, einteilige Namen, Namen auf `.local`, `.lan`, `.internal` und `.home.arpa`, der
Hostname dieses Rechners, die Namen aus `FLOWNT_BRIDGE_ALLOWED_HOSTS` und der Hostname von
`FLOWNT_PUBLIC_URL`. Andere Hostnamen werden abgewiesen. Ausgenommen ist `/camera/`, das per
Token geschützt ist.

Ein Reverse Proxy oder Tunnel auf demselben Rechner (cloudflared, nginx) lässt jede
weitergeleitete Anfrage so aussehen, als käme sie von diesem Rechner. Darüber nur `/camera/`
weiterleiten (wie in [CAMERA.md](CAMERA.md)), nie die ganze Bridge.

---

## Diagnose

- `GET /healthz` liefert JSON ohne Geheimnisse: Version, Laufzeit, Kopplungs- und Abgleichstatus,
  die Outbox und je Drucker Verbindung, Status, Alter der letzten Druckermeldung und des letzten
  Pushs an Flownt. Beispiel auf einem Server: `curl -s http://127.0.0.1:7432/healthz | jq`.
- `GET /diagnostics.zip` (unter **Einstellungen** → „Diagnosepaket herunterladen“) ist ein Support-Paket: Versionen,
  Health-Daten, die Konfiguration mit geschwärzten Geheimnissen, die letzten Ereignisse und die
  letzten Log-Zeilen.
- Weitere Module können über `registerHealthProvider(name, fn)` aus `src/health-registry.ts`
  eigene Daten zu `/healthz` beitragen.

---

## Architektur

```
Drucker (LAN)  ←MQTT/FTPS (Bambu), HTTP (Moonraker, Prusa)→  Bridge  ←HTTPS→  Flownt
Drucker (LAN)  →SSDP-Ankündigungen (nur empfangen)→           Bridge
Browser        ←HTTP (Port 7432): Etiketten, Befehle, Kamera→ Bridge  → Dymo / CUPS
```

Die Bridge baut alle Verbindungen zu Flownt selbst auf. Bambu-Drucker im LAN erkennt sie über
ihre SSDP-Ankündigungen und übernimmt eine neue IP-Adresse automatisch.

---

## Entwicklung

```bash
npm install
npm start              # aus dem Quellcode starten
npm run dev            # mit Neustart bei Änderungen
npm test               # alle Tests
npm run typecheck
npm run build          # Bundle nach dist/bundle.cjs
npm run package        # Binaries für alle Plattformen nach dist/ (x64-Ziele brauchen auf Apple Silicon Rosetta 2)
npm run package:mac    # nur macOS arm64
```

`src/contract.ts` ist eine generierte Kopie des Datenvertrags aus Flownt und wird nicht von
Hand bearbeitet. Mehr dazu in [CONTRIBUTING.md](CONTRIBUTING.md).

### Versionierung und Releases

Die Version steht nur in `package.json`. `npm run build` übernimmt sie ins Bundle; beim Start aus
dem Quellcode liest die Bridge sie aus `package.json`. Sie erscheint in der Fußzeile der
Oberfläche, unter `GET /api/version` und `GET /healthz` und wird an Flownt gemeldet.

Release: Version erhöhen, committen und ein passendes Tag pushen
(`git tag v<x.y.z> && git push --tags`). Die GitHub-Action `release.yml` führt die Tests aus,
baut die Binaries, schreibt `SHA256SUMS` und hängt alles an das GitHub-Release. `ci.yml` prüft
Typen, Tests und Build bei Pushes auf `main` und `develop` und bei Pull Requests.

---

## Mitwirken

Beiträge sind willkommen. Regeln und Rechte an Beiträgen: [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

Die Flownt Bridge ist quelloffen und steht unter der [Elastic License 2.0](LICENSE). Kurz
zusammengefasst:

- Nutzen, kopieren, verändern und weitergeben ist erlaubt, auch kommerziell und im eigenen
  Unternehmen.
- Nicht erlaubt ist, die Software Dritten als gehosteten oder verwalteten Dienst anzubieten,
  bei dem diese Zugriff auf einen wesentlichen Teil ihrer Funktionen erhalten.
- Lizenzschlüssel-Funktionen dürfen nicht umgangen und Lizenz-, Urheber- und andere Hinweise
  nicht entfernt werden.

Verbindlich ist allein der Lizenztext in [LICENSE](LICENSE).
