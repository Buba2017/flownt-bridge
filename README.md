# Flownt Bridge – Installationsanleitung

Verbindet deinen 3D-Drucker automatisch mit Flownt. Du siehst dann in Flownt live, was dein Drucker gerade macht.

## Unterstützte Drucker

| Drucker | Status |
|---|---|
| Bambu Lab (X1, P1, A1, …) | ✅ |
| Klipper / Moonraker | ✅ |
| Prusa Connect | 🔜 Bald |
| OctoPrint | 🔜 Bald |

---

## Installation

### Option A – Standalone-Binary (empfohlen, kein Node.js nötig)

1. Lade die passende Datei für dein System von den [Releases](https://github.com/Buba2017/flownt-bridge/releases) herunter:

   | System | Datei |
   |---|---|
   | Mac (Apple Silicon / M1–M4) | `flownt-bridge-macos-arm64` |
   | Mac (Intel) | `flownt-bridge-macos-x64` |
   | Windows | `flownt-bridge-win-x64.exe` |
   | Raspberry Pi (64-bit) | `flownt-bridge-linux-arm64` |

2. **Mac:** Datei einmalig freigeben (Terminal im Download-Ordner):
   ```bash
   chmod +x flownt-bridge-macos-arm64
   xattr -dr com.apple.quarantine flownt-bridge-macos-arm64
   ```
   Danach Doppelklick — die Binary startet ohne Sicherheitswarnung.

   > **Alternativ ohne Terminal:** Rechtsklick auf die Datei → **„Öffnen"** → im Dialog **„Öffnen"** klicken. Nur per Rechtsklick möglich, nicht per Doppelklick.

3. **Windows:** Doppelklick auf `.exe` — bei SmartScreen-Warnung auf **„Weitere Informationen" → „Trotzdem ausführen"**

4. **Raspberry Pi:**
   ```bash
   chmod +x flownt-bridge-linux-arm64
   ./flownt-bridge-linux-arm64
   ```

Der Browser öffnet sich automatisch mit dem Einrichtungsassistenten.

---

### Option B – Mit Node.js (für Entwickler / ältere Systeme)

**Voraussetzung:** [Node.js 18+](https://nodejs.org) installiert

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge
npm install
npm start
```

---

## Einrichtung im Browser

Nach dem Start öffnet sich automatisch `http://localhost:7432` mit dem Einrichtungsassistenten.

### Flownt Auth-Token

1. Öffne Flownt in einem anderen Browser-Tab
2. Gehe zu **Drucker & Geräte**
3. Klicke auf deinen Drucker → **Bearbeiten**
4. Scrolle bis zum Abschnitt **„Bridge-Verbindung"**
5. Klicke auf **„Kopieren"** neben dem Token
6. Füge den Token in das Feld ein (Cmd+V auf Mac, Strg+V auf Windows)

### Bambu Lab Drucker

Du brauchst drei Angaben — alle am **Drucker-Display** unter **Einstellungen → Netzwerk**:

| Was | Beispiel |
|---|---|
| IP-Adresse | `192.168.1.100` |
| Seriennummer | `00M09A123456789` |
| Access Code | `dc00ce26` |

> Der Drucker muss **nicht** im LAN-only-Modus betrieben werden. Er kann normal mit der Bambu App verbunden bleiben.

### Moonraker / Klipper

| Was | Beschreibung | Beispiel |
|---|---|---|
| Drucker-URL | IP-Adresse deines Raspberry Pi | `http://192.168.1.100` |
| API Key | Nur ausfüllen wenn in Moonraker konfiguriert (meist leer lassen) | |

---

## Fertig

Klicke auf **„Speichern & Verbinden"**.

Die Seite wechselt zur Status-Ansicht:
- **Bereit** (grüner Punkt) = Drucker ist verbunden
- In Flownt erscheint auf der Druckerkarte ein grüner **„Bridge"**-Punkt

---

## Bridge dauerhaft laufen lassen (optional)

Standardmäßig läuft die Bridge nur, solange das Fenster offen ist.

### Mac / Linux / Raspberry Pi (pm2)

```bash
npm install -g pm2
# Binary:
pm2 start ./flownt-bridge-macos-arm64 --name flownt-bridge
# oder npm:
pm2 start "npm start" --name flownt-bridge
pm2 save
pm2 startup
```

Den letzten ausgegebenen Befehl (beginnt mit `sudo`) noch einmal einfügen und Enter drücken.

### Status prüfen / stoppen

```bash
pm2 status
pm2 stop flownt-bridge
```

---

## Häufige Fragen

**Die Bridge zeigt „Verbindungsfehler" an.**
- Prüfe ob der Drucker eingeschaltet und im gleichen WLAN ist wie der Computer mit der Bridge
- Prüfe ob IP-Adresse, Seriennummer und Access Code korrekt sind
- Öffne http://localhost:7432/setup und trage die Daten neu ein

**Wo finde ich die Status-Seite der Bridge?**
Solange die Bridge läuft: **http://localhost:7432**

**Ich habe einen neuen Token in Flownt generiert. Was jetzt?**
Öffne http://localhost:7432/setup, trage den neuen Token ein und speichere.

**Funktioniert das auch, wenn der Drucker in einem anderen WLAN ist?**
Nein – Bridge und Drucker müssen im gleichen Netzwerk sein.

---

## Dymo-Etikettendruck

Die Bridge ermöglicht direkten Etikettendruck vom Browser aus.

**Wie es funktioniert:**
1. Flownt sendet den Druckauftrag an `http://localhost:7432/dymo/print`
2. Die Bridge versucht zuerst die Dymo Connect REST API (Port 41951)
3. Falls das fehlschlägt: automatischer Fallback über den macOS-Druckertreiber (CUPS)

**Voraussetzungen für CUPS-Fallback:**
- Dymo LabelWriter in macOS unter Systemeinstellungen → Drucker eingerichtet
- Dymo Connect muss laufen (wird für die Drucker-Erkennung benötigt)

**Falls der Drucker nach einem Fehler offline ist:**
1. Systemeinstellungen → Drucker & Scanner öffnen
2. DYMO LabelWriter auswählen → Druckerwarteschlange öffnen
3. Hängende Aufträge löschen → Drucker reaktivieren

---

## Architektur

```
Drucker (LAN)  ←MQTT/REST→  Flownt Bridge (lokal)  ←HTTPS→  Flownt Cloud
Browser        ←HTTP→       Flownt Bridge (Port 7432) → CUPS → Drucker
```

Die Bridge stellt selbst alle Verbindungen her. Es müssen keine Ports am Router geöffnet werden.

---

## Für Entwickler – Binary selbst bauen

```bash
npm install
npm run package        # alle Plattformen
npm run package:mac    # nur macOS arm64 (schneller)
```

Binaries landen in `dist/`.
