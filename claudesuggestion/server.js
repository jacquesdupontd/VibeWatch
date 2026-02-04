#!/usr/bin/env node

/**
 * Pebble ↔ Claude Code Bridge Server
 *
 * Spawns Claude Code in headless mode (stream-json),
 * parses the output into compact watch-friendly events,
 * and serves them over WebSocket + REST API.
 *
 * Usage:
 *   node server.js                     # Start with mock data for testing
 *   node server.js --live              # Start with real Claude Code
 *   node server.js --port 8077         # Custom port
 *   node server.js --watch-logs        # Watch ~/.claude/ logs instead
 *
 * API:
 *   WS  ws://localhost:8077/ws         # Real-time events
 *   GET /api/events                    # Recent events (last 20)
 *   GET /api/events?count=50           # Recent events (custom count)
 *   GET /api/status                    # Session status
 *   POST /api/prompt  { text: "..." }  # Send prompt (live mode)
 *   GET /                              # Pebble watch simulator
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ClaudeStreamParser } = require('./parser');

// ── Config ──────────────────────────────────────────
const args = process.argv.slice(2);
const PORT = parseInt(getArg('--port', '8077'));
const LIVE_MODE = args.includes('--live');
const WATCH_MODE = args.includes('--watch-logs');
const CLAUDE_BIN = getArg('--claude-bin', 'claude');

function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

// ── Parser ──────────────────────────────────────────
const parser = new ClaudeStreamParser();

// ── WebSocket (minimal, no deps) ────────────────────
const crypto = require('crypto');
const wsClients = new Set();

function upgradeToWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC525DA5')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  const client = { socket, alive: true };
  wsClients.add(client);
  console.log(`[ws] client connected (${wsClients.size} total)`);

  // Send recent events for sync
  const recent = parser.getRecentEvents(20);
  for (const evt of recent) {
    wsSend(client, JSON.stringify(evt));
  }

  socket.on('data', (buf) => {
    const frame = decodeWSFrame(buf);
    if (frame === null) return;
    if (frame.opcode === 0x8) {
      // Close frame
      wsClients.delete(client);
      socket.end();
      return;
    }
    if (frame.opcode === 0xA) {
      // Pong
      client.alive = true;
      return;
    }
    if (frame.opcode === 0x1 && frame.payload) {
      // Text message from Pebble (could be a prompt)
      try {
        const msg = JSON.parse(frame.payload);
        if (msg.type === 'prompt' && msg.text) {
          handlePrompt(msg.text);
        }
      } catch (e) { /* ignore */ }
    }
  });

  socket.on('close', () => {
    wsClients.delete(client);
    console.log(`[ws] client disconnected (${wsClients.size} total)`);
  });

  socket.on('error', () => {
    wsClients.delete(client);
  });
}

function wsSend(client, data) {
  try {
    const payload = Buffer.from(data, 'utf8');
    const frame = encodeWSFrame(payload);
    client.socket.write(frame);
  } catch (e) { /* ignore dead sockets */ }
}

function wsBroadcast(data) {
  for (const client of wsClients) {
    wsSend(client, data);
  }
}

function encodeWSFrame(payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // text, fin
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWSFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0F;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7F;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  const data = buf.slice(offset, offset + payloadLen);
  if (mask) {
    for (let i = 0; i < data.length; i++) {
      data[i] ^= mask[i % 4];
    }
  }
  return { opcode, payload: data.toString('utf8') };
}

// Ping/pong keepalive
setInterval(() => {
  for (const client of wsClients) {
    if (!client.alive) {
      wsClients.delete(client);
      client.socket.end();
      return;
    }
    client.alive = false;
    try {
      // Send ping frame
      client.socket.write(Buffer.from([0x89, 0x00]));
    } catch (e) {
      wsClients.delete(client);
    }
  }
}, 30000);

// ── Forward parsed events to WebSocket clients ─────
parser.onEvent((event) => {
  wsBroadcast(JSON.stringify(event));
  // Also log to terminal
  const c = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', white: '\x1b[37m', reset: '\x1b[0m' };
  const color = c[event.color] || c.white;
  console.log(`${color}${event.icon} ${event.label}${event.detail ? ` (${event.detail})` : ''}${c.reset}`);
});

// ── Claude Code Process Management ─────────────────
let claudeProcess = null;
let sessionActive = false;
let lineBuffer = '';

function startClaudeSession(prompt) {
  if (claudeProcess) {
    console.log('[claude] Session already active');
    return;
  }

  parser.reset();
  sessionActive = true;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  console.log(`[claude] Starting: ${CLAUDE_BIN} ${args.join(' ')}`);

  claudeProcess = spawn(CLAUDE_BIN, args, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  claudeProcess.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // Keep incomplete line
    for (const line of lines) {
      if (line.trim()) parser.parseLine(line);
    }
  });

  claudeProcess.stderr.on('data', (chunk) => {
    // Stderr might contain progress info, ignore for now
    const text = chunk.toString().trim();
    if (text) console.log(`[claude:stderr] ${text}`);
  });

  claudeProcess.on('close', (code) => {
    console.log(`[claude] Process exited with code ${code}`);
    claudeProcess = null;
    sessionActive = false;
    // Process remaining buffer
    if (lineBuffer.trim()) {
      parser.parseLine(lineBuffer);
      lineBuffer = '';
    }
  });

  claudeProcess.on('error', (err) => {
    console.error(`[claude] Failed to start: ${err.message}`);
    claudeProcess = null;
    sessionActive = false;
    parser._emit({
      type: 'error',
      icon: '✗',
      label: `Failed: ${err.message}`,
      detail: 'Is claude installed?',
      color: 'red',
    });
  });
}

function handlePrompt(text) {
  if (LIVE_MODE) {
    startClaudeSession(text);
  } else {
    console.log(`[mock] Would send prompt: "${text}"`);
    parser._emit({
      type: 'user',
      icon: '›',
      label: text,
      detail: null,
      color: 'white',
    });
  }
}

// ── Log Watcher Mode ───────────────────────────────
function startLogWatcher() {
  const claudeDir = path.join(process.env.HOME || '~', '.claude', 'projects');
  console.log(`[watcher] Watching ${claudeDir} for changes...`);

  // Find the most recently modified JSONL file
  function findLatestLog() {
    try {
      const files = [];
      function walk(dir, depth = 0) {
        if (depth > 4) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, depth + 1);
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push({ path: full, mtime: fs.statSync(full).mtimeMs });
          }
        }
      }
      walk(claudeDir);
      files.sort((a, b) => b.mtime - a.mtime);
      return files[0]?.path || null;
    } catch (e) {
      return null;
    }
  }

  let currentFile = null;
  let currentSize = 0;

  function checkForUpdates() {
    const latest = findLatestLog();
    if (!latest) return;

    if (latest !== currentFile) {
      currentFile = latest;
      currentSize = 0;
      console.log(`[watcher] Tracking: ${currentFile}`);
    }

    const stat = fs.statSync(currentFile);
    if (stat.size > currentSize) {
      const stream = fs.createReadStream(currentFile, {
        start: currentSize,
        encoding: 'utf8',
      });
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.trim()) parser.parseLine(line);
        }
      });
      currentSize = stat.size;
    }
  }

  setInterval(checkForUpdates, 1000);
}

// ── Mock Mode (for testing) ────────────────────────
function startMockSession() {
  console.log('[mock] Starting demo session...\n');

  const mockEvents = [
    { delay: 500, line: '{"type":"system","subtype":"init","session_id":"mock-001","tools":["Bash","Read","Write","Edit","Grep","Glob","TodoWrite"],"mcp_servers":[]}' },
    { delay: 1200, line: '{"type":"user","message":{"role":"user","content":"run tests"}}' },
    { delay: 2000, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"I\'ll run the test suite for you."},{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"npm test"}}]}}' },
    { delay: 3500, line: '{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"tool_1","content":"\\n> project@1.0.0 test\\n> jest\\n\\nPASS ./auth.test.ts\\nPASS ./api.test.ts\\nPASS ./utils.test.ts\\n\\nTest Suites: 3 passed, 3 total\\nTests:       47 passed, 47 total","is_error":false}]}}' },
    { delay: 4000, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"All 47 tests passed across 3 test suites. Everything looks good!"}]}}' },
    { delay: 5500, line: '{"type":"user","message":{"role":"user","content":"fix the auth bug in src/auth.ts"}}' },
    { delay: 6500, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look at the auth module to find the bug."},{"type":"tool_use","id":"tool_2","name":"Read","input":{"file_path":"src/auth.ts"}}]}}' },
    { delay: 7500, line: '{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"tool_2","content":"// auth.ts content...\\nimport { verify } from \'jsonwebtoken\';\\n// ... 84 lines","is_error":false}]}}' },
    { delay: 8500, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"Found it — the token validation skips expiry check. Fixing now."},{"type":"tool_use","id":"tool_3","name":"Edit","input":{"file_path":"src/auth.ts","old_text":"verify(token, secret)","new_text":"verify(token, secret, { maxAge: \'1h\' })"}}]}}' },
    { delay: 9500, line: '{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"tool_3","content":"File edited successfully","is_error":false}]}}' },
    { delay: 10000, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"Now let me verify the fix with the tests."},{"type":"tool_use","id":"tool_4","name":"Bash","input":{"command":"npm test -- --testPathPattern=auth"}}]}}' },
    { delay: 11500, line: '{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"tool_4","content":"PASS ./auth.test.ts\\n\\nTests: 12 passed, 12 total","is_error":false}]}}' },
    { delay: 12000, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"Auth bug fixed. Added expiry validation to JWT verification."}]}}' },
    { delay: 14000, line: '{"type":"user","message":{"role":"user","content":"ship it"}}' },
    { delay: 15000, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"Committing and deploying."},{"type":"tool_use","id":"tool_5","name":"Bash","input":{"command":"git add -A && git commit -m \\"fix: add JWT expiry validation\\" && git push origin main"}}]}}' },
    { delay: 17000, line: '{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"tool_5","content":"[main abc1234] fix: add JWT expiry validation\\n 1 file changed, 1 insertion(+), 1 deletion(-)\\nTo github.com:user/project.git\\n   def5678..abc1234  main -> main","is_error":false}]}}' },
    { delay: 18000, line: '{"type":"assistant","message":{"content":[{"type":"text","text":"Deployed! The fix is live on main."}]}}' },
    { delay: 18500, line: '{"type":"result","subtype":"success","num_turns":6,"total_cost_usd":0.0342}' },
  ];

  let i = 0;
  function next() {
    if (i >= mockEvents.length) {
      // Loop after a pause
      setTimeout(() => {
        console.log('\n[mock] Restarting demo...\n');
        parser.reset();
        wsBroadcast(JSON.stringify({ type: 'clear' }));
        i = 0;
        next();
      }, 5000);
      return;
    }
    const evt = mockEvents[i];
    const delay = i === 0 ? evt.delay : evt.delay - mockEvents[i - 1].delay;
    setTimeout(() => {
      parser.parseLine(evt.line);
      i++;
      next();
    }, delay);
  }
  next();
}

// ── HTTP Server ────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── API Routes ──
  if (url.pathname === '/api/events') {
    const count = parseInt(url.searchParams.get('count') || '20');
    const events = parser.getRecentEvents(count);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
    return;
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionActive,
      sessionId: parser.sessionId,
      eventCount: parser.events.length,
      wsClients: wsClients.size,
      mode: LIVE_MODE ? 'live' : WATCH_MODE ? 'watch' : 'mock',
    }));
    return;
  }

  if (url.pathname === '/api/prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (text) handlePrompt(text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ── Static Files ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'pebble-sim.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath));
      return;
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    upgradeToWebSocket(req, socket);
  } else {
    socket.destroy();
  }
});

// ── Start ──────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │  🕐 Pebble ↔ Claude Code Bridge          │');
  console.log('  ├──────────────────────────────────────────┤');
  console.log(`  │  Mode:      ${(LIVE_MODE ? 'LIVE' : WATCH_MODE ? 'WATCH' : 'MOCK (demo)').padEnd(28)}│`);
  const httpStr = `http://localhost:${PORT}`;
  const wsStr = `ws://localhost:${PORT}/ws`;
  console.log(`  │  HTTP:      ${httpStr.padEnd(28)}│`);
  console.log(`  │  WebSocket: ${wsStr.padEnd(28)}│`);
  console.log(`  │  API:       /api/events /api/status      │`);
  console.log('  └──────────────────────────────────────────┘');
  console.log('');

  if (LIVE_MODE) {
    console.log('  Send prompts via POST /api/prompt or WS');
    console.log('  Example: curl -X POST localhost:8077/api/prompt -d \'{"text":"run tests"}\'');
  } else if (WATCH_MODE) {
    startLogWatcher();
  } else {
    startMockSession();
  }
  console.log('');
});
