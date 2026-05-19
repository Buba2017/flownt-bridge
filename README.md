# flownt-bridge

Lokaler Daemon, der deinen 3D-Drucker mit [Flownt](https://flownt.app) verbindet.

Läuft auf deinem PC, Mac, Raspberry Pi oder NAS und kommuniziert nur ausgehend — keine offenen Ports nötig.

## Unterstützte Drucker

| Adapter | Status |
|---|---|
| Moonraker / Klipper | ✅ Verfügbar |
| Bambu Lab | 🔜 Bald |
| Prusa Connect | 🔜 Bald |
| OctoPrint | 🔜 Bald |

## Setup

### 1. Voraussetzungen

- Node.js 18 oder neuer
- npm

### 2. Projekt einrichten

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge
npm install
cp .env.example .env
```

### 3. .env befüllen

Öffne `.env` und fülle folgende Werte aus:

- **FLOWNT_AUTH_TOKEN**: Deinen Auth-Token aus Flownt kopieren  
  *(Drucker → Bearbeiten → Bridge-Verbindung → Token-Feld → Kopieren)*
- **FLOWNT_EDGE_URL**: `https://<dein-projekt>.supabase.co/functions/v1`  
  *(zu finden in der Flownt .env.example oder beim Support)*
- **ADAPTER_URL**: Lokale IP deines Klipper-Druckers, z.B. `http://192.168.1.100`

### 4. Starten

```bash
npm start
```

Die Bridge verbindet sich sofort und zeigt den Drucker-Status in Flownt unter "Drucker & Geräte".

## Dauerhaft laufen lassen (pm2)

```bash
npm install -g pm2
pm2 start "npm start" --name flownt-bridge
pm2 save
pm2 startup
```

## Architektur

```
Drucker (LAN)  ←REST→  flownt-bridge  ←HTTPS POST→  Flownt Cloud
```

Alle Verbindungen gehen von der Bridge aus. Kein Port muss am Router geöffnet werden.
