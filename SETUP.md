# VibeCoder Setup Guide

Complete setup from A to Z.

## What You Need

| Device | Requirements |
|--------|-------------|
| **Mac** | macOS, Node.js, Claude Code CLI |
| **iPhone** | Tailscale app, Pebble app |
| **Pebble** | Any Pebble watch (or emulator) |

---

## Step 1: Mac Setup

### 1.1 Install Dependencies

```bash
# Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js
brew install node

# Tailscale
brew install tailscale

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

### 1.2 Clone VibeCoder

```bash
cd ~
git clone https://github.com/jacquesdupontd/vibecoder.git
cd vibecoder
```

### 1.3 Configure Claude Hooks

Create or edit `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "command": "curl -s -X POST http://localhost:8081/event -H 'Content-Type: application/json' -d \"$(cat)\"" }],
    "PreToolUse": [{ "command": "curl -s -X POST http://localhost:8081/event -H 'Content-Type: application/json' -d \"$(cat)\"" }],
    "PostToolUse": [{ "command": "curl -s -X POST http://localhost:8081/event -H 'Content-Type: application/json' -d \"$(cat)\"" }],
    "Stop": [{ "command": "curl -s -X POST http://localhost:8081/event -H 'Content-Type: application/json' -d \"$(cat)\"" }]
  }
}
```

### 1.4 Start the Bridge

```bash
cd ~/vibecoder/bridge
npm install ws
node hooks-bridge.js
```

You should see:
```
VibeCoder Hooks Bridge WS:8080 HTTP:8081
HTTP hook receiver on :8081
```

**Tip:** Run in tmux to keep it running:
```bash
tmux new -s bridge "cd ~/vibecoder/bridge && node hooks-bridge.js"
```

### 1.5 Setup Tailscale

```bash
# Start Tailscale
sudo tailscale up

# Note your Mac's hostname (shown in Tailscale admin or use):
tailscale status
```

Your Mac's hostname is usually something like `macbook-pro`, `imac`, etc.

---

## Step 2: iPhone Setup

### 2.1 Install Apps

1. **Tailscale** - Download from App Store
   - Login with same account as Mac
   - Both devices should be on same tailnet

2. **Pebble** - Download from App Store (or Rebble)
   - Pair with your Pebble watch

### 2.2 Test Tailscale Connection

From iPhone, you should be able to ping your Mac:
- Open any browser
- Go to `http://macbook-pro:8081/status` (use your Mac's hostname)
- You should see: `{"sessions":0,"activeSession":null,...}`

---

## Step 3: Install WatchApp

### Option A: Build from Source

```bash
# On Mac
cd ~/vibecoder/watchapp
pebble build
pebble install --phone <PHONE_IP>
```

### Option B: Install .pbw File

1. Build: `pebble build`
2. Find: `watchapp/build/watchapp.pbw`
3. Transfer to iPhone (AirDrop, iCloud, etc.)
4. Open with Pebble app

---

## Step 4: Configure WatchApp

1. Open **Pebble** app on iPhone
2. Go to **My Pebble** → **Apps**
3. Find **VibeCoder** → tap **Settings**
4. Enter your Mac's hostname (e.g., `macbook-pro`)
5. Tap **Save**

---

## Verify Setup

1. **Bridge running** on Mac (`node hooks-bridge.js`)
2. **Tailscale connected** on both devices
3. **WatchApp installed** and configured

Open the watch app - you should see:
```
> VibeCoder
No active session
---
^ Create new
o Refresh
v Join session
```

Press **UP** to create a new session, or start Claude manually:
```bash
cd ~/PebbleVibeProjects
mkdir test && cd test
claude
```

Your watch should show the Claude activity!

---

## Troubleshooting

### "Connection failed"
- Check bridge is running: `curl http://localhost:8081/status`
- Check Tailscale: `tailscale status`
- Verify hostname in app settings

### "No sessions"
- Make sure Claude hooks are configured
- Start a Claude session manually to test

### Watch not receiving updates
- Check WebSocket: bridge should log "Watch connected"
- Restart the Pebble app on iPhone

---

## Directory Structure

```
~/
├── vibecoder/              # This repo
│   ├── bridge/             # Node.js bridge
│   ├── watchapp/           # Pebble WatchApp
│   └── vibeface/           # VibeFace watchface
│
├── PebbleVibeProjects/     # Created automatically
│   ├── NewProject/         # First project from watch
│   ├── NewProject2/        # Second project, etc.
│   └── pebble/             # Your custom projects
│
└── .claude/
    └── settings.json       # Claude hooks config
```

---

## Quick Reference

| Command | What it does |
|---------|-------------|
| `node hooks-bridge.js` | Start the bridge |
| `pebble build` | Build the watchapp |
| `pebble install --emulator basalt` | Test in emulator |
| `tailscale status` | Check Tailscale |
| `curl http://localhost:8081/status` | Check bridge status |
| `curl http://localhost:8081/tmux/list` | List tmux sessions |
