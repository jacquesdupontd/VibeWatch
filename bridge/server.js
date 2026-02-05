const { execSync, exec } = require('child_process');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findActiveJsonl, parseRecentJsonl, extractCleanData } = require('./parse-jsonl');

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
// Remove ALL emojis - comprehensive Unicode ranges
function removeEmojis(str) {
    return str
        // Emoticons: 😀-🙏
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
        // Symbols & Pictographs: 🌀-🗿
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
        // Transport & Map: 🚀-🛿
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
        // Supplemental Symbols: 🤀-🧿
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
        // Misc Symbols: ☀-⛿
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        // Dingbats: ✀-➿
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        // Enclosed Alphanumerics: ⓪-🅿
        .replace(/[\u{24C2}-\u{1F251}]/gu, '')
        // Flags: 🇦-🇿
        .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
        // Variation Selectors
        .replace(/[\uFE00-\uFE0F]/g, '')
        // Zero Width Joiner
        .replace(/\u200D/g, '');
}

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

function stripAccents(str) {
    if (!str) return str;
    // Replace common French accents with ASCII equivalents
    return str
        .replace(/à|á|â|ä|ã|å/g, 'a')
        .replace(/À|Á|Â|Ä|Ã|Å/g, 'A')
        .replace(/ç/g, 'c')
        .replace(/Ç/g, 'C')
        .replace(/è|é|ê|ë/g, 'e')
        .replace(/È|É|Ê|Ë/g, 'E')
        .replace(/ì|í|î|ï/g, 'i')
        .replace(/Ì|Í|Î|Ï/g, 'I')
        .replace(/ñ/g, 'n')
        .replace(/Ñ/g, 'N')
        .replace(/ò|ó|ô|ö|õ/g, 'o')
        .replace(/Ò|Ó|Ô|Ö|Õ/g, 'O')
        .replace(/ù|ú|û|ü/g, 'u')
        .replace(/Ù|Ú|Û|Ü/g, 'U')
        .replace(/ý|ÿ/g, 'y')
        .replace(/Ý/g, 'Y');
}

function formatForClean(text) {
    if (!text) return text;
    let t = text.replace(/\r/g, '');
    // Remove markdown bold/italic markers
    t = t.replace(/\*\*/g, '').replace(/\*/g, '');
    // Normalize bullet styles to "- "
    t = t.replace(/^\s*[•–—]\s+/gm, '- ');
    // Keep line breaks, but cap excessive blank lines
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
}

function clampText(str, maxLen) {
    if (!str) return str;
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
}

function clampTextEnd(str, maxLen) {
    if (!str) return str;
    if (str.length <= maxLen) return str;
    return '...' + str.substring(str.length - (maxLen - 3));
}

function firstLineWithEllipsis(str, maxLen) {
    if (!str) return str;
    const parts = str.split('\n');
    let line = parts[0] || '';
    let hasMore = parts.length > 1;
    if (line.length > maxLen) {
        line = '...' + line.substring(line.length - (maxLen - 3));
    }
    if (hasMore) {
        if (line.length + 4 > maxLen) {
            line = line.substring(0, Math.max(0, maxLen - 4)) + '...';
        } else {
            line = line + ' ...';
        }
    }
    return line;
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

function detectSuggestionFromTmux(raw) {
    if (!raw) return null;
    const rawLines = raw.split('\n');
    for (let i = rawLines.length - 1; i >= 0; i--) {
        const rl = rawLines[i];
        if (!rl.includes('❯') && !rl.includes('>')) continue;
        // Claude ghost suggestion is usually dim
        if (rl.includes('\x1b[2m') || rl.includes('\x1b[0;2m')) {
            let newSug = clean(rl).trim();
            if (newSug.startsWith('> ')) newSug = newSug.substring(2).trim();
            if (newSug.startsWith('❯ ')) newSug = newSug.substring(2).trim();
            if (newSug && newSug.length > 2) return newSug;
        }
        break;
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

// Format tool_use into compact string - ASCII only for Pebble compatibility
function formatToolUse(name, input) {
    switch (name) {
        case 'Bash': {
            let cmd = input?.command || '';
            cmd = cmd.replace(/cd\s+[^\s&|;]+\s*[;&|]*\s*/g, '').trim();
            if (cmd.length > 35) cmd = cmd.substring(0, 32) + '...';
            return '$ ' + (cmd || 'running');
        }
        case 'Read': return 'READ ' + (input?.file_path || '').split('/').pop();
        case 'Write': return 'WRITE ' + (input?.file_path || '').split('/').pop();
        case 'Edit': return 'EDIT ' + (input?.file_path || '').split('/').pop();
        case 'Grep': return 'GREP "' + (input?.pattern || '').substring(0, 20) + '"';
        case 'Glob': return 'GLOB ' + (input?.pattern || '');
        case 'Task': return 'AGENT ' + (input?.description || '').substring(0, 25);
        case 'WebFetch': return 'FETCH ' + (input?.url || '').substring(0, 25);
        case 'WebSearch': return 'SEARCH "' + (input?.query || '').substring(0, 20) + '"';
        default: return name.toUpperCase();
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
                    // Don't truncate - let the watch handle display
                    // User wants to see FULL text they typed/dictated
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
            } catch (e) { }
        }

        return { userCmd, summary, status, lastTool };
    } catch (e) {
        console.log('Transcript error:', e.message);
        return { userCmd: '', summary: 'Error: ' + e.message, status: 'Error' };
    }
}

// TASK detection words - these indicate active work, not thinking
const TASK_WORDS = [
    'Creating', 'Writing', 'Reading', 'Editing', 'Building', 'Installing',
    'Processing', 'Compiling', 'Running', 'Checking', 'Loading', 'Updating',
    'Searching', 'Downloading', 'Uploading', 'Generating', 'Analyzing'
];

// Extract real-time status from tmux (fun words like Cogitating, Baking, etc.)
function extractRealtimeStatus(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    // Check last 30 lines for status patterns
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Pattern 1: Any "Word..." or "Word…" (thinking indicator)
        const thinkMatch = line.match(/[·✳✶✽*]?\s*([A-Z][a-z]+)(\.{3}|…)/);
        if (thinkMatch) {
            const word = thinkMatch[1];
            // Skip task words (handled separately)
            if (!TASK_WORDS.includes(word)) {
                return word + '...';
            }
        }

        // Pattern 2: "Word for Xs" (done indicator)
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

// Extract active TASK from tmux (Creating README.md..., Writing file..., etc.)
// Returns: { isTask: true, name: "Creating README.md", time: "51s" } or null
function extractActiveTask(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Skip system noise - hooks, internal messages
        if (/hook/i.test(line)) continue;
        if (/PostToolUse|PreToolUse/i.test(line)) continue;
        if (/Running\s+\S+hook/i.test(line)) continue;

        // Pattern: "Creating README.md... (51s · ↓ 814 tokens)" or "· Creating file..."
        // Note: "Running" is intentionally NOT in this list - too many false positives
        const taskMatch = line.match(/[·✳✶✽*]?\s*(Creating|Writing|Reading|Editing|Building|Installing|Processing|Compiling|Generating|Analyzing|Downloading|Uploading)\s+([^.…\(]+)(\.{3}|…)\s*(\((\d+[ms]?))?/i);
        if (taskMatch) {
            const action = taskMatch[1];
            let target = taskMatch[2].trim();
            const time = taskMatch[5] || '';

            // Skip if target looks like system noise
            if (/hook|tool|message/i.test(target)) continue;

            // Clean up target name
            if (target.length > 25) target = target.substring(0, 22) + '...';

            return {
                isTask: true,
                name: action + ' ' + target,
                time: time
            };
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

// Extract assistant text from JSONL transcript (CLEAN approach)
// Much cleaner than parsing tmux terminal output
function extractTextFromJSONL(sessionPath) {
    try {
        const projectDir = getProjectDir(sessionPath);
        if (!projectDir) return null;

        // Find most recent JSONL file
        const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtime }))
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) return null;

        const jsonlPath = path.join(projectDir, files[0].name);
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');

        // Get last few assistant messages with text content
        const textParts = [];
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'assistant' && entry.message?.content) {
                    // Extract text blocks from content array
                    for (const block of entry.message.content) {
                        if (block.type === 'text' && block.text) {
                            // Clean up the text - remove markdown formatting but PRESERVE newlines
                            let text = block.text
                                .replace(/\*\*/g, '')  // Remove bold
                                .replace(/`/g, '')     // Remove code ticks
                                .replace(/\n{3,}/g, '\n\n');  // Max 2 consecutive newlines
                            // Remove ALL emojis comprehensively
                            text = removeEmojis(text);
                            // Remove remaining non-ASCII (except newlines)
                            text = text.replace(/[^\x20-\x7E\n]/g, '').trim();
                            if (text.length > 20) {
                                textParts.unshift(text);
                            }
                        }
                    }
                    // Get last 2-3 messages worth of text
                    if (textParts.length >= 3) break;
                }
            } catch (e) { /* skip malformed lines */ }
        }

        if (textParts.length > 0) {
            let summary = textParts.join('\n');  // Join with newlines to preserve structure
            // Remove ALL emojis one more time (double-check)
            summary = removeEmojis(summary);
            summary = summary.replace(/[^\x20-\x7E\n]/g, '');  // Remove any remaining non-ASCII
            // Show END of text (most recent)
            if (summary.length > 800) {
                summary = '...' + summary.substring(summary.length - 797);
            }
            return summary;
        }
    } catch (e) {
        console.error('JSONL extraction error:', e.message);
    }
    return null;
}

// Get Claude project directory from session working directory
function getProjectDir(sessionPath) {
    try {
        // Encode path like Claude does: /Users/foo/bar -> -Users-foo-bar
        const encoded = sessionPath.replace(/\//g, '-').replace(/^-/, '-');
        const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
        if (fs.existsSync(projectDir)) {
            return projectDir;
        }
    } catch (e) { }
    return null;
}

// Get working directory of a tmux session
function getSessionCwd(sessionName) {
    try {
        return execSync(
            `tmux display-message -t "${sessionName}" -p "#{pane_current_path}" 2>/dev/null`,
            { encoding: 'utf8' }
        ).trim();
    } catch (e) {
        return null;
    }
}

// Fallback: Extract from tmux if JSONL not available
function extractRealtimeText(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');
    const paragraphs = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith('⏺')) continue;

        // Skip tool calls
        if (/^⏺\s*(Read|Write|Edit|Update|Bash|Grep|Glob|Task|WebFetch|WebSearch|LSP|NotebookEdit)\s*[\(\d]/i.test(trimmed)) continue;
        if (/^⏺\s*(Read|Edit|Write|Bash|Grep|Glob|Searched|Found)\s+\d+/i.test(trimmed)) continue;
        if (/\(ctrl\+[a-z]\s+to/i.test(trimmed)) continue;

        const text = trimmed.replace(/^⏺\s*/, '').trim();
        if (text.length > 10) paragraphs.push(text);
    }

    if (paragraphs.length > 0) {
        const recent = paragraphs.slice(-3);
        let summary = recent.join('\n');  // Join with newlines to preserve structure
        // Remove ALL emojis comprehensively
        summary = removeEmojis(summary);
        // Remove remaining non-ASCII chars (except newlines)
        summary = summary.replace(/[^\x20-\x7E\n]/g, '');
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

        // Skip system noise
        if (/hook|PostToolUse|PreToolUse/i.test(line)) continue;
        if (/Running\s+\S+hook/i.test(line)) continue;
        if (/esc to interrupt|ctrl\+/i.test(line)) continue;

        // Look for prompt markers followed by actual user text
        // Skip empty prompts and suggestion lines
        const promptMatch = line.match(/[❯>]\s+(.+)/);
        if (promptMatch) {
            let text = promptMatch[1].trim();
            // Skip if it looks like a suggestion (dim text) or UI
            if (text.length < 3) continue;
            if (/^─+$/.test(text)) continue;
            if (/^\d+\s+file/.test(text)) continue;
            if (/hook|Running\s/i.test(text)) continue;
            // This looks like a real user prompt - don't truncate
            return text;
        }
    }
    return null;
}

// ============================================================
// STREAM-JSON PARSING (for Claude launched with --output-format stream-json)
// ============================================================

// Parse Claude's stream-json output from tmux capture
// Returns: { summary, status, lastTool, userPrompt, suggestion }
function parseStreamJSON(raw) {
    const result = {
        summary: '',
        status: 'Ready',
        lastTool: '',
        userPrompt: '',
        suggestion: null
    };

    // Clean ANSI codes
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    const textParts = [];
    let lastToolUse = null;
    let isThinking = false;

    // Parse each line as potential JSON
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;

        try {
            const event = JSON.parse(trimmed);

            // Assistant message with content
            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    // Text content
                    if (block.type === 'text' && block.text) {
                        let text = block.text
                            .replace(/\*\*/g, '')  // Remove markdown bold
                            .replace(/`/g, '')     // Remove code ticks
                            .replace(/\n+/g, ' ')  // Newlines to spaces
                            .trim();
                        if (text.length > 10) {
                            textParts.push(text);
                        }
                    }
                    // Tool use
                    if (block.type === 'tool_use' && block.name) {
                        lastToolUse = formatToolUse(block.name, block.input);
                    }
                }

                // Check stop_reason for status
                if (event.message.stop_reason === 'end_turn') {
                    result.status = 'Done';
                    isThinking = false;
                } else if (event.message.stop_reason === 'tool_use') {
                    result.status = 'Working...';
                }
            }

            // Thinking/streaming indicator (content_block_start with thinking)
            if (event.type === 'content_block_start') {
                isThinking = true;
            }

            // User message (human turn)
            if (event.type === 'human' || (event.type === 'user' && event.message)) {
                const content = event.message?.content || event.content;
                if (typeof content === 'string' && content.length > 3) {
                    result.userPrompt = content;
                } else if (Array.isArray(content)) {
                    for (const item of content) {
                        if (item.type === 'text' && item.text) {
                            result.userPrompt = item.text;
                            break;
                        }
                    }
                }
            }

        } catch (e) {
            // Not valid JSON, might be regular terminal output
            // Check for thinking words in non-JSON lines
            const thinkMatch = trimmed.match(/[·✳✶✽*]?\s*([A-Z][a-z]+)(\.{3}|…)/);
            if (thinkMatch && !STATUS_BLACKLIST.includes(thinkMatch[1])) {
                result.status = thinkMatch[1] + '...';
                isThinking = true;
            }
        }
    }

    // Build summary from text parts (show most recent)
    if (textParts.length > 0) {
        const recent = textParts.slice(-3);
        result.summary = recent.join(' ');
        if (result.summary.length > 800) {
            result.summary = '...' + result.summary.substring(result.summary.length - 797);
        }
    }

    if (lastToolUse) {
        result.lastTool = lastToolUse;
    }

    // Truncate user prompt
    if (result.userPrompt && result.userPrompt.length > 50) {
        result.userPrompt = '...' + result.userPrompt.substring(result.userPrompt.length - 47);
    }

    return result;
}

// Detect if tmux output contains stream-json format
function isStreamJSONOutput(raw) {
    const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    // Check if we have JSON lines with Claude event types
    let jsonCount = 0;
    for (const line of lines.slice(-50)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const obj = JSON.parse(trimmed);
                if (obj.type && ['assistant', 'user', 'human', 'result', 'init'].includes(obj.type)) {
                    jsonCount++;
                }
            } catch (e) { }
        }
    }
    return jsonCount >= 3;  // At least 3 JSON events = stream-json mode
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
                // NEW APPROACH: Read .jsonl file directly for structured data
                const jsonlPath = findActiveJsonl(activeSession);
                let cleanData;
                let suggestion = null;

                if (jsonlPath) {
                    console.log('[JSONL] Using direct .jsonl parsing (clean & structured)');
                    const events = parseRecentJsonl(jsonlPath, 300);
                    cleanData = extractCleanData(events);

                    // Add structured info
                    cleanData = {
                        userCmd: cleanData.userCmd || '',
                        summary: cleanData.claudeText || '',
                        status: cleanData.status || 'Ready',
                        lastTool: cleanData.lastTool || '',
                        activeTask: cleanData.activeTask || ''
                    };

                    // Capture terminal ONLY for thinking word (status) and interactive prompts
                    try {
                        const raw = execSync(
                            `tmux capture-pane -t "${activeSession}" -p -e -S -50 2>/dev/null`,
                            { encoding: 'utf8', timeout: 1000 }
                        );
                        const realtimeStatus = extractRealtimeStatus(raw);
                        if (realtimeStatus) {
                            cleanData.status = realtimeStatus;
                            console.log('[REALTIME STATUS]', realtimeStatus);
                        }
                        const prompt = detectPrompt(raw);
                        if (prompt) {
                            cleanData.prompt = prompt;
                            console.log('[PROMPT] Detected:', JSON.stringify(prompt));
                        }
                        const sug = detectSuggestionFromTmux(raw);
                        if (sug) {
                            cleanData.suggestion = sug;
                            console.log('[SUGGESTION] Detected:', JSON.stringify(sug));
                        }
                    } catch (e) { }

                } else {
                    // FALLBACK: Use tmux capture if .jsonl not found
                    console.log('[JSONL] Fallback to tmux capture');
                    const raw = execSync(
                        `tmux capture-pane -t "${activeSession}" -p -e -S -200 2>/dev/null`,
                        { encoding: 'utf8', timeout: 2000 }
                    );

                    const isStreamJSON = isStreamJSONOutput(raw);
                    if (isStreamJSON) {
                        cleanData = parseStreamJSON(raw);
                        if (cleanData.suggestion) suggestion = cleanData.suggestion;
                    } else {
                        // Regular Claude session with no JSONL yet (or other session)
                        cleanData = { userCmd: '', summary: '', status: 'Ready', lastTool: '', activeTask: '' };

                        const realtimeText = extractRealtimeText(raw);
                        if (realtimeText) cleanData.summary = realtimeText;

                        const realtimeStatus = extractRealtimeStatus(raw);
                        if (realtimeStatus) cleanData.status = realtimeStatus;

                        const realtimeTool = extractRealtimeTool(raw);
                        if (realtimeTool) cleanData.lastTool = realtimeTool;

                        // Detect prompt
                        const prompt = detectPrompt(raw);
                        if (prompt) cleanData.prompt = prompt;

                        // Detect suggestion
                        const sug = detectSuggestionFromTmux(raw);
                        if (sug) suggestion = sug;
                    }
                }

                // 1. Ensure we have a summary to avoid black screen
                if (!cleanData.summary) {
                    if (cleanData.lastTool) {
                        cleanData.summary = `[Active] Tool: ${cleanData.lastTool}`;
                    } else if (cleanData.status && cleanData.status !== 'Ready') {
                        cleanData.summary = `[${cleanData.status}]...`;
                    } else {
                        cleanData.summary = "[No active data in this session]";
                    }
                }

                // Normalize accents and preserve bullets/newlines for CLEAN mode
                cleanData.summary = stripAccents(formatForClean(cleanData.summary));
                cleanData.userCmd = stripAccents(cleanData.userCmd || '');
                cleanData.lastTool = stripAccents(cleanData.lastTool || '');
                cleanData.status = stripAccents(cleanData.status || '');
                cleanData.activeTask = stripAccents(cleanData.activeTask || '');
                cleanData.suggestion = stripAccents(cleanData.suggestion || '');

                // Clamp to avoid AppMessage overflow
                cleanData.summary = clampTextEnd(cleanData.summary, 700);
                cleanData.userCmd = firstLineWithEllipsis(cleanData.userCmd, 160);
                cleanData.lastTool = clampText(cleanData.lastTool, 80);
                cleanData.status = clampText(cleanData.status, 40);
                cleanData.activeTask = clampText(cleanData.activeTask, 80);
                cleanData.suggestion = clampText(cleanData.suggestion, 120);

                // If status is stuck on Working but no active task/tool, mark Ready
                if (cleanData.status &&
                    cleanData.status.toLowerCase().includes('working') &&
                    !cleanData.activeTask && !cleanData.lastTool) {
                    // Don't override JSONL thinking words like "Razzle-dazzling..."
                    if (!cleanData.status.endsWith('...') &&
                        cleanData.summary && cleanData.summary.length > 0) {
                        cleanData.status = 'Ready';
                    }
                }

                const msg = { type: 'output', content: cleanData.summary, cleanData };
                if (suggestion) msg.suggestion = suggestion;
                if (cleanData.prompt) msg.prompt = cleanData.prompt;

                const msgStr = JSON.stringify(msg);
                // ALWAYS send if msg has changed
                if (msgStr !== lastSent) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(msgStr);
                        console.log(`[BRIDGE] Sent update for '${activeSession}' (${cleanData.summary.substring(0, 30)}...)`);
                    }
                    lastSent = msgStr;
                }
            } catch (e) {
                console.error('[POLL ERROR]', e.message);
            }
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
