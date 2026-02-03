const { execSync, exec } = require('child_process');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const POLL_MS = 400;
const PROJECT_BASE = process.env.HOME + '/PebbleVibeProjects';

const LINE_W = 23; // chars per line for GOTHIC_14 on 144px

// Hard-wrap text: break words with hyphens to fill every line
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
                // Break long word with hyphens
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
            // Does the word fit on next line?
            if (word.length <= width) {
                // Fill remaining space from current line if possible
                lines.push(line);
                line = word;
            } else {
                // Fill current line, then break word
                const remaining = width - line.length - 1;
                if (remaining >= 2) {
                    line += ' ' + word.substring(0, remaining - 1) + '-';
                    lines.push(line);
                    let w = word.substring(remaining - 1);
                    while (w.length > width) {
                        lines.push(w.substring(0, width - 1) + '-');
                        w = w.substring(width - 1);
                    }
                    line = w;
                } else {
                    lines.push(line);
                    let w = word;
                    while (w.length > width) {
                        lines.push(w.substring(0, width - 1) + '-');
                        w = w.substring(width - 1);
                    }
                    line = w;
                }
            }
        }
    }
    if (line.length > 0) lines.push(line);
    return lines.join(' ');  // rejoin — watch will word-wrap, but now no word exceeds width
}

// Color codes for watch:
// W=white, B=blue, R=red, O=orange, Y=yellow, C=cyan, G=green, L=lightgray
function clean(str) {
    return str
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1B\][^\x07]*\x07/g, '')
        .replace(/\x1B[()][A-Z0-9]/g, '')
        .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '')
        .replace(/\r/g, '')
        .replace(/⏺/g, '-').replace(/⎿/g, ' ').replace(/●/g, '-')
        .replace(/⬤/g, '*').replace(/✓/g, 'OK').replace(/✗/g, 'FAIL')
        .replace(/⚠/g, '!').replace(/❌/g, 'X').replace(/✅/g, 'OK')
        .replace(/🔍/g, '').replace(/📁/g, '')
        .replace(/❯/g, '> ')
        .replace(/[^\x20-\x7E\n]/g, '');
}

function detectPrompt(raw) {
    const cleaned = clean(raw);

    // Find ALL numbered options like "1. Yes" "2. No" "3. Always allow" - may be on same line
    const options = [];
    const optionRegex = /(\d+)\.\s+(Yes[^0-9]*|No[^0-9]*|Allow[^0-9]*|Always[^0-9]*|Reject[^0-9]*|Skip[^0-9]*|Cancel[^0-9]*|Retry[^0-9]*)/gi;
    let match;
    while ((match = optionRegex.exec(cleaned)) !== null) {
        const num = parseInt(match[1]);
        let text = match[2].trim();
        // Clean up - remove trailing junk
        text = text.replace(/\s*\[ME\].*$/, '').replace(/\s*>.*$/, '').trim();
        if (text.length > 0 && !options.find(o => o.num === num)) {
            options.push({ num, text });
        }
    }
    // Sort by number
    options.sort((a, b) => a.num - b.num);

    if (options.length >= 2) {
        // Map options to up/select/down buttons (max 3)
        const mapped = options.slice(0, 3).map(o => {
            // Aggressively shorten labels to fit 144px watch screen
            let label = o.text;
            // Common patterns
            if (/yes.*always/i.test(label) || /always allow/i.test(label) || /don't ask/i.test(label) || /yes.*allow all/i.test(label)) label = 'Always';
            else if (/^yes/i.test(label)) label = 'Yes';
            else if (/^no/i.test(label)) label = 'No';
            else if (/^allow/i.test(label)) label = 'Allow';
            else if (/^reject/i.test(label)) label = 'Reject';
            else if (/^skip/i.test(label)) label = 'Skip';
            else if (/^cancel/i.test(label)) label = 'Cancel';
            else if (/^retry/i.test(label)) label = 'Retry';
            else if (label.length > 6) label = label.substring(0, 6);
            return { num: o.num, label };
        });
        return { options: mapped };
    }

    // Fallback detection
    if (/Do you want/.test(cleaned) && /Yes/.test(cleaned) && /No/.test(cleaned)) {
        return { options: [{ num: 1, label: 'Yes' }, { num: 2, label: 'No' }] };
    }
    if (/Allow/.test(cleaned) && /(Yes|No|Always)/.test(cleaned)) {
        return { options: [{ num: 1, label: 'Yes' }, { num: 2, label: 'Always' }, { num: 3, label: 'No' }] };
    }
    if (/proceed\?/.test(cleaned) && /Yes/.test(cleaned) && /No/.test(cleaned)) {
        return { options: [{ num: 1, label: 'Yes' }, { num: 2, label: 'No' }] };
    }
    return null;
}

function extractClaude(raw) {
    const cleaned = clean(raw);
    const lines = cleaned.split('\n');
    const items = [];  // {type, text}

    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;

        // Skip UI noise
        if (/^[-=]{3,}$/.test(t)) continue;
        if (/^\$\s*$/.test(t)) continue;
        if (/^Context left/.test(t)) continue;
        if (/^Esc to cancel/.test(t)) continue;
        if (/^\(ctrl\+/.test(t)) continue;
        if (/^accept edits/.test(t)) continue;
        if (/^shift\+tab/.test(t)) continue;
        if (/^> >/i.test(t)) continue;
        if (/^\.\.\. \+\d+ lines/.test(t)) continue;
        if (/^\(timeout/.test(t)) continue;
        if (/^Cooked for/.test(t) || /^Baked for/.test(t)) continue;
        if (/^Status dialog/.test(t)) continue;
        if (/^\/usage/.test(t) || /^\/help/.test(t) || /^\/clear/.test(t) || /^\/exit/.test(t)) continue;
        if (/Context left/.test(t)) continue;
        if (t.includes('───') || t.includes('━━━') || t.includes('━━')) continue;
        if (/^(\?|\s+\?)/.test(t)) continue;
        if (t.includes('shortcuts')) continue;

        // Skip ALL code - HTML, CSS, JS, etc.
        if (/<[a-z!][^>]*>|<\/[a-z]+>/i.test(t)) continue;  // HTML tags
        if (/^\s{2,}/.test(t)) continue;  // Indented code
        if (/[{};]$/.test(t)) continue;  // Code lines ending with { } ;
        if (/^(const|let|var|function|import|export|class|if|for|while|return)\s/i.test(t)) continue;  // JS
        if (/^\.([-a-z]+)\s*\{/i.test(t)) continue;  // CSS
        if (/^@(import|media|keyframes)/i.test(t)) continue;  // CSS
        if (/https?:\/\/[^\s]{30,}/.test(t)) continue;  // Long URLs
        if (/lines to \w+\.(html|css|js|json|md)/i.test(t)) continue;  // "Wrote X lines to file"
        if (/^\+\d+ lines/.test(t)) continue;  // "+300 lines"
        if (/ctrl\+[a-z]/.test(t)) continue;  // "ctrl+o to expand"
        if (/^(DOCTYPE|html|head|body|meta|link|script|style|div|span|footer|header|nav|section|article|aside|main|p|h[1-6]|ul|ol|li|a|img|form|input|button|table|tr|td|th)/i.test(t)) continue;

        // Indented tree lines from tool output
        if (/^[|L]\s/.test(t) && t.length < 20) continue;

        if (t.includes('───') || t.includes('━━━')) continue;
        if (/^(\?|\s+\?)/.test(t)) continue;

        // Clean ANSI and shorten paths
        const s = clean(t)
            .replace(/\/Users\/[^/]+\/Documents\/[^\/]+\/[^\/]+\//g, '')
            .trim();
        if (!s || s.length <= 1) continue;

        // --- Classify each line ---

        if (/[❯>]/.test(s) && s.length > 2) {
            // Do NOT treat this as a suggestion automatically.
            // Only the active ghost text detected in poll() is a suggestion.
            // Treat history prompts as normal text/user messages.
            // We can check if it looks like a user command:
            items.push({ type: 'user', text: '[ME] ' + s }); continue;
        }

        // Tool use headers - CYAN (Hacker blue)
        if (/^(Bash|Read|Edit|Write|Grep|Glob|Task|Search|List|View)\s*\(/.test(s)) {
            items.push({ type: 'tool', text: '[TOOL] ' + s }); continue;
        }

        // Commands - CYAN
        if (/^(\$ |cd |npm |npx |git |pebble |node |python |> |lsof )/.test(s)) {
            items.push({ type: 'tool', text: s.startsWith('$') ? s : '$ ' + s }); continue;
        }

        // Claude bullet points (* text) - these are Claude's main messages
        if (s.startsWith('*') || s.startsWith('⏺')) {
            items.push({ type: 'claude', text: s }); continue;
        }

        // Errors - RED
        if (/(error|fail|exception|crash|fatal|invalid|rejected)/i.test(s) && !/(success|created)/i.test(s)) {
            items.push({ type: 'error', text: '[X] ' + s }); continue;
        }
        // Success - GREEN
        if (/(success|OK,|created|installed|built|compil|completed|finished|passed|done)/i.test(s)) {
            items.push({ type: 'success', text: '[OK] ' + s }); continue;
        }
        // Warnings - ORANGE
        if (/(warning|removed|modified|deleted|modified|changed)/i.test(s)) {
            items.push({ type: 'warning', text: '[!] ' + s }); continue;
        }

        // Diff
        if (/^\+\s/.test(s)) { items.push({ type: 'diff_add', text: s }); continue; }
        if (/^-\s/.test(s)) { items.push({ type: 'diff_rm', text: s }); continue; }

        // File paths - LIGHT GRAY
        if (/^(\.\/|[a-zA-Z0-9_\-.]+\/|src\/|lib\/|app\/)/.test(s) && s.includes('/') && s.length < 60) {
            items.push({ type: 'file', text: '[F] ' + s }); continue;
        }

        // Git/System Keywords - COLORED (Gold/Orange for git)
        if (/git|ssh|fetch|push|pull|clone|commit|origin/i.test(s)) { items.push({ type: 'warning', text: s }); continue; }
        if (/Context|Task|Step/i.test(s)) { items.push({ type: 'text', text: s }); continue; } // Keep context white/blue

        // User messages (ALL CAPS or started with >)
        if (s.length > 10 && s === s.toUpperCase() && /[A-Z]{5,}/.test(s)) {
            items.push({ type: 'user', text: '[ME] ' + s }); continue;
        }

        // Everything else = Claude explanation text
        items.push({ type: 'text', text: s });
    }

    // Assign colors - alternate on EVERY line for claude/text
    const result = [];
    let alt = 0;
    for (const item of items) {
        let color;
        switch (item.type) {
            case 'tool': color = 'C'; break;
            case 'error': color = 'R'; break;
            case 'success': color = 'G'; break;
            case 'warning': color = 'O'; break;
            case 'prompt': color = 'Y'; break;
            case 'diff_add': color = 'G'; break;
            case 'diff_rm': color = 'R'; break;
            case 'file': color = 'L'; break;
            case 'user': color = 'Y'; break;
            case 'suggestion': color = 'S'; break;
            case 'claude':
            case 'text':
            default:
                // Cycle through colors - NO WHITE (hard to read)
                const colors = ['C', 'B', 'L', 'G'];
                color = colors[alt % colors.length];
                alt++;
                break;
        }
        result.push(color + hyphenate(item.text, LINE_W));
    }

    return result.join('\n');
}

// Session management
function listSessions() {
    try {
        const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' });
        return out.trim().split('\n').filter(l => l);
    } catch { return []; }
}

function createSession(name) {
    if (!fs.existsSync(PROJECT_BASE)) fs.mkdirSync(PROJECT_BASE, { recursive: true });
    if (!name) {
        let i = 1;
        name = 'NewProject';
        while (fs.existsSync(path.join(PROJECT_BASE, name))) {
            i++;
            name = 'NewProject' + i;
        }
    }
    const dir = path.join(PROJECT_BASE, name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        execSync(`tmux new-session -d -s "${name}" -c "${dir}" "cd '${dir}' && claude"`);
        return name;
    } catch { return null; }
}

const wss = new WebSocket.Server({ port: PORT });
console.log('VibeCoder Bridge :' + PORT);

wss.on('connection', (ws) => {
    console.log('[' + new Date().toLocaleTimeString() + '] Connected');
    let activeSession = null;
    let lastSent = '';
    let pollInterval = null;

    function sendMenu() {
        const sessions = listSessions();
        ws.send(JSON.stringify({ type: 'menu', sessions }));
    }

    function startPolling() {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(() => {
            if (!activeSession) return;
            try {
                const raw = execSync(
                    `tmux capture-pane -t "${activeSession}" -p -e 2>/dev/null`,
                    { encoding: 'utf8', timeout: 2000 }
                );
                const promptType = detectPrompt(raw);
                let screen = extractClaude(raw);

                let suggestion = null;
                const rawLines = raw.split('\n');
                let finalScreenLines = screen.split('\n');

                for (let i = rawLines.length - 1; i >= 0; i--) {
                    const rl = rawLines[i];
                    if (!rl.includes('❯') && !rl.includes('>')) continue;
                    if (rl.includes('\x1b[2m') || rl.includes('\x1b[0;2m')) {
                        let newSug = clean(rl).trim();
                        if (newSug.startsWith('> ')) newSug = newSug.substring(2).trim();
                        if (newSug && newSug.length > 2) suggestion = newSug;
                        while (finalScreenLines.length > 0) {
                            const lastL = finalScreenLines[finalScreenLines.length - 1];
                            if (/(\[ME\]|[❯>])/.test(lastL)) finalScreenLines.pop();
                            else break;
                        }
                    }
                    break;
                }
                screen = finalScreenLines.join('\n');

                const msg = { type: 'output', content: screen };
                if (promptType) msg.prompt = promptType;
                if (suggestion) msg.suggestion = suggestion;

                const msgStr = JSON.stringify(msg);
                if (msgStr !== lastSent && screen.length > 0) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(msgStr);
                    lastSent = msgStr;
                }
            } catch { }
        }, POLL_MS);
    }

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            console.log('FROM WATCH:', data.type);

            if (data.type === 'list') {
                activeSession = null;
                sendMenu();
            }
            else if (data.type === 'create') {
                const name = createSession();
                if (name) {
                    activeSession = name;
                    ws.send(JSON.stringify({ type: 'session_created', name }));
                    setTimeout(() => startPolling(), 1500);
                }
            }
            else if (data.type === 'join') {
                activeSession = data.name;
                lastSent = '';
                ws.send(JSON.stringify({ type: 'session_joined', name: data.name }));
                startPolling();
            }
            else if (data.type === 'leave') {
                activeSession = null;
                if (pollInterval) clearInterval(pollInterval);
            }
            else if (data.type === 'accept' && activeSession) {
                execSync(`tmux send-keys -t "${activeSession}" Tab && sleep 0.3 && tmux send-keys -t "${activeSession}" Enter`);
            }
            else if (data.type === 'key' && activeSession) {
                execSync(`tmux send-keys -t "${activeSession}" "${data.content}"`);
            }
        } catch (e) { console.log('Error:', e.message); }
    });

    ws.on('close', () => {
        if (pollInterval) clearInterval(pollInterval);
        console.log('Disconnected');
    });

    // Send menu on connect
    sendMenu();
});
