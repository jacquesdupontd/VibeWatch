const { execSync } = require('child_process');
const raw = execSync('tmux capture-pane -t vibecoder -p -S -100', { encoding: 'utf8' });
const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
const lines = cleaned.split('\n');

const paragraphs = [];

for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip UI noise
    if (/^[-=─━]{3,}/.test(trimmed)) continue;
    if (/^[●✢✳✶·❯⎿]/.test(trimmed)) continue;
    if (/^\d+\s+files?\s+\+/.test(trimmed)) continue;

    if (trimmed.startsWith('⏺')) {
        // Check if tool call
        const isTool = /^⏺\s*(Read|Write|Edit|Update|Bash|Grep|Glob|Task|WebFetch|WebSearch|LSP|NotebookEdit)\s*[\(\d]/i.test(trimmed);
        const isToolSummary = /^⏺\s*(Read|Edit|Write|Bash|Grep|Glob)\s+\d+\s+(file|line)/i.test(trimmed);

        if (isTool || isToolSummary) {
            console.log('FILTERED:', trimmed.substring(0, 70) + '...');
        } else {
            const text = trimmed.replace(/^⏺\s*/, '');
            console.log('KEPT:', text.substring(0, 70) + (text.length > 70 ? '...' : ''));
            paragraphs.push(text);
        }
    }
}

console.log('\n=== LAST 3 PARAGRAPHS (what watch shows) ===');
paragraphs.slice(-3).forEach((p, i) => console.log(i+1 + ':', p.substring(0, 100)));
