# **VibeCoder**

### 2016 meets 2026. Voice-control AI from a smartwatch.

---

A Pebble Time on your wrist. Claude Code on your Mac. Your voice in between.

**VibeCoder** turns a $30 smartwatch from 2015 into a wearable AI terminal. Dictate commands from your wrist, watch Claude Code write software in real time, and deploy it -- all without touching a keyboard.

---

## What Is This

VibeCoder is a complete system for voice-controlling [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from a Pebble smartwatch. You speak into the watch. Google Speech-to-Text transcribes it. A Node.js bridge on your Mac feeds it to Claude Code. Claude writes code, edits files, runs commands. The watch shows you what's happening in real time -- thinking status, tool calls, diffs, summaries -- on a 144x168 pixel screen.

It ships with two Pebble apps:

- **PebbleCode** (watchapp) -- the AI command terminal. CLEAN protocol status bar, streaming output, dictation, session management. ~1,800 lines of C.
- **VibeFace** -- the chaos watch face. Your daily driver that doubles as a statement piece.

---

## VibeFace -- The Chaos Watch Face

VibeFace is a generative watch face that never repeats. Every minute of every hour produces a unique visual state.

**60 chaos levels.** The minute of the hour controls everything. Minute 0 is clean. Minute 59 is unhinged. The chaos level (minute / 10) and chaos intensity (minute % 10) drive a layered system of visual effects:

- **Level 0-1** -- Clean time display, green terminal aesthetic, typing cursor
- **Level 2-3** -- Random taglines, color shifts, font swaps, cursor morphing
- **Level 4-5** -- Full glitch mode. Text shaking, scanlines, inverted colors, code snippets flashing across the screen, meta-references to its own source code

**Cursor morphing.** The cursor is alive. It changes shape (square, wide, tall, circle), size, color, and position based on chaos level. At high chaos, it drifts off on its own.

**Context-aware words.** Morning shows "coffee", "wake up", "begin". Work hours show "focus", "build", "ship it". Evenings show "relax", "chill", "unwind". Weekends show "freedom", "party", "lazy".

**Meta mode.** At high chaos, VibeFace displays fragments of its own C source code on screen. `s_chaos_level`, `GColorMagenta`, `rand() % 10`, `layer_mark_dirty` -- the watch face showing you how it works, while it works.

### Easter Eggs

| Time | Trigger | Effect |
|-------|---------|--------|
| 00:00 | Midnight | "new loop" -- reset, fresh start |
| 04:20 | 4:20 | Full green mode |
| 11:11 | Make a wish | Special display |
| 13:37 | LEET | Elite hacker mode |

### The Intro Sequence

On launch, VibeFace plays a terminal-style typing animation:

```
> I'm Claude.
> I write code.
> From this
> Pebble.
```

"Pebble." hits the screen, then glitches -- random colors, random fonts, shaking -- before settling into the normal watch face cycle. Green terminal style. `GColorMalachite`. The backlight holds for a full minute so you don't miss it.

---

## Architecture

```
+------------------+        WebSocket        +-------------------+
|                  |       (port 8080)       |                   |
|   Mac            | <--------------------> |   Android Phone   |
|   bridge/        |                         |   pkjs/index.js   |
|   server.js      |                         |   (PebbleKit JS)  |
|                  |                         |                   |
|   Parses Claude  |                         |   Relays messages |
|   Code JSONL     |                         |   over BLE        |
|   transcripts    |                         |                   |
+------------------+                         +-------------------+
        |                                             |
        | tmux / Claude Code CLI                      | BLE AppMessage
        v                                             v
+------------------+                         +-------------------+
|                  |                         |                   |
|   Claude Code    |                         |   Pebble Watch    |
|   (AI agent)     |                         |   watchapp.c      |
|                  |                         |   vibeface.c      |
+------------------+                         +-------------------+
```

**Data flow:**

```
You speak into watch
  -> Google Speech-to-Text (on Android)
  -> PebbleKit JS relay
  -> WebSocket to Mac bridge
  -> Claude Code executes your command
  -> Bridge parses JSONL transcript in real time
  -> CLEAN protocol packs status into pipe-delimited string
  -> WebSocket to phone
  -> BLE AppMessage to watch
  -> 144x168 pixels of live AI output on your wrist
```

---

## How It Works

1. **Long-press SELECT** on the Pebble to start dictation
2. Google Speech-to-Text on Android transcribes your voice
3. The transcribed text is sent via BLE to your phone, then via WebSocket to the Mac bridge
4. The bridge feeds your command to Claude Code running in a tmux session
5. Claude Code does its thing -- edits files, runs tools, writes code
6. The bridge continuously parses Claude's JSONL output and extracts structured data
7. A **CLEAN protocol** message is sent back: `CLEAN:userCmd|summary|status|lastTool|suggestion|activeTask|diff`
8. The watch renders it all in real time: what you asked, what Claude is doing, what tools it's using, and a summary of the output

You can literally say "add a button to the settings page" into your watch and watch Claude Code build it.

---

## The CLEAN Protocol

A compact pipe-delimited format designed for 144 pixels of width:

```
CLEAN:userCmd|claudeSummary|status|lastTool|suggestion|activeTask|diff
```

Each field is truncated and hyphenated to fit the Pebble screen. The watch app renders each field in its own zone with marquee scrolling for overflow. Status shows thinking state, active tool calls, and task progress.

---

## Built With

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** -- the AI that writes the code (and helped write itself)
- **[Pebble SDK](https://developer.rebble.io/)** -- C SDK for Pebble smartwatch development
- **Node.js** -- bridge server with WebSocket + JSONL parsing
- **WebSocket (ws)** -- real-time communication between Mac and phone
- **PebbleKit JS** -- JavaScript runtime on the phone for BLE relay
- **Google Speech-to-Text** -- voice recognition via Android
- **tmux** -- session management for Claude Code processes

---

## Coming Soon

**Core Time 2 support.** [Core Devices](https://www.coredevices.io/) -- the Pebble reboot led by original creator Eric Migicovsky -- is bringing new hardware in 2025/2026. VibeCoder is being built with forward compatibility in mind. When Core Time 2 ships, this will be ready.

VibeCoder is one of the first apps being developed for the revived Pebble ecosystem. Old hardware, new AI, new possibilities.

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/your-repo/vibecoder.git
cd vibecoder

# 2. Install bridge dependencies
cd bridge && npm install

# 3. Build the watch apps (requires Pebble SDK)
cd ../watchapp && pebble build
cd ../vibeface && pebble build

# 4. Install to your watch (phone IP)
cd ../watchapp && pebble install --phone 192.168.1.49
cd ../vibeface && pebble install --phone 192.168.1.49

# 5. Start the bridge
cd ../bridge && node server.js
```

---

## Project Structure

```
vibecoder-CODEX2/
  bridge/
    server.js          # Mac-side Node.js bridge
    parse-jsonl.js     # Claude Code JSONL transcript parser
  watchapp/
    src/c/watchapp.c   # PebbleCode - AI command terminal (~1,800 LOC)
    src/pkjs/index.js  # PebbleKit JS relay on phone
  vibeface/
    src/c/vibeface.c   # VibeFace - chaos watch face
```

---

<p align="center">
  <img src="https://img.shields.io/badge/Made%20with-Claude%20Code-blueviolet?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyczQuNDggMTAgMTAgMTAgMTAtNC40OCAxMC0xMFMxNy41MiAyIDEyIDJ6IiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==" alt="Made with Claude Code" />
  <img src="https://img.shields.io/badge/Platform-Pebble-orange?style=for-the-badge" alt="Pebble" />
  <img src="https://img.shields.io/badge/Watch-Core%20Time%202%20Ready-green?style=for-the-badge" alt="Core Time 2 Ready" />
</p>

<p align="center">
  <i>The AI is on your wrist. The future is already retro.</i>
</p>
