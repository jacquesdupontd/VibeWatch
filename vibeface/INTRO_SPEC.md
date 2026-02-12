# Vibeface Intro Sequence - Specification

## Lines
1. `> I'm Claude.`
2. `> I write code.`
3. `> From this`
4. `> Pebble.`

## Style
- Black background, green text (GColorMalachite)
- Terminal style with `> ` prefix
- Font: GOTHIC_24_BOLD
- Typing animation: 70ms per character
- y_start = 22, line_height = 32

## Glitch Behavior (IMPORTANT)
1. **"I'm Claude."** types char by char. When done, "Claude." glitches (random colors, random fonts, slight shake). Glitch **STAYS active** - does NOT settle. ~12 frames of glitch then move to next line while Claude keeps glitching.

2. **"I write code."** types char by char. When done, "code." glitches same way. Glitch **STAYS active**. ~12 frames then move on.

3. **"From this"** types normally. No glitch.

4. **"Pebble."** types char by char. When done, glitches HARD for ~5 seconds (80 frames at 60ms). More intense: bigger shake (rand%7-3, rand%5-2), random fonts, random colors. Then **settles** to clean green text. Brief pause. Transition to normal vibeface.

## Glitch Rendering
- "Claude." glitch: draw "> I'm " in green, then "Claude." in random font/color with shake offset
- "code." glitch: draw "> I write " in green, then "code." in random font/color with shake offset
- "Pebble." glitch: draw entire "> Pebble." in random font/color with shake offset

## Transition
After "Pebble." settles:
- s_intro_active = false
- Reset s_display_text, s_phase=0, s_typing=true
- Start animation_tick after 500ms
- Normal vibeface cycle begins

## Backlight
- Stays on for 1 minute at startup via backlight_tick

## Key Variables
- s_intro_active: master intro flag
- s_intro_line: current line (0-3)
- s_intro_char_pos: current char in line
- s_intro_display[64]: typing buffer
- s_intro_pause: pause counter between lines
- s_intro_glitch_count: frame counter for glitch
- s_glitch_claude: true = "Claude." is glitching (STAYS true)
- s_glitch_code: true = "code." is glitching (STAYS true)
- s_intro_final_glitch: true = "Pebble." is glitching

## Canvas Rendering (canvas_update_proc)
- Completed lines: loop i < s_intro_line, check glitch flags per line
- Current line: show s_intro_display with cursor, OR glitch if Pebble
- Transition phase (s_intro_line >= INTRO_LINES): show all 4 lines, Pebble still glitching or settled
