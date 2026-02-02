const { execSync } = require('child_process');
const WebSocket = require('ws');

const TMUX_SESSION = process.env.TMUX_SESSION || 'vibecode';
const PORT = 8080;
const POLL_MS = 400;

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
    const lines = cleaned.split('\n');

    // Find numbered options like "1. Yes" "2. No" "3. Always allow"
    const options = [];
    for (const line of lines) {
        const m = line.trim().match(/^(\d+)\.\s+(.+)/);
        if (m) {
            const num = parseInt(m[1]);
            const text = m[2].trim();
            // Only capture if it looks like a prompt option
            if (/^(Yes|No|Allow|Always|All|Reject|Skip|Retry|Cancel|Abort)/i.test(text) ||
                /don't ask/i.test(text)) {
                options.push({ num, text });
            }
        }
    }

    if (options.length >= 2) {
        // Map options to up/select/down buttons (max 3)
        const mapped = options.slice(0, 3).map(o => {
            // Aggressively shorten labels to fit 144px watch screen
            let label = o.text;
            // Common patterns
            if (/yes.*always/i.test(label) || /always allow/i.test(label) || /don't ask/i.test(label)) label = 'Always';
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
                color = (alt % 2 === 0) ? 'W' : 'B';
                alt++;
                break;
        }
        result.push(color + hyphenate(item.text, LINE_W));
    }

    return result.join('\n');
}

const wss = new WebSocket.Server({ port: PORT });
console.log('VibeCoder Bridge :' + PORT);

try {
    execSync('tmux has-session -t ' + TMUX_SESSION + ' 2>/dev/null');
    console.log('tmux OK');
} catch {
    console.log('tmux "' + TMUX_SESSION + '" not found');
}

wss.on('connection', (ws) => {
    console.log('[' + new Date().toLocaleTimeString() + '] Connected');
    let lastSent = '';
    let polling = true;

    const poll = setInterval(() => {
        if (!polling) return;
        try {
            const raw = execSync(
                'tmux capture-pane -t ' + TMUX_SESSION + ' -p -e 2>/dev/null',
                { encoding: 'utf8', timeout: 2000 }
            );
            const promptType = detectPrompt(raw);
            let screen = extractClaude(raw); // Use 'let' because it might be modified

            // Detect suggestion: look for the "dim/ghost" ANSI sequence ([2m) on prompt lines
            let suggestion = null;
            const rawLines = raw.split('\n');
            let finalScreenLines = screen.split('\n');

            for (let i = rawLines.length - 1; i >= 0; i--) {
                const rl = rawLines[i];
                // Only consider lines with a prompt symbol or that look like input
                if (!rl.includes('❯') && !rl.includes('>')) continue;

                // If it contains "dim/ghost" ANSI sequence ([2m), capture the entire line
                // This ensures we get things like "oui push" even if "o" is highlighted differently
                if (rl.includes('\x1b[2m') || rl.includes('\x1b[0;2m')) {
                    // Debounce/Stability: Only update suggestion if it's different or meaningful
                    let newSug = clean(rl).trim();
                    // Strip leading "> " arrow from suggestion
                    if (newSug.startsWith('> ')) newSug = newSug.substring(2).trim();
                    if (newSug && newSug.length > 2) {
                        suggestion = newSug;
                        // console.log('DETECTED GHOST SUGGESTION (FULL):', suggestion);
                    }
                    // Strip prompt/suggestion lines from main screen (may be split across multiple colored lines)
                    while (finalScreenLines.length > 0) {
                        const lastL = finalScreenLines[finalScreenLines.length - 1];
                        if (/(\[ME\]|[❯>])/.test(lastL)) {
                            finalScreenLines.pop();
                        } else {
                            break;
                        }
                    }
                }
                break; // Only check the active prompt line
            }
            screen = finalScreenLines.join('\n');

            // Reconstruct screen after potentially removing the suggestion line
            screen = finalScreenLines.join('\n');

            const msg = { type: 'output', content: screen }; // Use the potentially modified 'screen'
            if (promptType) msg.prompt = promptType;
            if (suggestion) msg.suggestion = suggestion;

            if (promptType) console.log('PROMPT DETECTED:', promptType);
            console.log('Content length:', screen.length);
            const msgStr = JSON.stringify(msg);
            if (msgStr !== lastSent && screen.length > 0) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(msgStr);
                }
                lastSent = msgStr;
            }
        } catch { }
    }, POLL_MS);

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            console.log('RECEIVED:', JSON.stringify(data));
            if (data.type === 'prompt') {
                execSync('tmux send-keys -t ' + TMUX_SESSION + ' "' + data.content.replace(/"/g, '\\"') + '" Enter');
            } else if (data.type === 'accept') {
                // Accept suggestion: Tab to autocomplete, wait, then Enter to submit
                execSync('tmux send-keys -t ' + TMUX_SESSION + ' Tab && sleep 0.3 && tmux send-keys -t ' + TMUX_SESSION + ' Enter');
            } else if (data.type === 'key') {
                execSync('tmux send-keys -t ' + TMUX_SESSION + ' "' + data.content + '"');
            }
        } catch { }
    });

    ws.on('close', () => { polling = false; clearInterval(poll); console.log('Disconnected'); });
});
