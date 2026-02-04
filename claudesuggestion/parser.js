/**
 * Claude Code Stream Parser for Pebble Watch
 * 
 * Parses Claude Code's --output-format stream-json NDJSON output
 * and extracts only watch-worthy events: user prompts, tool uses,
 * tool results (compact), and assistant summaries.
 * 
 * NO code content, NO verbose logging — just what fits on a watch.
 */

class ClaudeStreamParser {
  constructor() {
    this.currentToolName = null;
    this.currentToolId = null;
    this.currentToolInput = '';
    this.currentText = '';
    this.sessionId = null;
    this.events = [];
    this.listeners = new Set();
  }

  /**
   * Subscribe to parsed watch events
   */
  onEvent(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  _emit(event) {
    const stamped = { ...event, timestamp: Date.now() };
    this.events.push(stamped);
    // Keep only last 100 events
    if (this.events.length > 100) this.events.shift();
    for (const cb of this.listeners) {
      try { cb(stamped); } catch (e) { console.error('Listener error:', e); }
    }
  }

  /**
   * Parse a single NDJSON line from Claude Code stream-json output
   */
  parseLine(line) {
    if (!line || !line.trim()) return null;

    let data;
    try {
      data = JSON.parse(line.trim());
    } catch (e) {
      return null; // Skip malformed lines
    }

    return this._processEvent(data);
  }

  _processEvent(data) {
    const type = data.type;

    // ─── System init ───────────────────────────────────
    if (type === 'system' && data.subtype === 'init') {
      this.sessionId = data.session_id;
      const toolCount = data.tools?.length || 0;
      const mcpCount = data.mcp_servers?.length || 0;
      this._emit({
        type: 'init',
        icon: '●',
        label: 'Claude Code',
        detail: `${toolCount} tools${mcpCount ? `, ${mcpCount} MCP` : ''}`,
        color: 'green',
      });
      return;
    }

    // ─── User message ──────────────────────────────────
    if (type === 'user') {
      const content = this._extractUserText(data.message);
      if (content) {
        this._emit({
          type: 'user',
          icon: '›',
          label: this._truncate(content, 80),
          detail: null,
          color: 'white',
        });
      }
      return;
    }

    // ─── Assistant message (complete) ──────────────────
    if (type === 'assistant') {
      const blocks = data.message?.content || [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          // Only emit the first meaningful line as summary
          const summary = this._getFirstLine(block.text);
          if (summary && summary.length > 5) {
            this._emit({
              type: 'assistant',
              icon: '◆',
              label: this._truncate(summary, 80),
              detail: null,
              color: 'cyan',
            });
          }
        }
        if (block.type === 'tool_use') {
          this._emitToolUse(block.name, block.input);
        }
        if (block.type === 'tool_result') {
          this._emitToolResult(block);
        }
      }
      return;
    }

    // ─── Stream events (real-time deltas) ──────────────
    if (type === 'stream_event') {
      this._processStreamEvent(data.event);
      return;
    }

    // ─── Result (session complete) ─────────────────────
    if (type === 'result') {
      const cost = data.total_cost_usd
        ? `$${data.total_cost_usd.toFixed(4)}`
        : '';
      const turns = data.num_turns || 0;
      this._emit({
        type: 'result',
        icon: '■',
        label: data.subtype === 'success' ? 'Done' : `Error: ${data.subtype}`,
        detail: `${turns} turns ${cost}`.trim(),
        color: data.subtype === 'success' ? 'green' : 'red',
      });
      return;
    }
  }

  _processStreamEvent(event) {
    if (!event) return;
    const eventType = event.type;

    // Tool use starting
    if (eventType === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use') {
        this.currentToolName = block.name;
        this.currentToolId = block.id;
        this.currentToolInput = '';
      }
      if (block?.type === 'text') {
        this.currentText = '';
      }
    }

    // Accumulate deltas
    if (eventType === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'input_json_delta') {
        this.currentToolInput += delta.partial_json || '';
      }
      if (delta?.type === 'text_delta') {
        this.currentText += delta.text || '';
      }
    }

    // Content block finished
    if (eventType === 'content_block_stop') {
      if (this.currentToolName) {
        let input = {};
        try { input = JSON.parse(this.currentToolInput); } catch (e) { /* ignore */ }
        this._emitToolUse(this.currentToolName, input);
        this.currentToolName = null;
        this.currentToolId = null;
        this.currentToolInput = '';
      }
      if (this.currentText) {
        const summary = this._getFirstLine(this.currentText);
        if (summary && summary.length > 5) {
          this._emit({
            type: 'assistant',
            icon: '◆',
            label: this._truncate(summary, 80),
            detail: null,
            color: 'cyan',
          });
        }
        this.currentText = '';
      }
    }
  }

  _emitToolUse(name, input) {
    const info = this._formatToolUse(name, input);
    this._emit({
      type: 'tool_use',
      icon: info.icon,
      label: info.label,
      detail: info.detail,
      color: 'yellow',
    });
  }

  _emitToolResult(block) {
    const isError = block.is_error;
    const content = typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);
    const summary = this._getResultSummary(content);

    this._emit({
      type: 'tool_result',
      icon: isError ? '✗' : '✓',
      label: summary,
      detail: null,
      color: isError ? 'red' : 'green',
    });
  }

  /**
   * Format tool uses into compact watch-friendly strings
   * This is where the magic happens — no code, just actions
   */
  _formatToolUse(name, input) {
    switch (name) {
      case 'Bash':
      case 'bash': {
        const cmd = input.command || input.cmd || '';
        // Extract just the command name and key args
        const compact = this._compactBashCommand(cmd);
        return { icon: '$', label: compact, detail: null };
      }
      case 'Read':
      case 'read': {
        const file = this._shortPath(input.file_path || input.path || '');
        return { icon: '◎', label: `read ${file}`, detail: null };
      }
      case 'Write':
      case 'write': {
        const file = this._shortPath(input.file_path || input.path || '');
        return { icon: '✎', label: `write ${file}`, detail: null };
      }
      case 'Edit':
      case 'edit': {
        const file = this._shortPath(input.file_path || input.path || '');
        return { icon: '✎', label: `edit ${file}`, detail: null };
      }
      case 'Grep':
      case 'grep':
      case 'MultiGrepTool': {
        const pattern = input.pattern || input.query || '';
        return { icon: '⌕', label: `grep "${this._truncate(pattern, 30)}"`, detail: null };
      }
      case 'Glob':
      case 'glob': {
        const pattern = input.pattern || '';
        return { icon: '⌕', label: `glob ${pattern}`, detail: null };
      }
      case 'TodoWrite': {
        const todos = input.todos || [];
        const done = todos.filter(t => t.status === 'completed').length;
        const total = todos.length;
        return { icon: '☰', label: `todo ${done}/${total}`, detail: null };
      }
      case 'WebSearch':
      case 'web_search': {
        const query = input.query || '';
        return { icon: '◈', label: `search "${this._truncate(query, 30)}"`, detail: null };
      }
      case 'WebFetch':
      case 'web_fetch': {
        const url = input.url || '';
        const host = this._extractHost(url);
        return { icon: '↓', label: `fetch ${host}`, detail: null };
      }
      case 'SubAgent':
      case 'subagent': {
        const desc = input.description || input.prompt || 'subtask';
        return { icon: '◇', label: `agent: ${this._truncate(desc, 40)}`, detail: null };
      }
      default: {
        // MCP tools or unknown tools
        const shortName = name.replace(/^mcp__\w+__/, '');
        return { icon: '⚙', label: shortName, detail: null };
      }
    }
  }

  /**
   * Compact a bash command to its essential parts
   * "cd /very/long/path && npm run test -- --coverage" → "npm test --coverage"
   */
  _compactBashCommand(cmd) {
    if (!cmd) return '(empty)';

    // Remove cd commands
    let cleaned = cmd.replace(/cd\s+[^\s&|;]+\s*[;&|]*\s*/g, '').trim();
    if (!cleaned) cleaned = cmd;

    // Known command patterns → short form
    const patterns = [
      [/npm\s+run\s+(\w+)/, 'npm $1'],
      [/npx\s+(\S+)/, 'npx $1'],
      [/yarn\s+(\w+)/, 'yarn $1'],
      [/pnpm\s+(\w+)/, 'pnpm $1'],
      [/python3?\s+(\S+)/, 'python $1'],
      [/node\s+(\S+)/, 'node $1'],
      [/git\s+(\w+)(.*)/, (m, sub, rest) => `git ${sub}${this._truncate(rest.trim(), 20)}`],
      [/docker\s+(\w+)/, 'docker $1'],
      [/pip\s+install\s+(\S+)/, 'pip install $1'],
      [/cargo\s+(\w+)/, 'cargo $1'],
      [/make\s*(\w*)/, (m, target) => target ? `make ${target}` : 'make'],
      [/cat\s+(\S+)/, (m, f) => `cat ${this._shortPath(f)}`],
      [/ls\s*(.*)/, 'ls'],
      [/mkdir\s+(-p\s+)?(\S+)/, (m, p, d) => `mkdir ${this._shortPath(d)}`],
      [/rm\s+(-rf?\s+)?(\S+)/, (m, f, d) => `rm ${this._shortPath(d)}`],
      [/cp\s+.*?(\S+)\s*$/, (m, d) => `cp → ${this._shortPath(d)}`],
      [/mv\s+.*?(\S+)\s*$/, (m, d) => `mv → ${this._shortPath(d)}`],
      [/curl\s+.*?(https?:\/\/\S+)/, (m, url) => `curl ${this._extractHost(url)}`],
      [/grep\s+(-r\w*\s+)?["']?(\S+)["']?/, (m, f, p) => `grep "${p}"`],
    ];

    for (const [pattern, replacement] of patterns) {
      const match = cleaned.match(pattern);
      if (match) {
        if (typeof replacement === 'function') {
          return this._truncate(replacement(...match), 60);
        }
        return this._truncate(cleaned.replace(pattern, replacement), 60);
      }
    }

    // Fallback: just truncate
    return this._truncate(cleaned, 60);
  }

  _getResultSummary(content) {
    if (!content) return 'done';
    const str = String(content);

    // File operation results
    if (str.includes('File created successfully')) return 'file created';
    if (str.includes('File edited successfully')) return 'file edited';
    if (str.includes('successfully')) return 'success';

    // Test results — prefer "Tests: N passed" over "Test Suites: N passed"
    const testsLineMatch = str.match(/Tests:\s*(\d+)\s*passed/i);
    if (testsLineMatch) return `${testsLineMatch[1]} tests passed`;
    const testMatch = str.match(/(\d+)\s*(tests?\s+)?pass/i);
    if (testMatch) return `${testMatch[1]} tests passed`;
    const failMatch = str.match(/(\d+)\s*(tests?\s+)?fail/i);
    if (failMatch) return `${failMatch[1]} tests failed`;

    // Error indicators
    if (str.includes('Error') || str.includes('error')) {
      const firstLine = this._getFirstLine(str);
      return this._truncate(firstLine, 60);
    }

    // Line count for large outputs
    const lines = str.split('\n').length;
    if (lines > 10) return `${lines} lines output`;

    // Short output: show first meaningful line
    return this._truncate(this._getFirstLine(str), 60);
  }

  _extractUserText(message) {
    if (!message) return null;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') return block.text;
      }
    }
    return null;
  }

  _getFirstLine(text) {
    if (!text) return '';
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    return lines[0]?.trim() || '';
  }

  _shortPath(filepath) {
    if (!filepath) return '';
    const parts = filepath.split('/');
    if (parts.length <= 2) return filepath;
    return parts.slice(-2).join('/');
  }

  _extractHost(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url.substring(0, 30);
    }
  }

  _truncate(str, max) {
    if (!str) return '';
    str = str.trim();
    return str.length > max ? str.substring(0, max - 1) + '…' : str;
  }

  /**
   * Get recent events for initial sync
   */
  getRecentEvents(count = 20) {
    return this.events.slice(-count);
  }

  /**
   * Reset state for new session
   */
  reset() {
    this.currentToolName = null;
    this.currentToolId = null;
    this.currentToolInput = '';
    this.currentText = '';
    this.events = [];
  }
}

module.exports = { ClaudeStreamParser };
