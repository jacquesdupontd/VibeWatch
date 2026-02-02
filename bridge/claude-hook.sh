#!/bin/bash
# Claude Code hook script - forwards events to VibeCoder bridge
# Reads JSON from stdin, POSTs to the hooks-bridge HTTP endpoint

BRIDGE_URL="http://localhost:8081/event"

# Read all of stdin (the hook JSON)
INPUT=$(cat)

# POST to bridge (fire and forget, don't block Claude)
curl -s -X POST "$BRIDGE_URL" \
    -H "Content-Type: application/json" \
    -d "$INPUT" \
    --max-time 2 \
    > /dev/null 2>&1 &

# Always exit 0 so we never block Claude
exit 0
