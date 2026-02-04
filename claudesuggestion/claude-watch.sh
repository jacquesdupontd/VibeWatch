#!/usr/bin/env bash
#
# claude-watch.sh — Compact Claude Code output for small screens
#
# Pipes Claude Code's stream-json output through jq to extract
# only watch-worthy events: user prompts, tool names, results.
#
# Usage:
#   claude -p "run tests" --output-format stream-json --verbose | ./claude-watch.sh
#   
#   # Or in one line:
#   claude -p "fix the bug" --output-format stream-json --verbose | bash claude-watch.sh
#
# The output is a compact, colored, one-line-per-event stream
# perfect for piping to a Pebble app or any small display.

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[0;90m'
NC='\033[0m'

while IFS= read -r line; do
  # Skip empty lines
  [[ -z "$line" ]] && continue

  type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
  [[ -z "$type" ]] && continue

  case "$type" in
    system)
      subtype=$(echo "$line" | jq -r '.subtype // empty')
      if [[ "$subtype" == "init" ]]; then
        tools=$(echo "$line" | jq -r '.tools | length')
        echo -e "${GREEN}● Claude Code${NC} ${DIM}(${tools} tools)${NC}"
      fi
      ;;

    user)
      text=$(echo "$line" | jq -r '
        if .message.content | type == "string" then .message.content
        elif .message.content | type == "array" then
          [.message.content[] | select(.type == "text") | .text] | join(" ")
        else empty end // empty
      ' 2>/dev/null)
      if [[ -n "$text" ]]; then
        # Truncate to 80 chars
        [[ ${#text} -gt 80 ]] && text="${text:0:79}…"
        echo -e "${WHITE}› ${text}${NC}"
      fi
      ;;

    assistant)
      # Process each content block
      echo "$line" | jq -c '.message.content[]? // empty' 2>/dev/null | while IFS= read -r block; do
        btype=$(echo "$block" | jq -r '.type // empty')

        case "$btype" in
          text)
            text=$(echo "$block" | jq -r '.text // empty')
            if [[ -n "$text" ]]; then
              # Get first meaningful line only
              first=$(echo "$text" | head -1 | sed 's/^[[:space:]]*//')
              [[ ${#first} -gt 80 ]] && first="${first:0:79}…"
              [[ ${#first} -gt 5 ]] && echo -e "${CYAN}◆ ${first}${NC}"
            fi
            ;;

          tool_use)
            name=$(echo "$block" | jq -r '.name // "?"')
            case "$name" in
              Bash|bash)
                cmd=$(echo "$block" | jq -r '.input.command // empty')
                # Compact the command
                short=$(echo "$cmd" | sed 's|cd [^ ]* && ||g' | head -c 60)
                echo -e "${YELLOW}\$ ${short}${NC}"
                ;;
              Read|read)
                file=$(echo "$block" | jq -r '.input.file_path // .input.path // "?"')
                short=$(basename "$file" 2>/dev/null || echo "$file")
                echo -e "${YELLOW}◎ read ${short}${NC}"
                ;;
              Write|write)
                file=$(echo "$block" | jq -r '.input.file_path // .input.path // "?"')
                short=$(basename "$file" 2>/dev/null || echo "$file")
                echo -e "${YELLOW}✎ write ${short}${NC}"
                ;;
              Edit|edit)
                file=$(echo "$block" | jq -r '.input.file_path // .input.path // "?"')
                short=$(basename "$file" 2>/dev/null || echo "$file")
                echo -e "${YELLOW}✎ edit ${short}${NC}"
                ;;
              Grep|grep|MultiGrepTool)
                pattern=$(echo "$block" | jq -r '.input.pattern // .input.query // "?"')
                echo -e "${YELLOW}⌕ grep \"${pattern:0:30}\"${NC}"
                ;;
              TodoWrite)
                done=$(echo "$block" | jq '[.input.todos[]? | select(.status == "completed")] | length')
                total=$(echo "$block" | jq '.input.todos | length')
                echo -e "${YELLOW}☰ todo ${done}/${total}${NC}"
                ;;
              *)
                echo -e "${YELLOW}⚙ ${name}${NC}"
                ;;
            esac
            ;;

          tool_result)
            is_error=$(echo "$block" | jq -r '.is_error // false')
            content=$(echo "$block" | jq -r '.content // empty')
            if [[ "$is_error" == "true" ]]; then
              short=$(echo "$content" | head -1 | head -c 60)
              echo -e "${RED}✗ ${short}${NC}"
            else
              # Smart summary
              if echo "$content" | grep -qi "pass"; then
                count=$(echo "$content" | grep -oP '\d+(?=\s*(tests?)?\s*pass)' | tail -1)
                [[ -n "$count" ]] && echo -e "${GREEN}✓ ${count} tests passed${NC}" || echo -e "${GREEN}✓ success${NC}"
              elif echo "$content" | grep -qi "success\|created\|edited"; then
                echo -e "${GREEN}✓ success${NC}"
              else
                lines=$(echo "$content" | wc -l)
                if [[ $lines -gt 5 ]]; then
                  echo -e "${GREEN}✓ ${lines} lines output${NC}"
                else
                  short=$(echo "$content" | head -1 | head -c 60)
                  echo -e "${GREEN}✓ ${short}${NC}"
                fi
              fi
            fi
            ;;
        esac
      done
      ;;

    result)
      subtype=$(echo "$line" | jq -r '.subtype // "?"')
      cost=$(echo "$line" | jq -r '.total_cost_usd // 0')
      turns=$(echo "$line" | jq -r '.num_turns // 0')
      if [[ "$subtype" == "success" ]]; then
        echo -e "${GREEN}■ Done${NC} ${DIM}(${turns} turns, \$${cost})${NC}"
      else
        echo -e "${RED}■ Error: ${subtype}${NC}"
      fi
      ;;
  esac
done
