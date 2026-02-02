const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const url = require('url');

const WS_PORT = 8080;
const HTTP_PORT = 8081;
const LINE_W = 23;
const MAX_LINES = 40;

// Per-session state
const sessions = {}; // session_id -> { lines: [], currentTool, lastActivity }

// Which session the watch is viewing (null = auto-follow latest)
let watchedSession = null;

function getSession(id) {
    if (!sessions[id]) {
        sessions[id] = { lines: [], currentTool: null, lastActivity: Date.now() };
    }
    sessions[id].lastActivity = Date.now();
    return sessions[id];
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

function broadcastIfActive(session) {
    const activeId = activeSessionId();
    if (!activeId || sessions[activeId] !== session) return;
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
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    if (/error|Error|FAIL/i.test(text)) {
        const lines = text.split('\n').filter(l => /error|Error|FAIL/i.test(l));
        if (lines.length > 0) return lines[0].substring(0, 60);
    }
    if (/success|Success|OK|passed/i.test(text)) {
        const lines = text.split('\n').filter(l => /success|Success|OK|passed/i.test(l));
        if (lines.length > 0) return lines[0].substring(0, 60);
    }
    if (text.length < 80) return text.replace(/\n/g, ' ').trim();
    return null;
}

function handleEvent(event) {
    const hookName = event.hook_event_name;
    const sessionId = event.session_id || 'unknown';
    const session = getSession(sessionId);
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' });

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
            let icon = '$';
            if (name === 'Read') icon = 'R';
            else if (name === 'Edit') icon = 'E';
            else if (name === 'Write') icon = 'W';
            else if (name === 'Bash') icon = '$';
            else if (name === 'Grep' || name === 'Glob') icon = '?';
            else if (name === 'Task') icon = 'T';
            else icon = name.charAt(0);
            addLine(session, 'C', '[' + icon + '] ' + detail);
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

        case 'Stop': {
            addLine(session, 'G', '-- Done ' + ts + ' --');
            session.currentTool = null;
            // Extract Claude's last message from transcript
            if (event.transcript_path) {
                try {
                    const lines = fs.readFileSync(event.transcript_path, 'utf8').trim().split('\n');
                    for (let i = lines.length - 1; i >= 0; i--) {
                        try {
                            const entry = JSON.parse(lines[i]);
                            if (entry.type === 'assistant' && entry.message && entry.message.content) {
                                const texts = entry.message.content.filter(c => c.type === 'text');
                                if (texts.length > 0) {
                                    const msg = texts.map(t => t.text).join(' ')
                                        .replace(/\n/g, ' ').substring(0, 120);
                                    addLine(session, 'W', msg);
                                    break;
                                }
                            }
                        } catch {}
                    }
                } catch {}
            }
            break;
        }

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
    broadcastScreen();

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            console.log('FROM WATCH:', JSON.stringify(data));
            // UP button: cycle to previous session
            // DOWN button: cycle to next session
            // SELECT: back to auto-follow
            if (data.type === 'key') {
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
        } catch {}
    });

    ws.on('close', () => {
        console.log('Watch disconnected');
        if (activeWs === ws) activeWs = null;
    });
});

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
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

httpServer.listen(HTTP_PORT, () => {
    console.log('HTTP hook receiver on :' + HTTP_PORT);
});

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
