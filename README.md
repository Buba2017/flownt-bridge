# flownt-bridge

Verbindet deinen 3D-Drucker automatisch mit [Flownt](https://flownt.app).  
Öffnet einen Setup-Wizard im Browser — kein Terminal nötig nach der Installation.

## Unterstützte Drucker

| Adapter | Status |
|---|---|
| Bambu Lab (X1, P1, A1, …) | ✅ Verfügbar |
| Moonraker / Klipper | ✅ Verfügbar |
| Prusa Connect | 🔜 Bald |
| OctoPrint | 🔜 Bald |

## Setup

### Voraussetzungen

- Node.js 18 oder neuer → [nodejs.org](https://nodejs.org) → "LTS" herunterladen und installieren

### Installation (einmalig)

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge
npm install
```

### Starten

```bash
npm start
```

Beim ersten Start öffnet sich automatisch der Setup-Wizard im Browser.  
Dort gibst du einmalig deine Zugangsdaten ein — danach startet die Bridge direkt.

### Was du brauchst

**Flownt Auth-Token:**  
In Flownt → Drucker bearbeiten → Bridge-Verbindung → Token kopieren

**Bambu Lab:**  
IP-Adresse, Seriennummer und Access Code findest du am Drucker-Display unter Einstellungen → Netzwerk.  
Kein LAN-only-Modus nötig — der Drucker bleibt normal mit der Bambu App verbunden.

**Moonraker/Klipper:**  
URL deines Moonraker (z.B. `http://192.168.1.100`), API-Key optional.

## Status-Seite

Solange die Bridge läuft, erreichst du die Status-Seite unter:  
**http://localhost:7432**

## Dauerhaft laufen lassen (pm2)

```bash
npm install -g pm2
pm2 start "npm start" --name flownt-bridge
pm2 save && pm2 startup
```

## Architektur

```
Drucker (LAN)  ←MQTT/REST→  flownt-bridge  ←HTTPS→  Flownt Cloud
```

Alle Verbindungen gehen von der Bridge aus. Kein Port muss am Router geöffnet werden.
