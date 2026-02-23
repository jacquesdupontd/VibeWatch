#!/bin/bash
# CodeWear Bridge — one-liner install
# Usage: curl -sL https://raw.githubusercontent.com/jacquesdupontd/VibeWatch/codex/glitch/bridge/install.sh | bash

set -e

INSTALL_DIR="$HOME/.codewear-bridge"
REPO="https://raw.githubusercontent.com/jacquesdupontd/VibeWatch/codex/glitch/bridge"

echo "=== CodeWear Bridge Install ==="

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js not found. Install it first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    exit 1
fi

# Check Tailscale
if ! command -v tailscale &>/dev/null; then
    echo "WARNING: Tailscale not found. Funnel won't work without it."
    echo "  curl -fsSL https://tailscale.com/install.sh | sh"
fi

# Create dir
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Download bridge files
echo "Downloading bridge..."
curl -sL "$REPO/server.js" -o server.js
curl -sL "$REPO/parse-jsonl.js" -o parse-jsonl.js

# Install ws dependency
echo "Installing dependencies..."
npm init -y --silent >/dev/null 2>&1
npm install ws --silent >/dev/null 2>&1

echo "Bridge installed in $INSTALL_DIR"

# Enable Tailscale Funnel
if command -v tailscale &>/dev/null; then
    echo ""
    echo "Activating Tailscale Funnel on port 8080..."
    echo "(If this fails, enable Funnel in admin: https://login.tailscale.com/admin/machines)"
    tailscale funnel --bg 8080 2>/dev/null && echo "Funnel active!" || echo "Funnel activation failed — enable it in Tailscale admin first"
fi

# Create systemd service
if command -v systemctl &>/dev/null; then
    echo ""
    echo "Creating systemd service..."
    sudo tee /etc/systemd/system/codewear-bridge.service >/dev/null <<EOF
[Unit]
Description=CodeWear Bridge
After=network.target tailscaled.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable codewear-bridge
    sudo systemctl start codewear-bridge
    echo "Bridge running as systemd service!"
    echo "  Status:  sudo systemctl status codewear-bridge"
    echo "  Logs:    sudo journalctl -u codewear-bridge -f"
else
    echo ""
    echo "To run manually:"
    echo "  cd $INSTALL_DIR && node server.js"
    echo ""
    echo "To run in background:"
    echo "  nohup node server.js > /tmp/bridge.log 2>&1 &"
fi

echo ""
echo "=== Done! ==="
HOSTNAME=$(hostname)
echo "Watch will auto-connect to: wss://$HOSTNAME.taildd7ed4.ts.net"
echo "Just type '$HOSTNAME' in Bridge settings on your watch."
