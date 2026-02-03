# VibeCoder Merge Plan

## Objective
Merge VibeFace (glitch watchface) + WatchApp (Claude monitor) into ONE app.

## Files to merge
- `vibeface/src/c/vibeface.c` (740 lines) - The visual base
- `watchapp/src/c/watchapp.c` (657 lines) - The connectivity

## Target behavior

### State Machine
```
IDLE (no Claude activity for 5s)
  └── Show VibeFace cycle: time → date → "ready to" → "vibecode" → GLITCH → loop

ACTIVE (AppMessage received)
  └── Show Claude activity: streaming text, tool icons, etc.
  └── When Stop received → trigger "vibecode" GLITCH → return to IDLE
```

### Key additions to VibeFace

1. **Add AppMessage handlers** (from watchapp.c lines 395-529)
   - `inbox_received_callback`
   - Message keys for TERMINAL_DATA, PROMPT_FLAG, etc.

2. **Add state variable**
   ```c
   static bool s_claude_active = false;
   static AppTimer *s_idle_timer = NULL;
   ```

3. **Add idle timeout**
   ```c
   static void idle_timeout(void *context) {
       s_claude_active = false;
       // Trigger vibecode glitch then return to normal cycle
   }
   ```

4. **Modify canvas_update_proc**
   ```c
   if (s_claude_active) {
       // Draw Claude activity (from watchapp)
   } else {
       // Draw VibeFace (current code)
   }
   ```

5. **Add pkjs file** (copy from watchapp)
   - `src/pkjs/index.js`

6. **Update package.json**
   - Add messageKeys from watchapp

## What stays the same
- All VibeFace visual effects (chaos, glitch, easter eggs)
- All WatchApp text rendering and streaming
- Bridge connection via pkjs

## The "viral moment"
When Claude sends "Stop" hook → app shows "vibecode" → MEGA GLITCH → seamless transition to watchface mode.

## Estimated merge complexity
- ~100 lines of new code
- ~50 lines of integration
- Should take Claude ~2-3 minutes to code live

## Voice command for video
"Claude, fusionne vibeface.c avec watchapp.c pour créer une seule app.
Quand il y a de l'activité Claude, affiche-la.
Quand c'est inactif pendant 5 secondes, affiche la watchface avec le cycle time/date/vibecode.
Quand Claude s'arrête, déclenche le glitch vibecode avant de revenir en mode watchface."
