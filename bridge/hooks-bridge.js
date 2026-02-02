const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const WS_PORT = 8080;
const HTTP_PORT = 8081;
const LINE_W = 23;

// Rolling buffer of formatted lines for the watch
let screenLines = [];
const MAX_LINES = 40;

// Current state
let currentTool = null;
let waitingForPermission = false;
let permissionOptions = null;

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

function addLine(color, text) {
    // Hyphenate and split into multiple screen lines if needed
    const wrapped = hyphenate(text, LINE_W);
    for (const l of wrapped.split('\n')) {
        if (l.trim()) {
            screenLines.push(color + l);
        }
    }
    while (screenLines.length > MAX_LINES) screenLines.shift();
    broadcastScreen();
}

function shortenPath(p) {
    if (!p) return '';
    return p.replace(/\/Users\/[^/]+\/Documents\/[^/]+\/[^/]+\//g, '')
            .replace(/\/Users\/[^/]+\//g, '~/');
}

function shortenCommand(cmd) {
    if (!cmd) return '';
    // Shorten common patterns
    cmd = cmd.replace(/\/Users\/[^/]+\/Documents\/[^/]+\/[^/]+\//g, '');
    if (cmd.length > 60) cmd = cmd.substring(0, 57) + '...';
    return cmd;
}

function formatToolStart(name, input) {
    switch (name) {
        case 'Bash':
            return shortenCommand(input.command || '');
        case 'Read':
            return shortenPath(input.file_path || '');
        case 'Edit':
            return shortenPath(input.file_path || '');
        case 'Write':
            return shortenPath(input.file_path || '');
        case 'Grep':
            return (input.pattern || '').substring(0, 30);
        case 'Glob':
            return (input.pattern || '').substring(0, 30);
        case 'WebFetch':
            return (input.url || '').substring(0, 40);
        case 'WebSearch':
            return (input.query || '').substring(0, 40);
        case 'Task':
            return (input.description || '').substring(0, 30);
        default:
            return name;
    }
}

function formatToolResult(name, response) {
    if (!response) return null;
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    // Extract key info from result
    if (text.includes('error') || text.includes('Error') || text.includes('FAIL')) {
        const lines = text.split('\n').filter(l => /error|Error|FAIL/i.test(l));
        if (lines.length > 0) return lines[0].substring(0, 60);
    }
    if (text.includes('success') || text.includes('Success') || text.includes('OK')) {
        const lines = text.split('\n').filter(l => /success|Success|OK/i.test(l));
        if (lines.length > 0) return lines[0].substring(0, 60);
    }
    // For short results, show them
    if (text.length < 80) return text.replace(/\n/g, ' ').trim();
    return null;
}

// Handle hook events
function handleEvent(event) {
    const hookName = event.hook_event_name;
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' });

    switch (hookName) {
        case 'SessionStart':
            screenLines = [];
            addLine('C', '-- Session ' + ts + ' --');
            addLine('W', 'Model: ' + (event.model || 'unknown'));
            break;

        case 'UserPromptSubmit':
            addLine('Y', '> ' + (event.prompt || '').substring(0, 100));
            break;

        case 'PreToolUse': {
            const name = event.tool_name || '?';
            const detail = formatToolStart(name, event.tool_input || {});
            currentTool = name;
            // Tool icon based on type
            let icon = '$';
            if (name === 'Read') icon = 'R';
            else if (name === 'Edit') icon = 'E';
            else if (name === 'Write') icon = 'W';
            else if (name === 'Bash') icon = '$';
            else if (name === 'Grep' || name === 'Glob') icon = '?';
            else if (name === 'Task') icon = 'T';
            else icon = name.charAt(0);

            addLine('C', '[' + icon + '] ' + detail);
            break;
        }

        case 'PostToolUse': {
            const name = event.tool_name || '?';
            const result = formatToolResult(name, event.tool_response);
            if (result) {
                // Detect errors vs success
                if (/error|fail|exception/i.test(result)) {
                    addLine('R', '[X] ' + result);
                } else if (/success|ok|created|built|pass/i.test(result)) {
                    addLine('G', '[OK] ' + result);
                } else {
                    addLine('L', result);
                }
            }
            currentTool = null;
            break;
        }

        case 'PostToolUseFailure': {
            const err = event.error || 'Unknown error';
            addLine('R', '[FAIL] ' + err.substring(0, 60));
            currentTool = null;
            break;
        }

        case 'Notification': {
            const msg = event.message || '';
            const type = event.notification_type || '';
            if (type === 'permission_prompt') {
                addLine('O', '[!] Permission needed');
                waitingForPermission = true;
            } else {
                addLine('W', msg.substring(0, 80));
            }
            break;
        }

        case 'Stop':
            addLine('G', '-- Done ' + ts + ' --');
            currentTool = null;
            break;

        case 'SessionEnd':
            addLine('L', '-- Session ended --');
            break;

        default:
            // Log but don't display minor events
            console.log('Hook event:', hookName);
    }
}

// Read the transcript to get Claude's latest message
function getLastAssistantMessage(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'assistant' && entry.message && entry.message.content) {
                    const textParts = entry.message.content.filter(c => c.type === 'text');
                    if (textParts.length > 0) {
                        return textParts.map(t => t.text).join(' ');
                    }
                }
            } catch {}
        }
    } catch {}
    return null;
}

// WebSocket for watch
const wss = new WebSocket.Server({ port: WS_PORT });
console.log('VibeCoder Hooks Bridge WS:' + WS_PORT + ' HTTP:' + HTTP_PORT);

let activeWs = null;

function broadcastScreen() {
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
    const content = screenLines.join('\n');
    const msg = { type: 'output', content };
    // Add prompt if waiting for permission
    if (waitingForPermission && permissionOptions) {
        msg.prompt = permissionOptions;
    }
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
            // For now, watch button presses are logged
            // In the future, we could pipe responses back to Claude Code
        } catch {}
    });

    ws.on('close', () => {
        console.log('Watch disconnected');
        if (activeWs === ws) activeWs = null;
    });
});

// HTTP server for receiving hook events
const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/event') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const event = JSON.parse(body);
                console.log('[' + new Date().toLocaleTimeString() + '] HOOK:', event.hook_event_name,
                    event.tool_name ? '(' + event.tool_name + ')' : '');
                handleEvent(event);

                // On Stop, try to extract Claude's last message from transcript
                if (event.hook_event_name === 'Stop' && event.transcript_path) {
                    const lastMsg = getLastAssistantMessage(event.transcript_path);
                    if (lastMsg) {
                        // Show a summary (first ~100 chars)
                        const summary = lastMsg.substring(0, 120).replace(/\n/g, ' ');
                        addLine('W', summary);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } catch (e) {
                console.error('Parse error:', e.message);
                res.writeHead(400);
                res.end('{"error":"parse"}');
            }
        });
    } else if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            lines: screenLines.length,
            connected: activeWs !== null,
            currentTool
        }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

httpServer.listen(HTTP_PORT, () => {
    console.log('HTTP hook receiver on :' + HTTP_PORT);
});
