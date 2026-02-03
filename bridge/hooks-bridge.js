const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const url = require('url');
const { exec, spawn } = require('child_process');

const WS_PORT = 8080;
const HTTP_PORT = 8081;
const LINE_W = 23;
const MAX_LINES = 40;

// ===========================================
// TMUX SESSION MANAGEMENT
// ===========================================

// List all tmux sessions
function listTmuxSessions(callback) {
    exec('tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}" 2>/dev/null', (err, stdout) => {
        if (err) {
            callback([]);
            return;
        }
        const sessions = stdout.trim().split('\n').filter(l => l).map(line => {
            const [name, created, attached] = line.split('|');
            return { name, created: parseInt(created), attached: attached === '1' };
        });
        callback(sessions);
    });
}

// Create new tmux session with Claude
function createTmuxSession(sessionName, callback) {
    const name = sessionName || 'vibe-' + Date.now().toString(36);
    // Create detached session running Claude
    exec(`tmux new-session -d -s "${name}" "claude"`, (err) => {
        if (err) {
            console.log('Failed to create tmux session:', err.message);
            callback(null, err.message);
        } else {
            console.log('Created tmux session:', name);
            callback(name, null);
        }
    });
}

// Kill a tmux session
function killTmuxSession(sessionName, callback) {
    exec(`tmux kill-session -t "${sessionName}"`, (err) => {
        callback(!err);
    });
}

// Send keys to tmux session (for voice input simulation)
function sendToTmux(sessionName, text, callback) {
    // Escape special characters for tmux
    const escaped = text.replace(/"/g, '\\"');
    exec(`tmux send-keys -t "${sessionName}" "${escaped}" Enter`, (err) => {
        callback(!err);
    });
}

// Per-session state
const sessions = {}; // session_id -> { lines: [], currentTool, lastActivity, lastTranscriptLine, transcriptPath }

// Which session the watch is viewing (null = auto-follow latest)
let watchedSession = null;

function getSession(id) {
    if (!sessions[id]) {
        sessions[id] = { lines: [], currentTool: null, lastActivity: Date.now(), lastTranscriptLine: 0, transcriptPath: null };
    }
    sessions[id].lastActivity = Date.now();
    return sessions[id];
}

// Check transcript for new assistant text
function checkTranscript(session) {
    if (!session.transcriptPath) {
        // console.log('No transcript path for session');
        return;
    }
    if (!fs.existsSync(session.transcriptPath)) {
        console.log('Transcript not found:', session.transcriptPath);
        return;
    }
    try {
        const allLines = fs.readFileSync(session.transcriptPath, 'utf8').trim().split('\n');
        const startFrom = session.lastTranscriptLine;
        if (allLines.length > startFrom) {
            console.log('Reading transcript lines', startFrom, 'to', allLines.length);
        }
        session.lastTranscriptLine = allLines.length;
        for (let i = startFrom; i < allLines.length; i++) {
            try {
                const entry = JSON.parse(allLines[i]);
                if (entry.type === 'assistant' && entry.message && entry.message.content) {
                    const texts = entry.message.content.filter(c => c.type === 'text');
                    for (const t of texts) {
                        if (!t.text || t.text.trim().length < 3) continue;
                        console.log('Found assistant text:', t.text.substring(0, 50));
                        // Show each sentence/paragraph, trimmed for watch
                        const clean = t.text.replace(/\n+/g, ' ').trim();
                        // Split into sentences, show each
                        const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
                        for (const s of sentences) {
                            const trimmed = s.trim();
                            if (trimmed.length > 2) {
                                addLine(session, 'W', trimmed.substring(0, 80));
                            }
                        }
                    }
                }
            } catch {}
        }
    } catch (e) {
        console.log('Transcript read error:', e.message);
    }
}

// Auto-select: most recently active session
function activeSessionId() {
    if (watchedSession && sessions[watchedSession]) return watchedSession;
    let best = null, bestTime = 0;
    for (const [id, s] of Object.entries(sessions)) {
        if (s.lastActivity > bestTime) { bestTime = s.lastActivity; best = id; }
    }
    return best;
}

function hyphenate(text, width) {
    const words = text.split(' ');
    let line = '';
    const lines = [];
    for (const word of words) {
        if (word.length === 0) continue;
        if (line.length === 0) {
            if (word.length <= width) {
                line = word;
            } else {
                let w = word;
                while (w.length > width) {
                    lines.push(w.substring(0, width - 1) + '-');
                    w = w.substring(width - 1);
                }
                line = w;
            }
        } else if (line.length + 1 + word.length <= width) {
            line += ' ' + word;
        } else {
            lines.push(line);
            if (word.length <= width) {
                line = word;
            } else {
                let w = word;
                while (w.length > width) {
                    lines.push(w.substring(0, width - 1) + '-');
                    w = w.substring(width - 1);
                }
                line = w;
            }
        }
    }
    if (line.length > 0) lines.push(line);
    return lines.join('\n');
}

function addLine(session, color, text) {
    const wrapped = hyphenate(text, LINE_W);
    for (const l of wrapped.split('\n')) {
        if (l.trim()) session.lines.push(color + l);
    }
    while (session.lines.length > MAX_LINES) session.lines.shift();
    broadcastIfActive(session);
}

// Color codes for watch:
// W = White (Claude text)
// Y = Yellow (user prompts)
// C = Cyan (tool calls)
// G = Green (success/done)
// R = Red (errors)
// O = Orange (warnings/permissions)
// L = LightGray (meta info)
// B = Blue (file paths)
// M = Magenta (special)
// P = Pink (assistant thinking)

function broadcastIfActive(session) {
    const activeId = activeSessionId();
    if (!activeId || sessions[activeId] !== session) {
        console.log('Skip broadcast: activeId=', activeId, 'match=', sessions[activeId] === session);
        return;
    }
    console.log('Broadcasting to watch, lines:', session.lines.length);
    broadcastScreen();
}

function shortenPath(p) {
    if (!p) return '';
    return p.replace(/\/Users\/[^/]+\/Documents\/[^/]+\/[^/]+\//g, '')
            .replace(/\/Users\/[^/]+\//g, '~/');
}

function shortenCommand(cmd) {
    if (!cmd) return '';
    cmd = cmd.replace(/\/Users\/[^/]+\/Documents\/[^/]+\/[^/]+\//g, '');
    if (cmd.length > 60) cmd = cmd.substring(0, 57) + '...';
    return cmd;
}

function formatToolStart(name, input) {
    switch (name) {
        case 'Bash': return shortenCommand(input.command || '');
        case 'Read': return shortenPath(input.file_path || '');
        case 'Edit': return shortenPath(input.file_path || '');
        case 'Write': return shortenPath(input.file_path || '');
        case 'Grep': return (input.pattern || '').substring(0, 30);
        case 'Glob': return (input.pattern || '').substring(0, 30);
        case 'WebFetch': return (input.url || '').substring(0, 40);
        case 'WebSearch': return (input.query || '').substring(0, 40);
        case 'Task': return (input.description || '').substring(0, 30);
        default: return name;
    }
}

function formatToolResult(name, response) {
    if (!response) return null;
    // Extract text from structured responses
    let text = '';
    if (typeof response === 'string') {
        text = response;
    } else if (response.stdout) {
        text = response.stdout;
    } else if (response.output) {
        text = response.output;
    } else if (response.content) {
        text = typeof response.content === 'string' ? response.content : '';
    } else {
        text = JSON.stringify(response);
        // Don't show raw JSON objects on the watch
        if (text.startsWith('{') && text.length > 80) return null;
    }
    text = text.replace(/\n/g, ' ').trim();
    if (!text) return null;

    // Only show meaningful results: errors, successes, or very short output
    if (/error|fail|exception|not found|denied/i.test(text)) {
        // Find the most relevant error line
        const parts = text.split(/\s{2,}/).filter(l => /error|fail|exception/i.test(l));
        return (parts[0] || text).substring(0, 50);
    }
    if (/success|passed|created|built|installed|compiled|done/i.test(text)) {
        return text.substring(0, 50);
    }
    // Short results only
    if (text.length < 50) return text;
    return null;
}

function handleEvent(event) {
    const hookName = event.hook_event_name;
    const sessionId = event.session_id || 'unknown';
    const session = getSession(sessionId);
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' });

    // Track transcript path
    if (event.transcript_path && !session.transcriptPath) {
        session.transcriptPath = event.transcript_path;
        // Initialize to current transcript length to skip history
        try {
            const lines = fs.readFileSync(event.transcript_path, 'utf8').trim().split('\n');
            session.lastTranscriptLine = lines.length;
            console.log('Initialized transcript at line', session.lastTranscriptLine);
        } catch {}
    }
    // Check for new assistant text since last read
    checkTranscript(session);

    switch (hookName) {
        case 'SessionStart':
            session.lines = [];
            addLine(session, 'C', '-- Session ' + ts + ' --');
            if (event.model) {
                const model = event.model.replace('claude-', '').split('-202')[0];
                addLine(session, 'L', model);
            }
            // Show short session id for identification
            addLine(session, 'L', 'id:' + sessionId.substring(0, 8));
            break;

        case 'UserPromptSubmit':
            addLine(session, 'Y', '> ' + (event.prompt || '').substring(0, 100));
            break;

        case 'PreToolUse': {
            const name = event.tool_name || '?';
            const detail = formatToolStart(name, event.tool_input || {});
            session.currentTool = name;
            // Color by tool type
            let color = 'C';  // Default cyan for tools
            let icon = '$';
            if (name === 'Read') { icon = 'R'; color = 'B'; }        // Blue for reads
            else if (name === 'Edit') { icon = 'E'; color = 'M'; }   // Magenta for edits
            else if (name === 'Write') { icon = 'W'; color = 'M'; }  // Magenta for writes
            else if (name === 'Bash') { icon = '$'; color = 'C'; }   // Cyan for bash
            else if (name === 'Grep' || name === 'Glob') { icon = '?'; color = 'B'; }
            else if (name === 'Task') { icon = 'T'; color = 'P'; }   // Pink for tasks
            else if (name === 'WebFetch' || name === 'WebSearch') { icon = 'W'; color = 'O'; }
            else icon = name.charAt(0);
            addLine(session, color, '[' + icon + '] ' + detail);
            break;
        }

        case 'PostToolUse': {
            const result = formatToolResult(event.tool_name || '?', event.tool_response);
            if (result) {
                if (/error|fail|exception/i.test(result)) {
                    addLine(session, 'R', '[X] ' + result);
                } else if (/success|ok|created|built|pass/i.test(result)) {
                    addLine(session, 'G', '[OK] ' + result);
                } else {
                    addLine(session, 'L', result);
                }
            }
            session.currentTool = null;
            break;
        }

        case 'PostToolUseFailure':
            addLine(session, 'R', '[FAIL] ' + (event.error || 'error').substring(0, 60));
            session.currentTool = null;
            break;

        case 'Notification': {
            const type = event.notification_type || '';
            if (type === 'permission_prompt') {
                addLine(session, 'O', '[!] Permission needed');
            } else {
                addLine(session, 'W', (event.message || '').substring(0, 80));
            }
            break;
        }

        case 'Stop':
            session.currentTool = null;
            addLine(session, 'G', '-- Done ' + ts + ' --');
            break;

        case 'SessionEnd':
            addLine(session, 'L', '-- Ended --');
            break;
    }
}

// WebSocket for watch
const wss = new WebSocket.Server({ port: WS_PORT });
console.log('VibeCoder Hooks Bridge WS:' + WS_PORT + ' HTTP:' + HTTP_PORT);

let activeWs = null;

function broadcastScreen() {
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
    const id = activeSessionId();
    if (!id) return;
    const session = sessions[id];
    const content = session.lines.join('\n');
    const msg = { type: 'output', content };
    activeWs.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
    console.log('Watch connected');
    activeWs = ws;

    // Send initial state - check if any Claude sessions active
    const activeId = activeSessionId();
    if (activeId) {
        broadcastScreen();
    } else {
        // No active session - send session list for selection UI
        sendSessionList(ws);
    }

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            console.log('FROM WATCH:', JSON.stringify(data));

            // ===========================================
            // TMUX SESSION COMMANDS
            // ===========================================

            if (data.type === 'list_tmux') {
                // Watch requests list of tmux sessions
                sendSessionList(ws);
            }
            else if (data.type === 'create_session') {
                // Watch requests new Claude session
                createTmuxSession(data.name, (name, err) => {
                    if (name) {
                        ws.send(JSON.stringify({
                            type: 'session_created',
                            name,
                            message: 'Session "' + name + '" created. Claude starting...'
                        }));
                        // Broadcast status update
                        setTimeout(() => sendSessionList(ws), 1000);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: err || 'Failed to create session' }));
                    }
                });
            }
            else if (data.type === 'join_session') {
                // Watch wants to attach to a tmux session
                const sessionName = data.name;
                ws.send(JSON.stringify({
                    type: 'session_joined',
                    name: sessionName,
                    message: 'Joined "' + sessionName + '"'
                }));
            }
            else if (data.type === 'send_text') {
                // Send text to a tmux session (for voice input)
                sendToTmux(data.session, data.text, (ok) => {
                    if (ok) {
                        ws.send(JSON.stringify({ type: 'text_sent', session: data.session }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to send text' }));
                    }
                });
            }
            // ===========================================
            // EXISTING KEY HANDLING
            // ===========================================
            else if (data.type === 'key') {
                const ids = Object.keys(sessions).sort((a, b) =>
                    sessions[b].lastActivity - sessions[a].lastActivity);
                if (ids.length <= 1) return;
                const currentIdx = ids.indexOf(watchedSession);
                if (data.content === 'prev') {
                    watchedSession = ids[(currentIdx + 1) % ids.length];
                } else if (data.content === 'next') {
                    watchedSession = ids[(currentIdx - 1 + ids.length) % ids.length];
                } else if (data.content === 'auto') {
                    watchedSession = null;
                }
                broadcastScreen();
            }
            else if (data.type === 'accept') {
                // Handle accept from watch
                console.log('Watch accepted');
            }
        } catch (e) {
            console.log('WS message parse error:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('Watch disconnected');
        if (activeWs === ws) activeWs = null;
    });
});

// Send tmux session list to watch
function sendSessionList(ws) {
    listTmuxSessions((tmuxSessions) => {
        // Also include Claude hook sessions
        const claudeSessions = Object.entries(sessions).map(([id, s]) => ({
            id: id.substring(0, 8),
            type: 'claude',
            lines: s.lines.length,
            lastActivity: s.lastActivity,
            currentTool: s.currentTool
        }));

        ws.send(JSON.stringify({
            type: 'session_list',
            tmux: tmuxSessions,
            claude: claudeSessions,
            hasActive: activeSessionId() !== null
        }));
    });
}

// HTTP server for hook events
const httpServer = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);

    if (req.method === 'POST' && parsed.pathname === '/event') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const event = JSON.parse(body);
                const sid = (event.session_id || 'unknown').substring(0, 8);
                console.log('[' + new Date().toLocaleTimeString() + '] [' + sid + '] HOOK:',
                    event.hook_event_name, event.tool_name ? '(' + event.tool_name + ')' : '');
                handleEvent(event);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } catch (e) {
                res.writeHead(400);
                res.end('{"error":"parse"}');
            }
        });
    } else if (req.method === 'GET' && parsed.pathname === '/status') {
        const id = activeSessionId();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            sessions: Object.keys(sessions).length,
            activeSession: id ? id.substring(0, 8) : null,
            watching: watchedSession ? watchedSession.substring(0, 8) : 'auto',
            connected: activeWs !== null,
        }));
    } else if (req.method === 'POST' && parsed.pathname === '/watch') {
        // POST /watch?session=abc123 to pin a session
        // POST /watch?session=auto to auto-follow
        const sid = parsed.query.session;
        if (sid === 'auto') {
            watchedSession = null;
        } else if (sid) {
            // Find full session id matching prefix
            const match = Object.keys(sessions).find(id => id.startsWith(sid));
            if (match) watchedSession = match;
        }
        broadcastScreen();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ watching: watchedSession || 'auto' }));
    } else if (req.method === 'GET' && parsed.pathname === '/sessions') {
        const list = Object.entries(sessions).map(([id, s]) => ({
            id: id.substring(0, 8),
            lines: s.lines.length,
            lastActivity: new Date(s.lastActivity).toLocaleTimeString(),
            currentTool: s.currentTool,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
    }
    // ===========================================
    // TMUX HTTP ENDPOINTS
    // ===========================================
    else if (req.method === 'GET' && parsed.pathname === '/tmux/list') {
        listTmuxSessions((list) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(list));
        });
    }
    else if (req.method === 'POST' && parsed.pathname === '/tmux/create') {
        const name = parsed.query.name;
        createTmuxSession(name, (sessionName, err) => {
            if (sessionName) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, name: sessionName }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err }));
            }
        });
    }
    else if (req.method === 'POST' && parsed.pathname === '/tmux/kill') {
        const name = parsed.query.name;
        if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'name required' }));
            return;
        }
        killTmuxSession(name, (ok) => {
            res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok }));
        });
    }
    else if (req.method === 'POST' && parsed.pathname === '/tmux/send') {
        const name = parsed.query.name;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            if (!name || !body) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'name and body required' }));
                return;
            }
            sendToTmux(name, body, (ok) => {
                res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok }));
            });
        });
    }
    else {
        res.writeHead(404);
        res.end('Not found');
    }
});

httpServer.listen(HTTP_PORT, () => {
    console.log('HTTP hook receiver on :' + HTTP_PORT);
});

// Poll transcript for new assistant text every 2s
// Catches text that arrives after the last tool call
setInterval(() => {
    for (const session of Object.values(sessions)) {
        if (session.transcriptPath) {
            const before = session.lines.length;
            checkTranscript(session);
            if (session.lines.length > before) {
                broadcastIfActive(session);
            }
        }
    }
}, 2000);

// Cleanup stale sessions (>1h inactive)
setInterval(() => {
    const cutoff = Date.now() - 3600000;
    for (const [id, s] of Object.entries(sessions)) {
        if (s.lastActivity < cutoff) {
            delete sessions[id];
            if (watchedSession === id) watchedSession = null;
        }
    }
}, 60000);
