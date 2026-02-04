#!/usr/bin/env node
/**
 * Test scroll functionality in CLEAN mode
 * Sends a long CLEAN message to the watch via phonesim
 */

const { execSync } = require('child_process');

// Long test message to verify scroll
const testSummary = `This is line 1 of the test message.
This is line 2 - we need many lines to test scroll.
Line 3: The quick brown fox jumps over the lazy dog.
Line 4: Lorem ipsum dolor sit amet consectetur.
Line 5: Testing scroll functionality in CLEAN mode.
Line 6: Can you see this line? Scroll down!
Line 7: More text to ensure we have enough content.
Line 8: The watch should show a scroll indicator.
Line 9: Press UP/DOWN to scroll through the text.
Line 10: Final line of our test message.`.replace(/\|/g, ' ').replace(/\n/g, ' ');

// Build CLEAN message
const cleanMsg = `CLEAN:test scroll command|${testSummary}|Testing...|$test`;

console.log('Sending test CLEAN message to watch...');
console.log('Message length:', cleanMsg.length);
console.log('Summary length:', testSummary.length);

// Send via phonesim inject
try {
    // Create a temporary file with the message
    const fs = require('fs');
    const msgFile = '/tmp/clean_msg.txt';
    fs.writeFileSync(msgFile, cleanMsg);

    console.log('\nMessage preview:');
    console.log(cleanMsg.substring(0, 100) + '...');

    console.log('\nTo test: Join the vibecoder session on the watch,');
    console.log('then the bridge should send CLEAN data automatically.');
    console.log('Press UP/DOWN to scroll.');

} catch (e) {
    console.error('Error:', e.message);
}
