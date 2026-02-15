// Parse Claude Code .jsonl transcript directly for clean, structured data
const fs = require('fs');
const path = require('path');

// Find the active .jsonl file for a session
// Find the active .jsonl file for a session
function findActiveJsonl(sessionName) {
    try {
        const { execSync } = require('child_process');
        const projectsDir = path.join(require('os').homedir(), '.claude', 'projects');

        // 1. Get the CWD of the tmux session
        let sessionCwd = '';
        try {
            sessionCwd = execSync(
                `tmux display-message -t "${sessionName}" -p "#{pane_current_path}" 2>/dev/null`,
                { encoding: 'utf8' }
            ).trim();
        } catch (e) {
            // Session might not exist or be reachable
        }

        // 2. Construct expected Claude folder name: /path/to/dir -> -path-to-dir
        let expectedFolder = '';
        if (sessionCwd) {
            expectedFolder = sessionCwd.replace(/\//g, '-');
            // Claude sometimes keeps the leading dash, sometimes not, but usually path starts with / so replacement starts with -
            // If path is /Users/foo, it becomes -Users-foo. 
        }

        const allFolders = fs.readdirSync(projectsDir);
        let targetFolder = null;

        // 3. High-precision matching (CWD based)
        if (expectedFolder) {
            // Exact match (best)
            targetFolder = allFolders.find(f => f === expectedFolder);

            // If not found, try containing match (often safer if slight path variations)
            if (!targetFolder) {
                targetFolder = allFolders.find(f => f.includes(expectedFolder));
            }
        }

        // 4. Fallback: match session name directly (only if CWD method failed)
        // STRICTER match: folder must include session name
        if (!targetFolder && sessionName) {
            targetFolder = allFolders.find(f => f.toLowerCase().includes(sessionName.toLowerCase()));
        }

        if (!targetFolder) return null;

        const folderPath = path.join(projectsDir, targetFolder);
        const files = fs.readdirSync(folderPath)
            .filter(f => f.endsWith('.jsonl') && !f.includes('subagents'));

        if (files.length === 0) return null;

        // Return the most recent one
        let newest = files[0];
        let newestTime = 0;
        for (const f of files) {
            const fpath = path.join(folderPath, f);
            const stat = fs.statSync(fpath);
            if (stat.mtimeMs > newestTime) {
                newestTime = stat.mtimeMs;
                newest = f;
            }
        }

        const jsonlPath = path.join(folderPath, newest);
        console.log(`[JSONL] Resolved session '${sessionName}' -> ${jsonlPath}`);
        return jsonlPath;
    } catch (e) {
        console.error('[JSONL] Error finding file:', e.message);
        return null;
    }
}

// Parse the last N lines of the .jsonl file
function parseRecentJsonl(jsonlPath, maxLines = 100) {
    try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');

        // Take last N lines
        const recentLines = lines.slice(-maxLines);

        // Parse each line as JSON
        const events = [];
        for (const line of recentLines) {
            if (!line.trim()) continue;
            try {
                const json = JSON.parse(line);
                events.push(json);
            } catch (e) {
                // Skip malformed lines
            }
        }

        return events;
    } catch (e) {
        console.error('[JSONL] Error reading file:', e.message);
        return [];
    }
}

// Extract clean data from parsed events
function extractCleanData(events) {
    console.log(`[JSONL] Processing ${events.length} events`);

    const result = {
        claudeText: '',
        lastTool: '',
        userCmd: '',
        status: 'Ready',
        activeTask: '',
        suggestion: '',
        isConfirmedReady: false
    };

    // Process events in reverse (most recent first)
    const reversedEvents = [...events].reverse();

    // Find ONLY the most recent complete assistant message (not mixed history)
    for (const event of reversedEvents) {
        if (event.type === 'assistant' && event.message?.content && Array.isArray(event.message.content)) {
            const textBlocks = [];
            for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                    textBlocks.push(block.text);
                }
            }
            // Take ONLY this message if it has text
            if (textBlocks.length > 0) {
                result.claudeText = textBlocks.join('\n\n');
                console.log(`[JSONL] Extracted Claude text: ${result.claudeText.substring(0, 100)}... (${result.claudeText.length} chars)`);
                break; // Stop after first complete message
            }
        }
    }

    // Status / task from most recent assistant message, progress, or thinking
    let doneTurn = false;
    let latestAssistantMsg = null;
    let latestStopReason = null;
    for (const event of reversedEvents) {
        if (event.type === 'progress' && event.data?.label) {
            result.activeTask = event.data.label;
            result.status = event.data.label;
            break;
        }

        if (event.type === 'assistant' && event.message?.content && Array.isArray(event.message.content)) {
            const msg = event.message;
            latestAssistantMsg = msg;
            latestStopReason = msg.stop_reason;

            if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') {
                result.status = 'Ready';
                result.activeTask = '';
                doneTurn = true;
            }

            for (const block of msg.content) {
                if (block.type === 'thinking' && block.thinking) {
                    const match = block.thinking.match(/[·✳✶✽*⏺-]?\s*([A-Z][a-z]+)(\.{3}|…)/);
                    if (match) {
                        result.status = match[1] + '...';
                        result.activeTask = match[1] + '...';
                        break;
                    }
                }
            }
            break;
        }
    }

    // Find tool_use from recent assistant messages (search last 10, not just the latest)
    let toolFound = false;
    for (const event of reversedEvents) {
        if (toolFound) break;
        if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;

        for (const block of event.message.content) {
            if (block.type === 'tool_use') {
                result.lastTool = formatToolUse(block.name, block.input);

                // Detect AskUserQuestion - extract question + options
                if (block.name === 'AskUserQuestion' && block.input?.questions) {
                    const q = block.input.questions[0];
                    if (q) {
                        const opts = (q.options || []).slice(0, 4).map((o, i) => ({
                            num: i + 1,
                            label: (o.label || '').substring(0, 20)
                        }));
                        result.askUserQuestion = {
                            question: q.question || '',
                            options: opts
                        };
                    }
                }

                // Only mark running if this is the latest msg AND stop_reason indicates tool_use
                if (event.message === latestAssistantMsg) {
                    const isRunningTurn = !doneTurn &&
                        (latestStopReason === 'tool_use' || latestStopReason === null || latestStopReason === undefined);

                    if (isRunningTurn) {
                        const hasResult = reversedEvents.some(e =>
                            Array.isArray(e.message?.content) && e.message.content.some(b =>
                                b.type === 'tool_result' && b.tool_use_id === block.id
                            )
                        );
                        if (!hasResult) {
                            result.activeTask = getTaskFromTool(block.name, block.input);
                            result.status = 'Working...';
                        }
                    }
                }
                toolFound = true;
                break;
            }
        }
    }

    // If the latest turn is done, clear running task
    if (doneTurn) {
        result.activeTask = '';
        result.status = 'Ready';
        // Confirmed ready = end_turn AND last event is NOT a user message (no new prompt pending)
        const lastEvent = events[events.length - 1];
        result.isConfirmedReady = !(lastEvent && lastEvent.type === 'user');
    }

    // Find most recent user message
    for (const event of reversedEvents) {
        if (event.type === 'user' && event.message?.content) {
            const content = event.message.content;
            if (typeof content === 'string') {
                const text = content.trim();
                // Skip Claude continuation system summary
                if (!text.startsWith('This session is being continued from a previous conversation')) {
                    result.userCmd = text;
                }
            } else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        const text = block.text.trim();
                        if (!text.startsWith('This session is being continued from a previous conversation')) {
                            result.userCmd = text;
                            break;
                        }
                    }
                    // User answered Claude's AskUserQuestion
                    if (block.type === 'tool_result' && typeof block.content === 'string' &&
                        block.content.startsWith('User has answered')) {
                        const match = block.content.match(/="([^"]+)"/);
                        if (match) {
                            result.userCmd = match[1];
                            break;
                        }
                    }
                }
            }
            if (result.userCmd) break;
        }
    }

    console.log('[JSONL] Result:', JSON.stringify({
        claudeTextLen: result.claudeText.length,
        lastTool: result.lastTool,
        userCmd: result.userCmd,
        status: result.status,
        activeTask: result.activeTask
    }));

    return result;
}

// Format tool_use into readable string
function formatToolUse(name, input) {
    switch (name) {
        case 'Bash':
            return `$ ${input?.command || ''}`;
        case 'Read':
            return `Read ${path.basename(input?.file_path || '')}`;
        case 'Edit':
            return `Edit ${path.basename(input?.file_path || '')}`;
        case 'Write':
            return `Write ${path.basename(input?.file_path || '')}`;
        case 'Grep':
            return `Grep "${input?.pattern || ''}"`;
        case 'Task':
            return `Task: ${input?.description || ''}`;
        case 'TaskCreate':
            return `Task: ${input?.subject || ''}`;
        case 'TaskUpdate':
            return `Task: ${input?.status || ''} ${input?.subject || ''}`;
        default:
            return name;
    }
}

// Get active task description from tool
function getTaskFromTool(name, input) {
    switch (name) {
        case 'Bash':
            const cmd = input?.command || '';
            if (cmd.includes('build')) return 'Building...';
            if (cmd.includes('install')) return 'Installing...';
            if (cmd.includes('test')) return 'Testing...';
            return 'Running command...';
        case 'Read':
            return 'Reading file...';
        case 'Edit':
            return 'Editing file...';
        case 'Write':
            return 'Writing file...';
        case 'Task':
            return input?.description || 'Running task...';
        case 'TaskCreate':
            return input?.activeForm || input?.subject || 'Creating task...';
        case 'TaskUpdate':
            return input?.activeForm || 'Updating task...';
        default:
            return `${name}...`;
    }
}

module.exports = {
    findActiveJsonl,
    parseRecentJsonl,
    extractCleanData
};
