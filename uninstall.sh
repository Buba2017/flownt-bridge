#!/bin/bash
# Flownt Bridge Deinstallation
set -e

SERVICE="flownt-bridge"
INSTALL_DIR="/opt/flownt-bridge"

if [ "$EUID" -ne 0 ]; then
  echo "Bitte mit sudo ausführen:"
  echo "  curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/uninstall.sh | sudo bash"
  exit 1
fi

echo "Stoppe und entferne Flownt Bridge..."

systemctl stop $SERVICE 2>/dev/null || true
systemctl disable $SERVICE 2>/dev/null || true
rm -f /etc/systemd/system/$SERVICE.service
systemctl daemon-reload

rm -rf "$INSTALL_DIR"

echo "Flownt Bridge entfernt."
echo "Die Konfiguration (.flownt-bridge im Home-Verzeichnis des Dienst-Benutzers) wurde beibehalten."
