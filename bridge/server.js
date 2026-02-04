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

// Find the JSONL transcript file for a session
function findTranscriptFile(sessionName) {
    try {
        const projectsDir = path.join(process.env.HOME, '.claude', 'projects');

        // Get the actual working directory of the tmux session
        let sessionCwd = null;
        try {
            sessionCwd = execSync(
                `tmux display-message -t "${sessionName}" -p "#{pane_current_path}" 2>/dev/null`,
                { encoding: 'utf8' }
            ).trim();
        } catch (e) {
            console.log('Could not get tmux cwd for session:', sessionName);
        }

        // Convert session cwd to Claude's folder naming convention
        // /Users/foo/bar becomes -Users-foo-bar
        let expectedFolder = null;
        if (sessionCwd) {
            expectedFolder = sessionCwd.replace(/\//g, '-');
            if (expectedFolder.startsWith('-')) expectedFolder = expectedFolder; // keep leading dash
            console.log('Looking for Claude project folder:', expectedFolder);
        }

        // Find matching project folder
        const allFolders = fs.readdirSync(projectsDir);
        let folders = [];

        if (expectedFolder) {
            // Exact match first
            folders = allFolders.filter(f => f === expectedFolder);
            // Partial match if no exact
            if (folders.length === 0) {
                folders = allFolders.filter(f => f.includes(sessionName) || expectedFolder.includes(f));
            }
        }

        // Fallback: try session name directly
        if (folders.length === 0) {
            folders = allFolders.filter(f => f.includes(sessionName));
        }

        for (const folder of folders) {
            const folderPath = path.join(projectsDir, folder);
            const stat = fs.statSync(folderPath);
            if (!stat.isDirectory()) continue;
            const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
            if (files.length > 0) {
                // Return the most recent one (by mtime)
                let newest = files[0];
                let newestTime = 0;
                for (const f of files) {
                    const fstat = fs.statSync(path.join(folderPath, f));
                    if (fstat.mtimeMs > newestTime) {
                        newestTime = fstat.mtimeMs;
                        newest = f;
                    }
                }
                console.log('Found transcript:', path.join(folderPath, newest));
                return path.join(folderPath, newest);
            }
        }
    } catch (e) {
        console.log('Error finding transcript:', e.message);
    }
    return null;
}

// Format tool_use into compact string (stolen from other Claude's parser)
function formatToolUse(name, input) {
    switch (name) {
        case 'Bash': {
            let cmd = input?.command || '';
            // Compact: remove cd, show just the command
            cmd = cmd.replace(/cd\s+[^\s&|;]+\s*[;&|]*\s*/g, '').trim();
            if (cmd.length > 40) cmd = cmd.substring(0, 37) + '...';
            return '$ ' + (cmd || '(empty)');
        }
        case 'Read': return '◎ read ' + (input?.file_path || '').split('/').pop();
        case 'Write': return '✎ write ' + (input?.file_path || '').split('/').pop();
        case 'Edit': return '✎ edit ' + (input?.file_path || '').split('/').pop();
        case 'Grep': return '⌕ grep "' + (input?.pattern || '').substring(0, 20) + '"';
        case 'Glob': return '⌕ glob ' + (input?.pattern || '');
        case 'Task': return '◇ agent: ' + (input?.description || '').substring(0, 30);
        case 'WebFetch': return '↓ fetch ' + (input?.url || '').substring(0, 30);
        case 'WebSearch': return '◈ search "' + (input?.query || '').substring(0, 25) + '"';
        default: return '⚙ ' + name;
    }
}

// Extract structured data from JSONL transcript (CLEAN mode)
function extractCleanDataFromTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return { userCmd: '', summary: '', status: 'No transcript', lastTool: '' };
    }

    try {
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n').filter(l => l);

        let userCmd = '';
        let summary = '';
        let status = 'Ready';
        let lastTool = '';

        // Read last ~100 lines for recent activity (reverse order to find latest)
        const recentLines = lines.slice(-100).reverse();

        for (const line of recentLines) {
            try {
                const entry = JSON.parse(line);

                // User message - get the actual text prompt (NOT tool_result)
                if (entry.type === 'user' && entry.message && !userCmd) {
                    const msgContent = entry.message.content;
                    // String = direct user prompt
                    if (typeof msgContent === 'string' && msgContent.length > 3) {
                        userCmd = msgContent;
                    } else if (Array.isArray(msgContent)) {
                        // Array = look for text type, skip tool_result
                        for (const item of msgContent) {
                            if (item.type === 'tool_result') continue; // skip tool results
                            if (item.type === 'text' && item.text && item.text.length > 3) {
                                userCmd = item.text;
                                break;
                            }
                            if (typeof item === 'string' && item.length > 3) {
                                userCmd = item;
                                break;
                            }
                        }
                    }
                    // Truncate and show END of long prompts
                    if (userCmd && userCmd.length > 60) {
                        userCmd = '...' + userCmd.substring(userCmd.length - 57);
                    }
                }

                // Assistant message - look for text AND tool_use
                if (entry.type === 'assistant' && entry.message && entry.message.content) {
                    const contents = entry.message.content;
                    if (Array.isArray(contents)) {
                        for (const c of contents) {
                            // Extract tool_use (most recent)
                            if (c.type === 'tool_use' && c.name && !lastTool) {
                                lastTool = formatToolUse(c.name, c.input);
                            }
                            // Extract text summary
                            if (!summary && c.type === 'text' && c.text && c.text.length > 10) {
                                // Skip code blocks and tool descriptions
                                if (!c.text.startsWith('```') && !c.text.includes('tool_use')) {
                                    // Show END of text if too long (user wants to see latest info)
                                    if (c.text.length > 200) {
                                        summary = '...' + c.text.substring(c.text.length - 200);
                                    } else {
                                        summary = c.text;
                                    }
                                }
                            }
                        }
                    }
                }

                // Stop if we have all three
                if (userCmd && summary && lastTool) break;

            } catch (e) { /* skip invalid JSON lines */ }
        }

        // Detect status - check last 50 entries for most recent assistant message with real stop_reason
        for (let i = 0; i < Math.min(50, lines.length); i++) {
            try {
                const entry = JSON.parse(lines[lines.length - 1 - i]);
                // Look for assistant message with stop_reason
                if (entry.type === 'assistant' && entry.message && entry.message.stop_reason !== undefined) {
                    if (entry.message.stop_reason === 'stop_sequence' || entry.message.stop_reason === 'end_turn') {
                        status = 'Done';
                        break;
                    } else if (entry.message.stop_reason === 'tool_use') {
                        status = 'Working...';
                        break;
                    }
                    // Note: stop_reason=null means still streaming, keep looking for final message
                }
            } catch (e) {}
        }

        return { userCmd, summary, status, lastTool };
    } catch (e) {
        console.log('Transcript error:', e.message);
        return { userCmd: '', summary: 'Error: ' + e.message, status: 'Error' };
    }
}

// Extract real-time status from tmux (fun words like Cogitating, Baking, etc.)
// Use REGEX to match any "Word..." pattern, with BLACKLIST of false positives
const STATUS_BLACKLIST = [
    'Reading', 'Writing', 'Installing', 'Creating', 'Processing',
    'Building', 'Compiling', 'Running', 'Checking', 'Loading',
    'Updating', 'Searching', 'Connecting', 'Downloading', 'Uploading'
];

function extractRealtimeStatus(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    // Check last 30 lines for status patterns
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Pattern 1: Any "Word..." or "Word…" (thinking indicator)
        // Must start with status indicators (·, ✳, ✶, ✽, *, etc.) or be standalone
        const thinkMatch = line.match(/[·✳✶✽*]?\s*([A-Z][a-z]+)(\.{3}|…)/);
        if (thinkMatch) {
            const word = thinkMatch[1];
            // Skip blacklisted words (tool outputs, not thinking)
            if (!STATUS_BLACKLIST.includes(word)) {
                return word + '...';
            }
        }

        // Pattern 2: "Word for Xs" (done indicator) - past tense thinking
        const doneMatch = line.match(/([A-Z][a-z]+)\s+for\s+\d+[ms]/);
        if (doneMatch) {
            return 'Done';
        }

        // Pattern 3: "(thought for Xs)" in parentheses
        if (/\(thought for \d+/.test(line)) {
            return 'Done';
        }
    }
    return null;
}

// Extract real-time tool use from tmux output (since JSONL is delayed)
function extractRealtimeTool(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    // Scan from bottom for recent tool activity
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Tool headers from Claude Code: "⏺ Bash(...)" "⏺ Read(...)" etc.
        // Match with optional bullet prefix (⏺, *, -)
        const toolMatch = line.match(/^[⏺*-]?\s*(Read|Write|Edit|Bash|Grep|Glob|Task|WebFetch|WebSearch|LSP)\s*\(/i);
        if (toolMatch) {
            const name = toolMatch[1];
            // Extract parameter in parentheses (may span multiple lines, just get first part)
            const paramMatch = line.match(/\(([^)\n]+)/);
            let param = paramMatch ? paramMatch[1] : '';
            // Clean up truncation markers
            param = param.replace(/…\)?$/, '').trim();

            // Format based on tool type
            switch (name.toLowerCase()) {
                case 'bash':
                    let cmd = param.replace(/cd\s+[^\s&|;]+\s*[;&|]*\s*/g, '').trim();
                    // Remove quotes
                    cmd = cmd.replace(/^["']|["']$/g, '');
                    if (cmd.length > 35) cmd = cmd.substring(0, 32) + '...';
                    return '$ ' + (cmd || 'running...');
                case 'read':
                    return 'read ' + param.split('/').pop();
                case 'write':
                    return 'write ' + param.split('/').pop();
                case 'edit':
                    return 'edit ' + param.split('/').pop();
                case 'grep':
                    return 'grep ' + param.substring(0, 25);
                case 'glob':
                    return 'glob ' + param;
                case 'task':
                    return 'agent ' + param.substring(0, 25);
                case 'webfetch':
                    return 'fetch ' + param.substring(0, 25);
                case 'websearch':
                    return 'search ' + param.substring(0, 25);
                default:
                    return name + ' ' + param.substring(0, 20);
            }
        }

        // Also match $ command lines (bash execution)
        if (/^\$\s+\S/.test(line)) {
            let cmd = line.substring(1).trim();
            if (cmd.length > 35) cmd = cmd.substring(0, 32) + '...';
            return '$ ' + cmd;
        }
    }
    return null;
}

// Extract real-time assistant text from tmux (bullets and text)
// Claude's text format: ⏺ starts a paragraph, continuation lines are indented (may have - bullets)
function extractRealtimeText(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    // Find Claude paragraphs: lines starting with ⏺ (not tool calls) + their continuations
    const paragraphs = [];
    let currentParagraph = null;
    let lastWasEmpty = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
            lastWasEmpty = true;
            continue;  // Don't end paragraph on empty line - wait for next content
        }

        // Skip UI noise
        if (/^[-=─━]{3,}/.test(trimmed)) { lastWasEmpty = false; continue; }
        if (/Context left|esc to interrupt|ctrl\+[a-z]/.test(trimmed)) { lastWasEmpty = false; continue; }
        if (/^\d+\s+files?\s+\+/.test(trimmed)) { lastWasEmpty = false; continue; }
        if (/^[●✢✳✶·]/.test(trimmed)) { lastWasEmpty = false; continue; }
        if (/^❯/.test(trimmed)) { lastWasEmpty = false; continue; }
        if (/^⎿/.test(trimmed)) { lastWasEmpty = false; continue; }  // Tool output marker

        // New Claude paragraph: starts with ⏺ and is NOT a tool call
        if (trimmed.startsWith('⏺')) {
            // Save previous paragraph
            if (currentParagraph) paragraphs.push(currentParagraph);

            // Skip if it's a tool call line
            if (/^⏺\s*(Read|Write|Edit|Update|Bash|Grep|Glob|Task|WebFetch|WebSearch|LSP|NotebookEdit)\s*[\(\d]/i.test(trimmed)) {
                currentParagraph = null;
                lastWasEmpty = false;
                continue;
            }
            if (/^⏺\s*(Read|Edit|Write|Bash|Grep|Glob)\s+\d+\s+(file|line)/i.test(trimmed)) {
                currentParagraph = null;
                lastWasEmpty = false;
                continue;
            }

            // Start new paragraph
            currentParagraph = trimmed.replace(/^⏺\s*/, '').trim();
            lastWasEmpty = false;
            continue;
        }

        // Continuation: indented line (spaces at start) - include dash bullets
        // These can come after empty lines if they're part of Claude's formatted output
        if (/^\s{2,}/.test(line) && !trimmed.startsWith('⏺') && !trimmed.startsWith('⎿')) {
            if (/\(ctrl\+[a-z]\s+to\s+(expand|collapse)\)/i.test(trimmed)) {
                lastWasEmpty = false;
                continue;
            }
            // Skip diff/code lines
            if (/^\d+\s*[-+]/.test(trimmed)) { lastWasEmpty = false; continue; }  // Diff line numbers
            if (/^[-+]\s*(function|const|let|var|if|for|while|return|import|export|class)\s/.test(trimmed)) { lastWasEmpty = false; continue; }
            if (/^\s*[\{\}\[\]];?\s*$/.test(trimmed)) { lastWasEmpty = false; continue; }  // Just braces
            if (/^(Added|Removed|Modified)\s+\d+\s+line/.test(trimmed)) { lastWasEmpty = false; continue; }
            // Skip lines that look like code (lots of special chars)
            if ((trimmed.match(/[{}();=><]/g) || []).length > 3) { lastWasEmpty = false; continue; }

            if (currentParagraph) {
                // Continue the paragraph
                currentParagraph += ' ' + trimmed;
            }
            // If no current paragraph but this looks like Claude text (starts with - bullet), start new
            else if (/^-\s+[A-Z]/.test(trimmed)) {
                currentParagraph = trimmed;
            }
            lastWasEmpty = false;
            continue;
        }

        // Non-indented, non-⏺ line that's not noise: ends current paragraph
        if (currentParagraph) {
            paragraphs.push(currentParagraph);
            currentParagraph = null;
        }
        lastWasEmpty = false;
    }

    // Don't forget the last paragraph
    if (currentParagraph) paragraphs.push(currentParagraph);

    // Take the last few paragraphs (most recent Claude text)
    if (paragraphs.length > 0) {
        const recent = paragraphs.slice(-3);
        let summary = recent.join(' ');
        if (summary.length > 800) {
            summary = '...' + summary.substring(summary.length - 797);
        }
        return summary;
    }
    return null;
}

// Extract user's prompt from tmux (❯ lines)
function extractUserPrompt(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    // Find the most recent user prompt (❯ followed by text)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Look for prompt markers followed by actual user text
        // Skip empty prompts and suggestion lines
        const promptMatch = line.match(/[❯>]\s+(.+)/);
        if (promptMatch) {
            let text = promptMatch[1].trim();
            // Skip if it looks like a suggestion (dim text) or UI
            if (text.length < 3) continue;
            if (/^─+$/.test(text)) continue;
            if (/^\d+\s+file/.test(text)) continue;
            // This looks like a real user prompt
            if (text.length > 50) {
                text = '...' + text.substring(text.length - 47);
            }
            return text;
        }
    }
    return null;
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
        // Launch Claude normally (interactive mode) - user can see the terminal
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
                // Capture more history (-S -200 = start 200 lines back)
                const raw = execSync(
                    `tmux capture-pane -t "${activeSession}" -p -e -S -200 2>/dev/null`,
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

                // Extract structured data for CLEAN mode
                let cleanData;
                const transcriptPath = findTranscriptFile(activeSession);
                if (transcriptPath) {
                    cleanData = extractCleanDataFromTranscript(transcriptPath);
                } else {
                    cleanData = { userCmd: '', summary: '', status: 'Ready', lastTool: '' };
                }

                // Override with real-time data from tmux (JSONL is delayed during streaming)
                const realtimeStatus = extractRealtimeStatus(raw);
                if (realtimeStatus) {
                    cleanData.status = realtimeStatus;
                }

                const realtimeTool = extractRealtimeTool(raw);
                if (realtimeTool) {
                    cleanData.lastTool = realtimeTool;
                }

                const realtimeText = extractRealtimeText(raw);
                if (realtimeText) {
                    cleanData.summary = realtimeText;
                }

                // Extract user prompt from tmux if not found in JSONL
                if (!cleanData.userCmd || cleanData.userCmd.length < 5) {
                    const userPrompt = extractUserPrompt(raw);
                    if (userPrompt) {
                        cleanData.userCmd = userPrompt;
                    }
                }

                // Debug: log cleanData
                console.log('CLEAN:', JSON.stringify(cleanData));

                if (cleanData) msg.cleanData = cleanData;

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
