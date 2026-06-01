#!/bin/bash
# Flownt Bridge Installer — Raspberry Pi / Debian Linux
# Verwendung: bash install.sh
set -e

INSTALL_DIR="/opt/flownt-bridge"
SERVICE="flownt-bridge"
PORT=7432
BUNDLE="$(cd "$(dirname "$0")" && pwd)/dist/bundle.cjs"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BOLD}=== Flownt Bridge Installer ===${NC}"
echo ""

# Root-Check
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Bitte mit sudo ausführen: sudo bash install.sh${NC}"
  exit 1
fi

# Bundle prüfen
if [ ! -f "$BUNDLE" ]; then
  echo -e "${RED}dist/bundle.cjs nicht gefunden. Bitte zuerst 'npm run build' ausführen.${NC}"
  exit 1
fi

# Node.js installieren
if ! command -v node &>/dev/null || [[ $(node -v 2>/dev/null | sed 's/v//;s/\..*//') -lt 18 ]]; then
  echo -e "${YELLOW}Node.js wird installiert...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo -e "${GREEN}Node.js $(node -v) installiert${NC}"
else
  echo -e "${GREEN}Node.js $(node -v) bereits vorhanden${NC}"
fi

# Install-Verzeichnis einrichten
echo "Installiere Bridge nach $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$BUNDLE" "$INSTALL_DIR/bundle.cjs"
chmod 644 "$INSTALL_DIR/bundle.cjs"

# Bestimme den Nutzer der den Service ausführen soll
# (erster nicht-root User mit Home-Verzeichnis, fallback: pi)
SERVICE_USER=$(getent passwd | awk -F: '$3 >= 1000 && $3 < 65534 && $6 ~ /^\/home/ {print $1; exit}')
SERVICE_USER="${SERVICE_USER:-pi}"
echo "Service läuft als Nutzer: $SERVICE_USER"

# Systemd Service anlegen
cat > /etc/systemd/system/$SERVICE.service << EOF
[Unit]
Description=Flownt Bridge — 3D-Drucker Monitoring
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/bundle.cjs
Restart=always
RestartSec=15
StartLimitIntervalSec=120
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=flownt-bridge
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Service aktivieren und starten
systemctl daemon-reload
systemctl enable $SERVICE
systemctl restart $SERVICE

# Kurz warten und Status prüfen
sleep 2
if systemctl is-active --quiet $SERVICE; then
  LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo ""
  echo -e "${GREEN}${BOLD}✓ Flownt Bridge läuft!${NC}"
  echo ""
  echo -e "  Web-Setup:  ${BOLD}http://${LOCAL_IP}:${PORT}${NC}"
  echo -e "  Logs:       ${BOLD}journalctl -fu $SERVICE${NC}"
  echo -e "  Stop:       ${BOLD}sudo systemctl stop $SERVICE${NC}"
  echo ""
else
  echo -e "${RED}Service konnte nicht gestartet werden.${NC}"
  echo "Log: journalctl -u $SERVICE --no-pager -n 20"
  journalctl -u $SERVICE --no-pager -n 20
  exit 1
fi
