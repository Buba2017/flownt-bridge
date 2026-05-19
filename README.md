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

## Schritt 1 – Node.js installieren

Node.js ist das Programm, das die Bridge ausführt. Du brauchst es nur einmal installieren.

1. Öffne [nodejs.org](https://nodejs.org)
2. Klicke auf den großen **„LTS"**-Button (die empfohlene Version)
3. Lade die Datei herunter und installiere sie wie jede andere App
4. Nach der Installation kannst du direkt weitermachen

> **Mac-Nutzer:** Wenn du gefragt wirst, ob du das Paket öffnen möchtest obwohl es aus dem Internet stammt – auf „Öffnen" klicken.

---

## Schritt 2 – Bridge herunterladen

1. Öffne diese Seite: [github.com/Buba2017/flownt-bridge](https://github.com/Buba2017/flownt-bridge)
2. Klicke auf den grünen Button **„Code"**
3. Wähle **„Download ZIP"**
4. Entpacke die ZIP-Datei (Doppelklick auf die Datei)
5. Schiebe den entpackten Ordner `flownt-bridge-main` an einen festen Platz, z.B. in deinen Dokumente-Ordner

---

## Schritt 3 – Bridge einrichten (einmalig)

### Mac

1. Öffne den Ordner `flownt-bridge-main`
2. Mache einen **Rechtsklick** auf eine leere Stelle im Ordner
3. Wähle **„Neues Terminal-Fenster im Ordner"** (oder auf neueren Macs: **„Terminal hier öffnen"**)
4. Tippe ins Terminal:
   ```
   npm install
   ```
   Drücke Enter und warte bis es fertig ist (dauert 1–2 Minuten)

### Windows

1. Öffne den Ordner `flownt-bridge-main`
2. Klicke in die Adressleiste des Explorer-Fensters (oben, wo der Pfad steht)
3. Tippe `cmd` und drücke Enter – ein schwarzes Fenster öffnet sich
4. Tippe:
   ```
   npm install
   ```
   Drücke Enter und warte bis es fertig ist (dauert 1–2 Minuten)

### Raspberry Pi

```bash
cd flownt-bridge-main
npm install
```

---

## Schritt 4 – Bridge starten

Tippe ins Terminal (im Ordner `flownt-bridge-main`):

```
npm start
```

Der Browser öffnet sich automatisch und zeigt dir einen Einrichtungsassistenten.

---

## Schritt 5 – Einrichten im Browser

Du siehst jetzt eine Seite mit dem Titel **„Einrichtung"**. Fülle folgende Felder aus:

### Flownt Auth-Token

1. Öffne Flownt in einem anderen Browser-Tab
2. Gehe zu **Drucker & Geräte**
3. Klicke auf deinen Drucker → **Bearbeiten**
4. Scrolle bis zum Abschnitt **„Bridge-Verbindung"**
5. Klicke auf **„Kopieren"** neben dem Token
6. Füge den Token in das Feld ein (Cmd+V auf Mac, Strg+V auf Windows)

### Bambu Lab Drucker

Du brauchst drei Angaben, die alle am **Drucker-Display** zu finden sind:

**Einstellungen → Netzwerk** (auf dem Display des Druckers)

| Was | Wo am Display | Beispiel |
|---|---|---|
| IP-Adresse | Netzwerk → IP-Adresse | `192.168.1.100` |
| Seriennummer | Netzwerk → Seriennummer | `00M09A123456789` |
| Access Code | Netzwerk → Access Code | `dc00ce26` |

> Der Drucker muss **nicht** im LAN-only-Modus betrieben werden. Er kann normal mit der Bambu App verbunden bleiben.

### Moonraker / Klipper

| Was | Beschreibung | Beispiel |
|---|---|---|
| Drucker-URL | IP-Adresse deines Raspberry Pi | `http://192.168.1.100` |
| API Key | Nur ausfüllen wenn in Moonraker konfiguriert (meist leer lassen) | |

---

## Schritt 6 – Fertig

Klicke auf **„Speichern & Verbinden"**.

Die Seite wechselt zur Status-Ansicht. Du siehst:
- **Bereit** (grüner Punkt) = Drucker ist verbunden
- In Flownt erscheint auf der Druckerkarte ein grüner **„Bridge"**-Punkt

---

## Bridge dauerhaft laufen lassen (optional)

Standardmäßig läuft die Bridge nur, solange das Terminal-Fenster offen ist. Damit sie immer automatisch startet:

### Mac / Linux / Raspberry Pi

```bash
npm install -g pm2
pm2 start "npm start" --name flownt-bridge
pm2 save
pm2 startup
```

Den letzten ausgegebenen Befehl (beginnt mit `sudo`) noch einmal einfügen und Enter drücken.

Ab sofort startet die Bridge automatisch beim Hochfahren.

### Status prüfen

```bash
pm2 status
```

### Bridge stoppen

```bash
pm2 stop flownt-bridge
```

---

## Häufige Fragen

**Die Bridge zeigt „Verbindungsfehler" an.**
- Prüfe ob der Drucker eingeschaltet und im gleichen WLAN ist wie der Computer mit der Bridge
- Prüfe ob IP-Adresse, Seriennummer und Access Code korrekt eingetragen sind
- Öffne http://localhost:7432/setup und trage die Daten neu ein

**Wo finde ich die Status-Seite der Bridge?**
Solange die Bridge läuft, erreichst du sie unter: **http://localhost:7432**

**Ich habe einen neuen Token in Flownt generiert. Was jetzt?**
Öffne http://localhost:7432/setup, trage den neuen Token ein und speichere.

**Funktioniert das auch, wenn der Drucker in einem anderen WLAN ist?**
Nein – Bridge und Drucker müssen im gleichen Netzwerk sein.

---

## Architektur (für Interessierte)

```
Drucker (LAN)  ←MQTT/REST→  Flownt Bridge (lokal)  ←HTTPS→  Flownt Cloud
```

Die Bridge stellt selbst alle Verbindungen her. Es müssen keine Ports am Router geöffnet werden.
