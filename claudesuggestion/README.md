# 🕐 Pebble × Claude Code Bridge

Parse Claude Code's verbose stream output into compact, watch-friendly events.

Built for Pebble smartwatches but works with any small-screen display.

```
┌─────────────────┐      ┌──────────┐      ┌──────────┐
│   Claude Code    │─────▶│  Bridge  │─────▶│  Pebble  │
│  stream-json     │ JSON │  Server  │  WS  │  Watch   │
│  (verbose)       │      │ :8077    │      │          │
└─────────────────┘      └──────────┘      └──────────┘
```

## What it does

Claude Code outputs **thousands** of verbose JSON events (streaming deltas, partial tokens, tool inputs character-by-character). This bridge:

1. **Parses** the NDJSON stream from `--output-format stream-json`
2. **Filters** down to only meaningful events
3. **Compacts** tool uses into one-liners (`$ npm test`, `✎ edit auth.ts`, `✓ 47 tests passed`)
4. **Serves** them via WebSocket + REST API

The result is a clean feed that fits on a watch screen:

```
● Claude Code (7 tools)
› run tests
$ npm test
✓ 47 tests passed
› fix the auth bug
◎ read auth.ts
✎ edit auth.ts
✓ file edited
$ npm test -- auth
✓ 12 tests passed
◆ Auth bug fixed.
› ship it
$ git add && git commit && git push
✓ pushed to main
■ Done (6 turns, $0.034)
```

## Quick Start

```bash
# Clone and run (zero dependencies!)
cd pebble-claude-bridge

# 1. Demo mode (mock events, no Claude Code needed)
node server.js

# 2. Open the Pebble simulator
# → http://localhost:8077

# 3. Live mode (real Claude Code)
node server.js --live
# Then POST prompts:
curl -X POST localhost:8077/api/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "run tests"}'
```

## Three Modes

### 🟡 Mock (default)
```bash
node server.js
```
Plays a demo session to test your Pebble app. No Claude Code needed.

### 🟢 Live
```bash
node server.js --live
```
Spawns real Claude Code sessions via `claude -p`. Send prompts via WebSocket or REST API.

### 🔵 Watch Logs
```bash
node server.js --watch-logs
```
Monitors `~/.claude/projects/` for changes. Use this to watch an **existing** interactive Claude Code session (read-only).

## API

### WebSocket: `ws://localhost:8077/ws`
Real-time events. Each message is a JSON object:
```json
{
  "type": "tool_use",
  "icon": "$",
  "label": "npm test",
  "detail": null,
  "color": "yellow",
  "timestamp": 1706000000000
}
```

Send prompts back:
```json
{ "type": "prompt", "text": "run tests" }
```

### REST

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/events` | GET | Last 20 events |
| `GET /api/events?count=50` | GET | Last N events |
| `GET /api/status` | GET | Session status |
| `POST /api/prompt` | POST | Send prompt `{"text":"..."}` |
| `GET /` | GET | Pebble watch simulator |

### Event Types

| type | icon | color | Meaning |
|---|---|---|---|
| `init` | ● | green | Session started |
| `user` | › | white | User prompt |
| `assistant` | ◆ | cyan | Claude's summary text |
| `tool_use` | $ ✎ ◎ ⌕ ☰ ⚙ | yellow | Tool invocation (compacted) |
| `tool_result` | ✓ or ✗ | green/red | Tool result (summarized) |
| `result` | ■ | green/red | Session ended |
| `error` | ✗ | red | Error |

## Bash Alternative (no server)

For quick terminal use without the full server:

```bash
# Pipe Claude Code directly through the filter
claude -p "run tests" --output-format stream-json --verbose \
  | bash claude-watch.sh

# Or with jq for just text:
claude -p "run tests" --output-format stream-json --verbose \
  | jq -j 'select(.type == "stream_event") | .event.delta.text? // empty'
```

## Architecture for Pebble

```
Mac (Tailscale)                    Android (Tailscale)
┌───────────────────┐              ┌─────────────────────┐
│ Claude Code       │              │ Termux / Companion   │
│    ↓ stream-json  │              │    ↓                 │
│ Bridge Server     │───websocket──│ PebbleKit JS         │
│  :8077            │    via       │    ↓                 │
│                   │  Tailscale   │ Pebble Watch         │
└───────────────────┘              └─────────────────────┘
```

On your Mac:
```bash
node server.js --live --port 8077
```

In your Pebble app's PebbleKit JS:
```javascript
var ws = new WebSocket('ws://YOUR_MAC_TAILSCALE_IP:8077/ws');
ws.onmessage = function(e) {
  var evt = JSON.parse(e.data);
  // Send to Pebble watch face
  Pebble.sendAppMessage({
    'EVENT_TYPE': evt.type,
    'EVENT_ICON': evt.icon,
    'EVENT_LABEL': evt.label.substring(0, 64),
    'EVENT_COLOR': evt.color
  });
};
```

## Options

```
--port N          Port (default: 8077)
--live            Real Claude Code mode
--watch-logs      Watch ~/.claude/ logs
--claude-bin PATH Path to claude binary (default: "claude")
```

## Files

```
├── server.js        # WebSocket/REST server (zero deps)
├── parser.js        # Stream-JSON → watch events parser
├── pebble-sim.html  # Beautiful Pebble watch simulator
├── claude-watch.sh  # Standalone bash/jq filter
├── package.json
└── README.md
```

Zero npm dependencies. Just Node.js.
