#!/usr/bin/env node
/**
 * Test tool to verify CLEAN format before sending to watch
 * Simulates what the watch would receive and parse
 */

const { execSync } = require('child_process');
const WebSocket = require('ws');

// Simulate watchapp parsing (same logic as watchapp.c)
function parseCleanFormat(data) {
    if (!data.startsWith('CLEAN:')) return null;

    const fields = { userCmd: '', summary: '', status: '', lastTool: '' };
    const content = data.substring(6); // Remove "CLEAN:"

    const parts = content.split('|');
    if (parts.length >= 1) fields.userCmd = parts[0].substring(0, 127);
    if (parts.length >= 2) fields.summary = parts[1].substring(0, 1023);
    if (parts.length >= 3) fields.status = parts[2].substring(0, 31);
    if (parts.length >= 4) fields.lastTool = parts[3].substring(0, 63);

    return fields;
}

// Validate the format
function validateFormat(cleanStr) {
    console.log('='.repeat(60));
    console.log('CLEAN FORMAT VALIDATION');
    console.log('='.repeat(60));
    console.log('');
    console.log('Raw string length:', cleanStr.length);
    console.log('');

    // Check for problematic characters
    const pipeCount = (cleanStr.match(/\|/g) || []).length;
    console.log('Pipe count:', pipeCount, '(should be exactly 3)');
    if (pipeCount !== 3) {
        console.log('ERROR: Wrong number of pipes! Format is broken.');
    }
    console.log('');

    // Parse it
    const parsed = parseCleanFormat(cleanStr);
    if (!parsed) {
        console.log('ERROR: Failed to parse!');
        return;
    }

    console.log('PARSED FIELDS:');
    console.log('-'.repeat(40));
    console.log('userCmd (' + parsed.userCmd.length + ' chars):');
    console.log('  "' + parsed.userCmd.substring(0, 60) + (parsed.userCmd.length > 60 ? '..."' : '"'));
    console.log('');
    console.log('summary (' + parsed.summary.length + ' chars):');
    console.log('  "' + parsed.summary.substring(0, 80) + (parsed.summary.length > 80 ? '..."' : '"'));
    console.log('');
    console.log('status (' + parsed.status.length + ' chars):');
    console.log('  "' + parsed.status + '"');
    console.log('');
    console.log('lastTool (' + parsed.lastTool.length + ' chars):');
    console.log('  "' + parsed.lastTool.substring(0, 50) + (parsed.lastTool.length > 50 ? '..."' : '"'));
    console.log('');

    // Validate each field
    console.log('VALIDATION:');
    console.log('-'.repeat(40));

    // Status should be a thinking word or Done/Ready
    if (parsed.status.match(/^[A-Z][a-z]+\.\.\.$/)) {
        console.log('✓ Status looks like a thinking word:', parsed.status);
    } else if (['Done', 'Ready', 'Error'].includes(parsed.status)) {
        console.log('✓ Status is a valid state:', parsed.status);
    } else {
        console.log('✗ Status looks wrong:', parsed.status);
    }

    // Tool should start with $ or be a tool name
    if (parsed.lastTool.startsWith('$') || parsed.lastTool.match(/^(read|edit|write|grep|glob)/i)) {
        console.log('✓ Tool looks correct:', parsed.lastTool.substring(0, 40));
    } else if (parsed.lastTool === '') {
        console.log('- Tool is empty (OK if no recent tool)');
    } else {
        console.log('? Tool format unclear:', parsed.lastTool.substring(0, 40));
    }

    // Summary should not contain tool-like patterns
    if (parsed.summary.match(/^(Read|Edit|Bash|Update)\s*\(/)) {
        console.log('✗ Summary looks like a tool call, not Claude text!');
    } else if (parsed.summary.length > 10) {
        console.log('✓ Summary has content');
    } else {
        console.log('- Summary is short or empty');
    }

    console.log('');
    console.log('='.repeat(60));
}

// Main: connect to bridge and test
console.log('Connecting to bridge...');
const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
    console.log('Connected. Joining vibecoder session...');
    ws.send(JSON.stringify({ type: 'join', name: 'vibecoder' }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.cleanData) {
        const cd = msg.cleanData;

        // Build the exact string that pkjs sends
        function sanitize(s) { return (s || '').replace(/\|/g, ' '); }
        const cleanStr = 'CLEAN:' + sanitize(cd.userCmd) + '|' + sanitize(cd.summary) + '|' + sanitize(cd.status) + '|' + sanitize(cd.lastTool);

        validateFormat(cleanStr);

        ws.close();
        process.exit(0);
    }
});

ws.on('error', (err) => {
    console.log('Error:', err.message);
    process.exit(1);
});

setTimeout(() => {
    console.log('Timeout - no CLEAN data received');
    ws.close();
    process.exit(1);
}, 5000);
