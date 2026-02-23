#!/bin/bash
# CodeWear Bridge — one-liner install
# Usage: curl -sL https://raw.githubusercontent.com/jacquesdupontd/VibeWatch/codex/glitch/bridge/install.sh | bash

INSTALL_DIR="$HOME/.codewear-bridge"
REPO="https://raw.githubusercontent.com/jacquesdupontd/VibeWatch/codex/glitch/bridge"

echo ""
echo "==============================="
echo "  CodeWear Bridge Install"
echo "==============================="
echo ""

# Check Node.js
echo "[1/6] Checking Node.js..."
if ! command -v node &>/dev/null; then
    echo "  FAIL: Node.js not found!"
    echo "  Run: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    exit 1
fi
echo "  OK: $(node --version)"

# Check Tailscale
echo "[2/6] Checking Tailscale..."
if ! command -v tailscale &>/dev/null; then
    echo "  WARN: Tailscale not found. Funnel won't work."
    echo "  Run: curl -fsSL https://tailscale.com/install.sh | sh"
    HAS_TAILSCALE=0
else
    echo "  OK: $(tailscale version 2>/dev/null | head -1)"
    HAS_TAILSCALE=1
fi

# Create dir + download
echo "[3/6] Downloading bridge..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR" || { echo "  FAIL: cannot cd to $INSTALL_DIR"; exit 1; }

curl -fSL "$REPO/server.js" -o server.js || { echo "  FAIL: cannot download server.js"; exit 1; }
echo "  OK: server.js"
curl -fSL "$REPO/parse-jsonl.js" -o parse-jsonl.js || { echo "  FAIL: cannot download parse-jsonl.js"; exit 1; }
echo "  OK: parse-jsonl.js"

# Install ws dependency
echo "[4/6] Installing dependencies..."
if [ ! -f package.json ]; then
    npm init -y 2>&1 | sed 's/^/  /'
fi
npm install ws 2>&1 | sed 's/^/  /'
if [ ! -d node_modules/ws ]; then
    echo "  FAIL: ws module not installed!"
    exit 1
fi
echo "  OK: ws installed"

# Quick sanity test
echo "[5/6] Testing bridge..."
timeout 3 node -e "require('./server.js')" &>/dev/null &
TEST_PID=$!
sleep 2
if curl -s --max-time 2 http://localhost:8080 2>&1 | grep -q "Upgrade"; then
    echo "  OK: bridge responds on :8080"
else
    echo "  WARN: bridge did not respond (port may be in use)"
fi
kill $TEST_PID 2>/dev/null
wait $TEST_PID 2>/dev/null

# Tailscale Funnel
echo "[6/6] Setting up Tailscale Funnel..."
if [ "$HAS_TAILSCALE" = "1" ]; then
    tailscale funnel --bg 8080 2>&1 | sed 's/^/  /'
    if [ $? -eq 0 ]; then
        echo "  OK: Funnel active"
    else
        echo "  WARN: Funnel failed. Enable it at: https://login.tailscale.com/admin/machines"
    fi
else
    echo "  SKIP: no Tailscale"
fi

# Systemd service
echo ""
echo "Setting up systemd service..."
NODE_PATH="$(which node)"
sudo tee /etc/systemd/system/codewear-bridge.service >/dev/null <<SERVICEEOF
[Unit]
Description=CodeWear Bridge
After=network.target tailscaled.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH $INSTALL_DIR/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICEEOF

if [ $? -eq 0 ]; then
    sudo systemctl daemon-reload
    sudo systemctl enable codewear-bridge 2>&1 | sed 's/^/  /'
    sudo systemctl start codewear-bridge 2>&1 | sed 's/^/  /'
    sleep 1
    if sudo systemctl is-active codewear-bridge &>/dev/null; then
        echo "  OK: service running!"
    else
        echo "  FAIL: service not running. Check: sudo journalctl -u codewear-bridge -n 20"
    fi
else
    echo "  FAIL: could not create service (need sudo?)"
fi

echo ""
echo "==============================="
echo "  Install complete!"
echo "==============================="
HOSTNAME=$(hostname)
echo ""
echo "  Bridge: $INSTALL_DIR"
echo "  Service: sudo systemctl status codewear-bridge"
echo "  Logs: sudo journalctl -u codewear-bridge -f"
echo ""
echo "  On your watch, type: $HOSTNAME"
echo "  Connects to: wss://$HOSTNAME.taildd7ed4.ts.net"
echo ""
