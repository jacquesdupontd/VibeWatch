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
        .replace(/⏺/g, '*').replace(/⎿/g, ' ').replace(/●/g, '*')
        .replace(/⬤/g, '*').replace(/✓/g, 'OK').replace(/✗/g, 'FAIL')
        .replace(/⚠/g, '!').replace(/❌/g, 'X').replace(/✅/g, 'OK')
        .replace(/🔍/g, '').replace(/📁/g, '')
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
        if (/^\/usage/.test(t) || /^\/help/.test(t) || /^\/clear/.test(t)) continue;
        // Pure numbers (PIDs, line numbers, etc.)
        if (/^\d+$/.test(t)) continue;
        // Short junk (single chars, arrows, etc.)
        if (t.length <= 2) continue;
        // Diff code lines: "123 | code" or "123 + code"
        if (/^\d+\s+[\|\+\-]/.test(t)) continue;
        // Indented tree lines from tool output
        if (/^[|L]\s/.test(t) && t.length < 20) continue;

        // Shorten paths
        const s = t.replace(/\/Users\/[^/]+\/Documents\/[^\/]+\/[^\/]+\//g, '')
                    .replace(/\(ctrl\+o to expand\)/g, '')
                    .trim();
        if (!s || s.length <= 2) continue;

        // --- Classify each line ---

        // Prompts - YELLOW
        if (/^Do you want/.test(s)) { items.push({type:'prompt', text: s}); continue; }
        if (/^\d+\.\s*(Yes|No|Allow)/.test(s)) { items.push({type:'prompt', text: s}); continue; }

        // Tool use headers - CYAN
        if (/^(Bash|Read|Edit|Write|Grep|Glob|Task|Search)\s*\(/.test(s)) {
            items.push({type:'tool', text: '> ' + s}); continue;
        }

        // Commands - CYAN
        if (/^(cd |npm |npx |git |pebble |node |python |> |lsof )/.test(s)) {
            items.push({type:'tool', text: s}); continue;
        }

        // Claude bullet points (* text) - these are Claude's main messages
        if (s.startsWith('*')) {
            items.push({type:'claude', text: s}); continue;
        }

        // Errors - RED
        if (/(error|fail|exception|crash|fatal)/i.test(s) && !/(success)/i.test(s)) {
            items.push({type:'error', text: s}); continue;
        }
        // Success - GREEN
        if (/(success|OK,|created|installed|built|compil|completed|est bon)/i.test(s)) {
            items.push({type:'success', text: s}); continue;
        }
        // Warnings - ORANGE
        if (/(warning|removed|modified|deleted)/i.test(s)) {
            items.push({type:'warning', text: s}); continue;
        }

        // Diff
        if (/^\+\s/.test(s)) { items.push({type:'diff_add', text: s}); continue; }
        if (/^-\s/.test(s)) { items.push({type:'diff_rm', text: s}); continue; }

        // File paths - LIGHT GRAY
        if (/^(src\/|\.\/|\w+\.\w+:)/.test(s) && s.length < 80) {
            items.push({type:'file', text: s}); continue;
        }

        // ALL CAPS = user message - distinct color
        if (s.length > 10 && s === s.toUpperCase() && /[A-Z]{5,}/.test(s)) {
            items.push({type:'user', text: s}); continue;
        }

        // Everything else = Claude explanation text
        items.push({type:'text', text: s});
    }

    // Assign colors - alternate on EVERY line for claude/text
    const result = [];
    let alt = 0;
    for (const item of items) {
        let color;
        switch (item.type) {
            case 'tool':     color = 'C'; break;
            case 'error':    color = 'R'; break;
            case 'success':  color = 'G'; break;
            case 'warning':  color = 'O'; break;
            case 'prompt':   color = 'Y'; break;
            case 'diff_add': color = 'G'; break;
            case 'diff_rm':  color = 'R'; break;
            case 'file':     color = 'L'; break;
            case 'user':     color = 'Y'; break;
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
    console.log('Connected');
    let lastSent = '';
    let polling = true;

    const poll = setInterval(() => {
        if (!polling) return;
        try {
            const raw = execSync(
                'tmux capture-pane -t ' + TMUX_SESSION + ' -p 2>/dev/null',
                { encoding: 'utf8', timeout: 2000 }
            );
            const promptType = detectPrompt(raw);
            const screen = extractClaude(raw);

            // Detect suggestion: find last line with ❯ or > prompt
            let suggestion = null;
            const rawLines = raw.split('\n');
            for (let i = rawLines.length - 1; i >= 0; i--) {
                const rl = rawLines[i];
                // Skip empty and UI noise lines
                if (!rl.trim()) continue;
                if (/accept edits/.test(rl)) continue;
                if (/shift\+tab/.test(rl)) continue;
                if (/Context left/.test(rl)) continue;
                if (/^[\s─━═]+$/.test(rl.trim())) continue;

                // Check for prompt char ❯ or >
                if (/[❯]/.test(rl) || /^\s*>\s+\S/.test(rl)) {
                    // Check if next meaningful line is a response (means already submitted)
                    let submitted = false;
                    for (let j = i + 1; j < rawLines.length; j++) {
                        const next = rawLines[j].trim();
                        if (!next) continue;
                        if (/[─━═]{3,}/.test(next)) continue;  // separators don't mean submitted
                        if (/accept edits/.test(next)) continue;  // UI noise
                        if (/shift\+tab/.test(next)) continue;
                        // If we find Claude's response marker, it's submitted
                        if (/[⏺]/.test(next) || /^\*/.test(next)) {
                            submitted = true;
                        }
                        break;
                    }
                    if (!submitted) {
                        // Extract text after prompt symbol
                        let sugText = rl.replace(/.*[❯>]\s*/, '').trim();
                        sugText = clean(sugText).trim();
                        if (sugText.length > 1) {
                            suggestion = sugText;
                            console.log('SUGGESTION:', suggestion);
                        }
                    }
                }
                break;  // only check the last non-noise line
            }

            // Remove suggestion text from screen content to avoid duplicate
            let finalScreen = screen;
            if (suggestion) {
                const lines = finalScreen.split('\n');
                // Remove last line(s) that contain the suggestion text
                while (lines.length > 0) {
                    const last = lines[lines.length - 1];
                    // Strip color code prefix and check
                    const text = last.length > 1 ? last.substring(1) : '';
                    if (text.trim() && suggestion.includes(text.trim().substring(0, 10))) {
                        lines.pop();
                    } else {
                        break;
                    }
                }
                finalScreen = lines.join('\n');
            }

            const msg = { type: 'output', content: finalScreen };
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
        } catch {}
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
        } catch {}
    });

    ws.on('close', () => { polling = false; clearInterval(poll); console.log('Disconnected'); });
});
