const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const WS_PORT = 8080;
const PROJECT_BASE = process.env.HOME + '/PebbleVibeProjects';
const POLL_INTERVAL = 400;

// Debug log to file
function debugLog(msg) {
    const line = new Date().toISOString().substr(11,8) + ' ' + msg + '\n';
    fs.appendFileSync('/tmp/bridge-debug.log', line);
    console.log(msg);
}

let activeSession = null;
let lastContent = '';
let lastPrompt = '';
let ws = null;

// ===========================================
// ANSI STRIPPING - Complete
// ===========================================

function stripAnsi(str) {
    return str
        // ANSI escape sequences
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
        .replace(/\x1b[@-Z\\-_]/g, '')
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        // Unicode box drawing and special chars
        .replace(/[\u2500-\u257F]/g, '-')  // Box drawing -> dash
        .replace(/[\u2580-\u259F]/g, '')   // Block elements
        .replace(/[\u25A0-\u25FF]/g, '')   // Geometric shapes
        .replace(/[\uE000-\uF8FF]/g, '')   // Private use area (icons)
        .replace(/[\u200B-\u200F\u2028-\u202F]/g, '') // Zero-width chars
        .replace(/[❯❮►◄▶◀→←↑↓]/g, '')  // Arrow/pointer symbols
        // Control chars
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .replace(/\r/g, '')
        // Multiple spaces
        .replace(/  +/g, ' ');
}

// ===========================================
// TMUX FUNCTIONS
// ===========================================

function listTmuxSessions(callback) {
    exec('tmux list-sessions -F "#{session_name}" 2>/dev/null', (err, stdout) => {
        if (err) { callback([]); return; }
        callback(stdout.trim().split('\n').filter(l => l));
    });
}

function getNextProjectDir() {
    if (!fs.existsSync(PROJECT_BASE)) {
        fs.mkdirSync(PROJECT_BASE, { recursive: true });
    }
    let name = 'NewProject';
    let i = 1;
    while (fs.existsSync(path.join(PROJECT_BASE, name))) {
        i++;
        name = 'NewProject' + i;
    }
    const dir = path.join(PROJECT_BASE, name);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, name };
}

function createSession(sessionName, callback) {
    const { dir, name } = sessionName ?
        { dir: path.join(PROJECT_BASE, sessionName), name: sessionName } :
        getNextProjectDir();

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const cmd = `tmux new-session -d -s "${name}" -c "${dir}" "cd '${dir}' && claude"`;
    console.log('Creating:', cmd);

    exec(cmd, (err) => {
        if (err) {
            callback(null, err.message);
        } else {
            callback(name, null);
        }
    });
}

function captureTmux(sessionName, callback) {
    exec(`tmux capture-pane -t "${sessionName}" -p -S -30 2>/dev/null`, (err, stdout) => {
        callback(err ? null : stdout);
    });
}

function sendToTmux(sessionName, text) {
    const escaped = text.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    exec(`tmux send-keys -t "${sessionName}" "${escaped}" Enter`);
}

function sendKeyToTmux(sessionName, key) {
    exec(`tmux send-keys -t "${sessionName}" "${key}"`);
}

// ===========================================
// DETECT PROMPTS
// ===========================================

function detectPrompt(content) {
    const lower = content.toLowerCase();

    // Trust folder prompt - Claude's "Quick safety check" with selection menu
    if (lower.includes('quick safety check') ||
        lower.includes('is this a project you') ||
        (lower.includes('yes, i trust') && lower.includes('no, exit'))) {
        debugLog('PROMPT DETECTED: trust folder');
        // Enter confirms Yes (selected by default), Escape cancels
        return { promptType: 'trust', options: ['Yes', 'Exit'], keys: ['Enter', 'Escape'] };
    }
    // Permission prompts with y/n
    if (lower.includes('allow once') || lower.includes('allow for this session') ||
        lower.includes('allow always')) {
        console.log('PROMPT DETECTED: permission');
        return { promptType: 'permission', options: ['Allow', 'Deny'], keys: ['y', 'n'] };
    }
    // Yes/No prompt
    if (lower.includes('(y/n)') || lower.includes('[y/n]')) {
        console.log('PROMPT DETECTED: yesno');
        return { promptType: 'yesno', options: ['Yes', 'No'], keys: ['y', 'n'] };
    }
    // Generic enter to confirm (but NOT the trust menu which also has this)
    if ((lower.includes('enter to confirm') || lower.includes('press enter')) &&
        !lower.includes('quick safety check')) {
        console.log('PROMPT DETECTED: confirm');
        return { promptType: 'confirm', options: ['Confirm'], keys: ['Enter'] };
    }
    return null;
}

// ===========================================
// FORMAT FOR WATCH
// ===========================================

function formatForWatch(rawContent) {
    if (!rawContent) return { content: '', prompt: null };

    const clean = stripAnsi(rawContent);
    const lines = clean.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

    // Take last 10 lines max (watch can display ~10 lines with bar)
    const recent = lines.slice(-10);

    // Detect any prompts
    const prompt = detectPrompt(clean);

    // Format with colors based on content
    const formatted = recent.map((line, i) => {
        let color = 'W'; // Default white
        const lower = line.toLowerCase();

        // Color coding by content type
        if (lower.includes('error') || lower.includes('fail')) {
            color = 'R'; // Red
        } else if (lower.includes('success') || lower.includes('done') || lower.includes('created')) {
            color = 'G'; // Green
        } else if (line.startsWith('>') || line.startsWith('$') || lower.includes('prompt')) {
            color = 'Y'; // Yellow for prompts
        } else if (line.startsWith('/') || line.includes('Users/')) {
            color = 'B'; // Blue for paths
        } else if (lower.includes('trust') || lower.includes('yes') || lower.includes('no,')) {
            color = 'O'; // Orange for choices
        } else if (line.match(/^\d+\./)) {
            color = 'C'; // Cyan for numbered items
        } else {
            // Alternate colors for readability
            color = ['W', 'L'][i % 2];
        }

        // Keep more text (watch wraps anyway)
        const text = line.substring(0, 50);
        return color + text;
    });

    return {
        content: formatted.join('\n'),
        prompt: prompt
    };
}

// ===========================================
// WEBSOCKET SERVER
// ===========================================

const wss = new WebSocket.Server({ port: WS_PORT });
console.log('VibeCoder Bridge on port', WS_PORT);

function sendToWatch(type, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type, ...data }));
}

function sendMenu() {
    listTmuxSessions((sessions) => {
        sendToWatch('menu', { sessions });
    });
}

function sendSessionContent() {
    if (!activeSession) {
        sendMenu();
        return;
    }

    captureTmux(activeSession, (raw) => {
        if (!raw) {
            activeSession = null;
            sendMenu();
            return;
        }

        const { content, prompt } = formatForWatch(raw);

        // Always send content
        if (content !== lastContent) {
            lastContent = content;
            sendToWatch('output', { content, session: activeSession });
        }

        // Send prompt if detected and changed
        const promptKey = prompt ? prompt.promptType : '';
        debugLog('promptKey=' + promptKey + ' lastPrompt=' + lastPrompt);
        if (promptKey !== lastPrompt) {
            lastPrompt = promptKey;
            if (prompt) {
                debugLog('SENDING PROMPT: ' + JSON.stringify(prompt));
                sendToWatch('prompt', prompt);
            } else {
                debugLog('Prompt cleared');
            }
        }
    });
}

wss.on('connection', (socket) => {
    debugLog('Watch connected');
    ws = socket;
    sendMenu();

    socket.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            debugLog('FROM WATCH: ' + JSON.stringify(data));

            switch (data.type) {
                case 'create_session':
                    createSession(data.name, (name, err) => {
                        if (name) {
                            activeSession = name;
                            sendToWatch('session_created', { name });
                            setTimeout(() => sendSessionContent(), 1500);
                        } else {
                            sendToWatch('error', { message: err });
                        }
                    });
                    break;

                case 'join_session':
                    activeSession = data.name;
                    lastContent = '';
                    lastPrompt = '';
                    sendToWatch('session_joined', { name: data.name });
                    sendSessionContent();
                    break;

                case 'list_sessions':
                    activeSession = null;
                    sendMenu();
                    break;

                case 'leave_session':
                    activeSession = null;
                    lastContent = '';
                    lastPrompt = '';
                    sendMenu();
                    break;

                case 'send_text':
                    if (activeSession && data.text) {
                        sendToTmux(activeSession, data.text);
                    }
                    break;

                case 'send_key':
                    if (activeSession && data.key) {
                        sendKeyToTmux(activeSession, data.key);
                        // Force refresh after key
                        setTimeout(() => sendSessionContent(), 300);
                    }
                    break;

                case 'confirm':
                    // Quick confirm - send Enter or the specified key
                    if (activeSession) {
                        const key = data.key || 'Enter';
                        sendKeyToTmux(activeSession, key);
                        setTimeout(() => sendSessionContent(), 300);
                    }
                    break;
            }
        } catch (e) {
            console.log('Parse error:', e.message);
        }
    });

    socket.on('close', () => {
        console.log('Watch disconnected');
        ws = null;
    });
});

// Poll active session
setInterval(() => {
    if (activeSession) {
        sendSessionContent();
    }
}, POLL_INTERVAL);

console.log('Ready. Waiting for watch...');
