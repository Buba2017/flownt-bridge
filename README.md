# Flownt Bridge

Connects your 3D printer to Flownt in real time — live status, temperatures, progress, and automatic print log entries.

Version 0.10.0 adds on-demand Bambu camera streaming. See [camera setup](CAMERA.md).

## Supported Printers

| Printer | Status |
|---|---|
| Bambu Lab (X1, P1, A1, …) | ✅ |
| Klipper / Moonraker | ✅ |
| Prusa Link (MK4, XL, MINI, Core One) | ✅ (v0.5.0) |
| Anycubic Kobra (X, S1) | 🧪 In testing |
| OctoPrint | 🔜 Coming soon |

---

## Installation

### Option A – Ein Befehl (empfohlen)

Erkennt System & Architektur automatisch, lädt die passende Binary, löst die
Sicherheits-Sperre (macOS-Quarantäne / Windows-SmartScreen), richtet **Autostart**
ein und startet die Bridge. Erneut ausführen = auf neueste Version aktualisieren.

**macOS & Linux (Raspberry Pi / Mini-PC):**
```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh | bash
```
*(Für einen System-Dienst auf dem Pi mit `sudo bash` davor ausführen.)*

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.ps1 | iex
```

Danach öffnet sich die Web-Oberfläche unter **http://localhost:7432** — dort wählst du,
was diese Bridge tun soll (Drucker überwachen / Etiketten drucken).

---

### Option B – Binary manuell

Datei für dein System aus den [Releases](https://github.com/Buba2017/flownt-bridge/releases/latest) laden:

| System | Datei |
|---|---|
| Mac (Apple Silicon / M1–M4) | `flownt-bridge-macos-arm64` |
| Mac (Intel) | `flownt-bridge-macos-x64` |
| Windows | `flownt-bridge-win-x64.exe` |
| Raspberry Pi (64-bit) | `flownt-bridge-linux-arm64` |
| Linux PC (64-bit) | `flownt-bridge-linux-x64` |

**Mac** — einmalig im Terminal ausführbar machen + Quarantäne lösen:
```bash
chmod +x flownt-bridge-macos-arm64 && xattr -d com.apple.quarantine flownt-bridge-macos-arm64
```
**Windows** — `.exe` doppelklicken. Bei SmartScreen-Warnung: **„Weitere Informationen" → „Trotzdem ausführen"**.

---

### Option C – Aus dem Quellcode (Node.js 18+)

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge && npm install && npm start
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

### Prusa Link

| Field | Description | Example |
|---|---|---|
| Printer URL | IP address of the printer | `http://192.168.1.100` |
| API Key | From the printer display: **Settings → Network → PrusaLink** | |

Read-only: live status, progress, temperatures, ETA, and automatic print logs with filament usage on completion. Filament weight is parsed from the print file (`.gcode` / `.bgcode`, best-effort).

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
- Lädt die **fertige Release-Binary** für die Architektur nach `/opt/flownt-bridge/` (der lokale
  Build aus `npm run build` wird dabei **nicht** verwendet, Node.js wird nicht benötigt)
- Richtet einen systemd-Service ein (startet automatisch beim Boot, neustart bei Absturz)

Wer einen eigenen Build (z. B. mit Änderungen) als Dienst betreiben will, startet
`node dist/bundle.cjs` über eine eigene systemd-Unit — siehe *Server-Betrieb* unten.

Die Oberfläche lauscht standardmäßig nur auf dem Pi selbst (`127.0.0.1`). Für den Zugriff
von anderen Geräten im Heimnetz den Installer mit Bind-Adresse **und Admin-Passwort** ausführen —
die Werte landen in `/opt/flownt-bridge/flownt-bridge.env` (0600) und bleiben bei Updates erhalten:

```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh \
  | sudo FLOWNT_BRIDGE_HOST=0.0.0.0 FLOWNT_BRIDGE_ADMIN_PASSWORD='ein-langes-passwort' bash
```

Danach erreichbar unter `http://<Pi-IP-Adresse>:7432`. Ohne Freigabe: `ssh -L 7432:127.0.0.1:7432 pi@<Pi-IP>`
und `http://localhost:7432` öffnen.

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

## Server-Betrieb / eigene Flownt-Instanz

Für den Dauerbetrieb auf einem gemeinsam genutzten Linux-Server und für selbst gehostete
Flownt-Instanzen liest die Bridge diese optionalen Umgebungsvariablen (siehe `.env.example`):

| Variable | Standard | Zweck |
|---|---|---|
| `FLOWNT_EDGE_URL` | flownt.app | Supabase-Edge-Functions-URL der eigenen Flownt-Instanz (`https://<ref>.supabase.co/functions/v1`) |
| `FLOWNT_BRIDGE_HOST` | `127.0.0.1` + `::1` | Bind-Adresse. Nur explizit gesetzt (z. B. `0.0.0.0`) ist die Bridge im LAN erreichbar |
| `FLOWNT_BRIDGE_PORT` | `7432` | Port der Web-Oberfläche |
| `FLOWNT_BRIDGE_ADMIN_PASSWORD` | – | Passwort für die Setup-Oberfläche (Sitzungs-Cookie, 12 h). **Pflicht, sobald die Bridge im LAN erreichbar ist** |
| `FLOWNT_ALLOWED_ORIGINS` | – | Zusätzliche Browser-Origins, die die Bridge ansprechen dürfen (kommagetrennt, z. B. `https://flownt.example.com`). `FLOWNT_CAMERA_ORIGINS` gilt weiter als Alias |
| `FLOWNT_BRIDGE_ALLOWED_HOSTS` | – | Zusätzliche Hostnamen, unter denen die Oberfläche aufgerufen wird (Schutz gegen DNS-Rebinding; IPs, `localhost`, `*.local` und einteilige Namen sind immer erlaubt) |
| `FLOWNT_LOG_FILE` / `--log-file` | – | Log in eine Datei mit Rotation (5 MB × 3) statt stdout |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` oder `error` |

Auf einem Server die Oberfläche auf `127.0.0.1` lassen und per SSH-Tunnel öffnen:
`ssh -L 7432:127.0.0.1:7432 user@server` → `http://localhost:7432`. Beim Start mit einer
Nicht-Loopback-Adresse schreibt die Bridge eine Warnung ins Log.

Beispiel-Unit mit eigenem Systembenutzer:

```ini
[Unit]
Description=Flownt Bridge
After=network-online.target
Wants=network-online.target

[Service]
User=flownt-bridge
Environment=HOME=/var/lib/flownt-bridge
Environment=FLOWNT_BRIDGE_HOST=127.0.0.1
Environment=FLOWNT_EDGE_URL=https://<ref>.supabase.co/functions/v1
ExecStart=/usr/bin/node /opt/flownt-bridge/bundle.cjs
Restart=always
RestartSec=15
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/flownt-bridge

[Install]
WantedBy=multi-user.target
```

---

## Health and diagnostics

- `GET /healthz` — JSON without secrets: bridge and contract version, uptime, pairing/sync state
  and per printer adapter type, `connected`, `status`, `last_message_age_s` (last snapshot from the
  printer) and `last_push_age_s` (last push to Flownt). `status` is `ok` or `degraded`. Open from
  this computer; from elsewhere only with `Authorization: Bearer <FLOWNT_BRIDGE_ADMIN_PASSWORD>`.
  Example on a server: `curl -s http://127.0.0.1:7432/healthz | jq`.
- `GET /diagnostics.zip` — support bundle (link under **Settings**): versions, health, redacted
  config (tokens, access codes and passwords replaced by `[redacted]`), recent events and the last
  1000 log lines (scrubbed of known secrets). Only from this computer (SSH tunnels work) and behind
  the setup-UI login.
- Other modules can add data to `/healthz` with `registerHealthProvider(name, fn)` from
  `src/health-registry.ts`; a provider named `outbox` fills the top-level `outbox` field.

---

## Paired bridges: protection against accidental printer removal

A bridge paired with Flownt takes its printers from the `bridge-sync` function. If a sync
would remove **all** managed printers or **more than half** of them (e.g. the backend
briefly returns an empty list), the bridge keeps them and logs a warning; the removal is
only applied after the same result was seen in 3 consecutive syncs spanning at least
5 minutes. Access codes of removed printers are kept for 24 h (`removedSecrets` in
`config.json`), so a printer that comes back gets its code again automatically.

---

## Security model of the local API

| Endpoint | Who may call it |
|---|---|
| Setup UI (`/`, `/setup/*`, `/pair`, `/access-codes`, `/bambu-cloud`, `/api/state`, …) | Same-origin only. Every form carries a per-process CSRF token and the `Origin`/`Referer` must match the address the browser used (works through SSH tunnels). With `FLOWNT_BRIDGE_ADMIN_PASSWORD` a login is required. Stored tokens, access codes and passwords are never rendered back; empty secret fields keep the stored value. |
| `GET /api/version` | Anyone; CORS only for allowed origins. Returns `{ version, command_auth: "bearer" }`. |
| `GET /healthz` | This computer; others with the admin password as Bearer token. |
| `GET /diagnostics.zip` | This computer only, same-origin, behind the setup-UI login. |
| `POST /printer/command` | Allowed origin **and** `Authorization: Bearer <Flownt bridge token of that printer>`. Without `Origin` (scripts) only from this computer. |
| `POST /dymo/print` | Allowed origin from a browser on this computer, or `Authorization: Bearer <token of any printer on this bridge>`. |
| `GET /camera/stream` | `Authorization: Bearer <printer token>`; allowed origin for browsers. |

Allowed origins: `https://flownt.app`, `https://www.flownt.app`, `capacitor://localhost`,
`https://localhost`, `http://localhost:<port>` / `http://127.0.0.1:<port>` (development), plus
`FLOWNT_ALLOWED_ORIGINS` and the addresses saved under **Settings → Additional Flownt addresses**.
Requests whose `Host` is a public DNS name not listed in `FLOWNT_BRIDGE_ALLOWED_HOSTS` are refused
(DNS-rebinding protection).

A reverse proxy or tunnel on the same machine (cloudflared, nginx) makes every forwarded
request look like it comes from this computer. Forward only `/camera/` through it (as in
[CAMERA.md](CAMERA.md)), never the whole bridge.

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
| AMS humidity | Humidity level (1–5, 5=dry) + real relative humidity % (from `ams.humidity_raw`) + temperature per AMS unit |
| Events | Last 30 events, color-coded: ✓ green (success) · ℹ gray (info) · ⚠ orange (warning) |

The page auto-refreshes every 8 seconds.

**Events logged automatically:**
- `✓ Verbindung zu Flownt hergestellt` — on startup
- `✓ Drucker verbunden: <IP>` — when MQTT connects
- `ℹ Druck gestartet: <filename>` — when a print begins
- `✓ Druckdatei geladen: <filename> (N Slot(s))` — when FTPS file download succeeds
- `⚠ Druckdatei nicht via FTPS gefunden` — when all FTPS paths fail
- `✓ Drucklog erstellt: <filename>` — after job_complete lands in Flownt

**JSON API:** `http://localhost:7432/api/state` — returns the full printer snapshot + event log as JSON
(behind the admin login when `FLOWNT_BRIDGE_ADMIN_PASSWORD` is set).

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
npm test               # all tests (tsx --test tests/*.test.ts)
npm run typecheck
npm run package        # all platforms (on Apple Silicon x64 targets need Rosetta 2)
npm run package:mac    # macOS arm64 only (faster)
```

Binaries are written to `dist/`.

### Versioning and releases

`package.json` `"version"` is the only place to bump: `npm run build` inlines it into the
bundle (`src/version.ts` reads `package.json` when run from source). It is shown in the UI
footer, at `GET /api/version` and `GET /healthz`, and reported to Flownt.

Release: bump the version, commit, then push a matching tag (`git tag v0.11.0 && git push --tags`).
`.github/workflows/release.yml` runs tests, builds all five binaries with `npm run package`,
writes `SHA256SUMS` and attaches everything to the GitHub release. `ci.yml` runs type check,
tests and build on pushes to `main`/`develop` and on pull requests.

The installers download `SHA256SUMS` from the same release and refuse to install a binary
that does not match. `FLOWNT_VERSION=v0.11.0` pins a release; `FLOWNT_SKIP_CHECKSUM=1` skips
the check for old releases that were published without `SHA256SUMS`:

```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh | FLOWNT_SKIP_CHECKSUM=1 bash
```
