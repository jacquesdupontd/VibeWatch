---
description: How to launch VibeCoder (Bridge + WatchApp Emulator)
---
# Launching VibeCoder

**CRITICAL**: Always use this exact sequence. Do NOT modify individual commands.

## Full Restart Sequence

// turbo-all
```bash
# 1. Kill everything and restart bridge
pkill -9 -f "node server.js" || true && pebble kill || true && sleep 2 && node bridge/server.js > /tmp/bridge-jsonl.log 2>&1 &

# 2. Build and install watchapp
cd watchapp && pebble build && pebble install --emulator basalt
```

## Verify Bridge is Running
```bash
tail -f /tmp/bridge-jsonl.log
```

## If Emulator Crashes
```bash
# Clean build artifacts first
cd watchapp && pebble clean && pebble build && pebble install --emulator basalt
```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Black screen after join | Bridge not sending data | Check `/tmp/bridge-jsonl.log` for errors, restart bridge |
| Emulator stuck on "Pebble" | Zombie qemu process | `pkill -9 qemu && pebble kill`, then restart |
| "Connection refused" | Emulator not running | Run full restart sequence |
| App crashes on load | Corrupted build | `pebble clean` then rebuild |
