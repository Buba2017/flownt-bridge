# Flownt Bridge

Connects your 3D printer to Flownt in real time — live status, temperatures, progress, and automatic print log entries.

## Supported Printers

| Printer | Status |
|---|---|
| Bambu Lab (X1, P1, A1, …) | ✅ |
| Klipper / Moonraker | ✅ |
| Prusa Connect | 🔜 Coming soon |
| OctoPrint | 🔜 Coming soon |

---

## Installation

### Option A – Standalone Binary (recommended, no Node.js required)

Download the file for your system from [Releases](https://github.com/Buba2017/flownt-bridge/releases/latest):

| System | File |
|---|---|
| Mac (Apple Silicon / M1–M4) | `flownt-bridge-macos-arm64` |
| Mac (Intel) | `flownt-bridge-macos-x64` |
| Windows | `flownt-bridge-win-x64.exe` |
| Raspberry Pi (64-bit) | `flownt-bridge-linux-arm64` |

**Mac** — make the file executable (run once in Terminal):
```bash
chmod +x flownt-bridge-macos-arm64
xattr -dr com.apple.quarantine flownt-bridge-macos-arm64
```
Then double-click — the binary starts without any security warning.

> **Why?** macOS blocks files downloaded from the internet that are not signed by Apple. The `xattr` command removes this quarantine flag once.

**Windows** — double-click the `.exe`. If SmartScreen warns you: click **"More info" → "Run anyway"**.

**Raspberry Pi:**
```bash
chmod +x flownt-bridge-linux-arm64
./flownt-bridge-linux-arm64
```

The browser opens automatically with the setup wizard.

---

### Option B – Via Terminal / Command Prompt (Node.js 18+ required)

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge
npm install
npm start
```

---

## Setup

After starting, the browser opens `http://localhost:7432` automatically.

### Flownt Auth Token

1. Open Flownt in another browser tab
2. Go to **Printers & Devices**
3. Click your printer → **Edit**
4. Scroll to **"Bridge Connection"**
5. Click **"Copy"** next to the token
6. Paste it into the token field

### Bambu Lab

Find all three values on the printer display under **Settings → Network**:

| Field | Example |
|---|---|
| IP Address | `192.168.1.100` |
| Serial Number | `00M09A123456789` |
| Access Code | `dc00ce26` |

> The printer does **not** need to be in LAN-only mode. It can stay connected to the Bambu app.

### Moonraker / Klipper

| Field | Description | Example |
|---|---|---|
| Printer URL | IP address of your Raspberry Pi | `http://192.168.1.100` |
| API Key | Only if configured in Moonraker (usually leave empty) | |

Click **"Save & Connect"**. The page switches to the status view — a green dot means the printer is connected.

---

## Raspberry Pi — Autostart (empfohlen)

Für einen dauerhaften Betrieb auf einem Raspberry Pi (Zero 2 W, Pi 3, Pi 4):

**Voraussetzung:** Raspberry Pi OS (Bookworm oder Bullseye, 32- oder 64-bit)

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge
npm install
npm run build
sudo bash install.sh
```

Der Installer:
- Installiert Node.js 20 automatisch (falls nicht vorhanden)
- Kopiert die Bridge nach `/opt/flownt-bridge/`
- Richtet einen systemd-Service ein (startet automatisch beim Boot, neustart bei Absturz)

Danach erreichbar unter `http://<Pi-IP-Adresse>:7432` — im Browser auf jedem Gerät im Heimnetz.

```bash
journalctl -fu flownt-bridge      # Live-Logs
sudo systemctl stop flownt-bridge  # Stoppen
sudo systemctl restart flownt-bridge  # Neustarten
```

**Update:**
```bash
git pull && npm run build && sudo bash install.sh
```

---

## Mac/Windows — Keep the Bridge running (optional)

By default the bridge only runs while the window is open.

```bash
npm install -g pm2
# Binary:
pm2 start ./flownt-bridge-macos-arm64 --name flownt-bridge
# or npm:
pm2 start "npm start" --name flownt-bridge
pm2 save
pm2 startup
```

Run the last printed command (starts with `sudo`) to enable autostart on boot.

```bash
pm2 status          # check status
pm2 stop flownt-bridge
```

---

## FAQ

**The bridge shows a connection error.**
- Make sure the printer is on and in the same network as the computer running the bridge
- Check IP address, serial number and access code
- Open http://localhost:7432/setup and re-enter the credentials

**Where is the bridge status page?**
While the bridge is running: **http://localhost:7432**

**I generated a new token in Flownt. What now?**
Open http://localhost:7432/setup, enter the new token and save.

**Does it work if the printer is on a different network?**
No — the bridge and printer must be on the same local network.

---

## Status Page

While the bridge is running, open **http://localhost:7432** (or `http://<Pi-IP>:7432` on Raspberry Pi).

The status page shows:

| Section | Details |
|---|---|
| Printer status | idle / printing / offline with filename, progress %, temperatures |
| AMS slots | Color circles per slot, material name, remaining %, active slot highlighted |
| ETA | Formatted remaining print time (e.g. `1h 23m`) |
| AMS humidity | Humidity level + temperature per AMS unit |
| Events | Last 30 events, color-coded: ✓ green (success) · ℹ gray (info) · ⚠ orange (warning) |

The page auto-refreshes every 8 seconds.

**Events logged automatically:**
- `✓ Verbindung zu Flownt hergestellt` — on startup
- `✓ Drucker verbunden: <IP>` — when MQTT connects
- `ℹ Druck gestartet: <filename>` — when a print begins
- `✓ Druckdatei geladen: <filename> (N Slot(s))` — when FTPS file download succeeds
- `⚠ Druckdatei nicht via FTPS gefunden` — when all FTPS paths fail
- `✓ Drucklog erstellt: <filename>` — after job_complete lands in Flownt

**JSON API:** `http://localhost:7432/api/state` — returns the full printer snapshot + event log as JSON.

---

## Dymo Label Printing

The bridge enables direct label printing from the browser, bypassing Dymo Connect CORS restrictions.

1. Flownt sends the print job to `http://localhost:7432/dymo/print`
2. The bridge tries the Dymo Connect REST API first (port 41951)
3. If that fails: automatic fallback via the macOS CUPS driver

**Requirements for CUPS fallback:**
- Dymo LabelWriter set up in macOS System Settings → Printers
- Dymo Connect must be running (needed for printer name detection)

**If the printer goes offline after an error:**
1. Open System Settings → Printers & Scanners
2. Select DYMO LabelWriter → Open print queue
3. Delete stuck jobs → reactivate printer

---

## Architecture

```
Printer (LAN)  ←MQTT/REST→  Flownt Bridge (local)  ←HTTPS→  Flownt Cloud
Browser        ←HTTP→       Flownt Bridge (port 7432) → CUPS → Printer
```

The bridge initiates all connections outbound. No ports need to be opened on your router.

---

## For developers – build the binary yourself

```bash
npm install
npm run package        # all platforms
npm run package:mac    # macOS arm64 only (faster)
```

Binaries are written to `dist/`.
