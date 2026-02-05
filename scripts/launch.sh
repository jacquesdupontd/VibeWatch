#!/bin/bash
# VibeCoder One-Click Launcher

echo "🚀 Killing old processes..."
pkill -9 -f "node bridge/server.js" || true
pebble kill
sleep 2

echo "🌐 Starting Bridge Server..."
node bridge/server.js > /tmp/bridge-jsonl.log 2>&1 &
BRIDGE_PID=$!
echo "Bridge started (PID: $BRIDGE_PID). Logs at /tmp/bridge-jsonl.log"

echo "⌚ Building and Installing WatchApp..."
cd watchapp
pebble build && pebble install --emulator basalt

echo "✅ Done! Bridge and Emulator are running."
