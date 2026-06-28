#!/usr/bin/env bash
# Flownt Bridge — Ein-Befehl-Installer für macOS & Linux
#
#   curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh | bash
#
# Lädt die passende fertige Binary aus den GitHub-Releases (kein Node/Repo nötig),
# löst die macOS-Quarantäne automatisch, richtet Autostart ein (launchd bzw. systemd)
# und startet die Bridge. Erneutes Ausführen aktualisiert auf die neueste Version.
set -euo pipefail

REPO="Buba2017/flownt-bridge"
PORT=7432
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
say() { echo -e "$@"; }

say ""
say "${BOLD}=== Flownt Bridge Installer ===${NC}"
say ""

# 1) OS + Architektur erkennen → Release-Asset
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) say "${RED}Nicht unterstütztes Betriebssystem: $OS${NC}"; exit 1 ;;
esac
case "$ARCH" in
  arm64|aarch64) A="arm64" ;;
  x86_64|amd64)  A="x64"   ;;
  *) say "${RED}Nicht unterstützte Architektur: $ARCH${NC}"; exit 1 ;;
esac
ASSET="flownt-bridge-${PLATFORM}-${A}"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

# Installationsziel: System-Pfad bei Root-Install (Linux → systemd-System-Dienst),
# sonst pro Nutzer. Verhindert, dass der Dienst (als Nicht-Root-User) eine Binary
# unter /root nicht ausführen kann.
if [ "$PLATFORM" = "linux" ] && [ "$(id -u)" = "0" ]; then
  INSTALL_DIR="/opt/flownt-bridge"
else
  INSTALL_DIR="$HOME/.flownt-bridge"
fi
BIN="$INSTALL_DIR/flownt-bridge"

# 2) Binary laden (curl setzt KEINE macOS-Quarantäne → kein Gatekeeper-Block)
say "Lade ${BOLD}${ASSET}${NC} …"
mkdir -p "$INSTALL_DIR"
if ! curl -fSL --progress-bar "$URL" -o "$BIN.tmp"; then
  say "${RED}Download fehlgeschlagen.${NC} Asset '${ASSET}' evtl. (noch) nicht in den Releases:"
  say "  https://github.com/${REPO}/releases/latest"
  rm -f "$BIN.tmp"; exit 1
fi
mv "$BIN.tmp" "$BIN"
chmod +x "$BIN"
# Defensiv: falls doch ein Quarantäne-Flag existiert, entfernen (macOS)
[ "$PLATFORM" = "macos" ] && xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
say "${GREEN}✓ Binary installiert:${NC} $BIN"

# 3) Autostart einrichten + starten
if [ "$PLATFORM" = "macos" ]; then
  PLIST="$HOME/Library/LaunchAgents/app.flownt.bridge.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.flownt.bridge</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$INSTALL_DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_DIR/bridge.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  say "${GREEN}✓ Autostart eingerichtet${NC} (launchd, startet bei Anmeldung)"
  RUN_HINT="launchctl unload $PLIST   # stoppen"
  LOG_HINT="tail -f $INSTALL_DIR/bridge.log"
else
  UNIT="[Unit]
Description=Flownt Bridge — 3D-Drucker Monitoring & Etikettendruck
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN
Restart=always
RestartSec=15
SyslogIdentifier=flownt-bridge
Environment=NODE_ENV=production"
  if [ "$(id -u)" = "0" ]; then
    # Root/Pi → System-Service
    SVC_USER="${SUDO_USER:-$(getent passwd | awk -F: '$3>=1000 && $3<65534 && $6 ~ /^\/home/ {print $1; exit}')}"
    SVC_USER="${SVC_USER:-pi}"
    printf '%s\nUser=%s\n\n[Install]\nWantedBy=multi-user.target\n' "$UNIT" "$SVC_USER" \
      > /etc/systemd/system/flownt-bridge.service
    systemctl daemon-reload
    systemctl enable flownt-bridge
    systemctl restart flownt-bridge   # restart statt enable --now: startet den Dienst auch dann neu, wenn er schon lief (Update-Fall) → neue Binary greift sofort
    say "${GREEN}✓ Autostart eingerichtet${NC} (systemd System-Service als '$SVC_USER')"
    RUN_HINT="sudo systemctl stop flownt-bridge"
    LOG_HINT="journalctl -fu flownt-bridge"
  else
    # Nicht-root → User-Service
    mkdir -p "$HOME/.config/systemd/user"
    printf '%s\n\n[Install]\nWantedBy=default.target\n' "$UNIT" \
      > "$HOME/.config/systemd/user/flownt-bridge.service"
    systemctl --user daemon-reload
    systemctl --user enable flownt-bridge
    systemctl --user restart flownt-bridge   # restart statt enable --now: greift auch bei bereits laufendem Dienst (Update-Fall)
    loginctl enable-linger "$USER" 2>/dev/null || true   # auch ohne aktive Anmeldung laufen lassen
    say "${GREEN}✓ Autostart eingerichtet${NC} (systemd User-Service)"
    RUN_HINT="systemctl --user stop flownt-bridge"
    LOG_HINT="journalctl --user -fu flownt-bridge"
  fi
fi

# 4) Adresse ermitteln + Abschluss
sleep 2
if [ "$PLATFORM" = "macos" ]; then
  IP="localhost"
else
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; IP="${IP:-localhost}"
fi
say ""
say "${GREEN}${BOLD}✓ Flownt Bridge läuft!${NC}"
say ""
say "  Web-Oberfläche:  ${BOLD}http://${IP}:${PORT}${NC}"
say "  Dort wählst du, was diese Bridge tun soll (Drucker überwachen / Etiketten drucken)."
say "  Logs:            ${LOG_HINT}"
say "  Stoppen:         ${RUN_HINT}"
say ""
