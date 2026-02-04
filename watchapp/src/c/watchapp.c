#include <pebble.h>

static Window *s_window;
static Layer *s_canvas;
static TextLayer *s_prompt_layer;
static char s_buffer[2048];
static char s_prev_buffer[2048];
static bool s_has_prompt = false;
static int s_scroll_offset = 0;
static int s_total_height = 0;
static bool s_auto_scroll = true;
static bool s_dark_mode = true;
static char s_prompt_text[64];
static int s_prompt_keys[3] = {1, 2, 3};

// Menu state
typedef enum { STATE_MENU, STATE_SESSION } AppState;
static AppState s_state = STATE_MENU;
static char s_sessions[5][32];
static int s_session_count = 0;
static int s_selected_idx = 0;
static char s_active_session[32] = "";

// Display mode: VERBOSE (streaming) vs CLEAN (structured)
typedef enum { MODE_VERBOSE, MODE_CLEAN } DisplayMode;
static DisplayMode s_display_mode = MODE_VERBOSE;
static char s_user_cmd[128] = "";
static char s_claude_summary[1024] = "";  // Larger buffer for multiple paragraphs
static char s_status[32] = "Ready";
static char s_last_tool[64] = "";
static char s_suggestion[128] = "";  // Ghost text suggestion
static char s_active_task[64] = "";  // Active task name (Creating README.md, etc.)
static bool s_task_running = false;  // Is a task currently running?
static int s_clean_scroll = -1;  // -1 = auto (show end), >=0 = manual offset
static int s_marquee_offset = 0;  // For horizontal marquee (commands)

// Streaming: character count
static int s_chars_shown = 0;
static int s_chars_total = 0;
static AppTimer *s_stream_timer = NULL;

// Blinking cursor
static bool s_cursor_visible = true;
static AppTimer *s_cursor_timer = NULL;
static int s_anim_counter = 0;
static int s_cursor_x = 0;
static int s_cursor_y = 0;
// Typing animation for suggestions
static int s_typing_speed_div = 1; // Adjust for speed

static GFont s_font;
static int s_line_h = 0;
static int s_space_w = 0;
static int s_page_step = 168;

static GColor bg_color() { return s_dark_mode ? GColorBlack : GColorWhite; }
static GColor cursor_color() { return s_dark_mode ? GColorWhite : GColorBlack; }

static GColor color_from_code(char c) {
  if (s_dark_mode) {
    switch (c) {
    case 'W':
      return GColorWhite;
    case 'B':
      return GColorCyan; // Brighter blue
    case 'C':
      return GColorCeleste; // Brighter cyan
    case 'R':
      return GColorMelon; // Brighter red
    case 'G':
      return GColorGreen; // Brighter green
    case 'Y':
      return GColorYellow;
    case 'O':
      return GColorChromeYellow; // Brighter orange
    case 'L':
      return GColorLightGray;
    case 'S':
      return GColorWhite; // Suggestion default
    default:
      return GColorWhite;
    }
  } else {
    switch (c) {
    case 'W':
      return GColorBlack;
    case 'B':
      return GColorCobaltBlue;
    case 'C':
      return GColorBlueMoon;
    case 'R':
      return GColorBulgarianRose;
    case 'G':
      return GColorDarkGreen;
    case 'Y':
      return GColorWindsorTan;
    case 'O':
      return GColorOrange;
    case 'L':
      return GColorDarkGray;
    case 'S':
      return GColorDarkGray;
    default:
      return GColorBlack;
    }
  }
}

static int measure_word(const char *word) {
  GSize s = graphics_text_layout_get_content_size(
      word, s_font, GRect(0, 0, 200, 50), GTextOverflowModeTrailingEllipsis,
      GTextAlignmentLeft);
  return s.w;
}

static void init_metrics() {
  if (s_line_h > 0)
    return;
  // GSize s = graphics_text_layout_get_content_size(...); (Unused)
  // Force tight packing for maximum density (User request)
  // 168px screen / 14px = 12 lines exact.
  s_line_h = 14;

  // Calculate page step to align with lines
  s_page_step = 168; // Full screen scroll
  int ab = measure_word("ab");
  int a_b = measure_word("a b");
  s_space_w = (a_b - ab) > 0 ? (a_b - ab) : 3;
}

// Count total text characters in buffer (excluding color codes and newlines)
static int count_chars() {
  int count = 0;
  char *p = s_buffer;
  while (*p) {
    char *nl = strchr(p, '\n');
    int len = nl ? (int)(nl - p) : (int)strlen(p);
    if (len > 1)
      count += len - 1; // skip color code char
    if (nl)
      p = nl + 1;
    else
      break;
  }
  return count;
}

// Fade colors for streaming edge
static GColor fade_color(int steps_from_end) {
  if (s_dark_mode) {
    switch (steps_from_end) {
    case 0:
      return GColorDarkGray;
    case 1:
      return GColorLightGray;
    default:
      return GColorWhite;
    }
  } else {
    switch (steps_from_end) {
    case 0:
      return GColorLightGray;
    case 1:
      return GColorDarkGray;
    default:
      return GColorBlack;
    }
  }
}

// Single pass: measure or draw, limited to max_chars of text content
// mode: 0=measure only, 1=draw, 2=draw+cursor
static int flow_pass(GContext *ctx, int screen_w, int screen_h, int max_chars,
                     int mode) {
  int x = 0, y = (mode > 0) ? -s_scroll_offset - 4 : -4;
  int char_idx = 0;
  char seg[256];
  char partial[64];
  bool streaming = (s_chars_shown < s_chars_total);

  char *p = s_buffer;
  while (*p) {
    char *nl = strchr(p, '\n');
    int len = nl ? (int)(nl - p) : (int)strlen(p);
    if (len > 1) {
      GColor base_color = GColorWhite;
      bool is_suggestion = (p[0] == 'S');
      if (mode > 0) {
        if (is_suggestion) {
          // Blink suggestion: alternate between visible and bg
          base_color = s_cursor_visible
                           ? (s_dark_mode ? GColorLightGray : GColorDarkGray)
                           : bg_color();
        } else {
          base_color = color_from_code(p[0]);
        }
      }

      int tlen = len - 1;
      if (tlen > 255)
        tlen = 255;
      memcpy(seg, p + 1, tlen);
      seg[tlen] = '\0';

      char *wp = seg;
      while (*wp) {
        while (*wp == ' ') {
          wp++;
          char_idx++;
          if (!is_suggestion && char_idx >= max_chars)
            goto done;
        }
        if (!*wp)
          break;
        char *we = wp;
        while (*we && *we != ' ')
          we++;
        char saved = *we;
        *we = '\0';

        int word_len = (int)(we - wp);
        int ww = 0;
        char *draw_str = wp;
        bool truncated = false;

        if (is_suggestion) {
          ww = measure_word(draw_str);
        } else {
          int chars_left = max_chars - char_idx;
          if (chars_left <= 0) {
            *we = saved;
            goto next_line;
          }
          if (word_len > chars_left) {
            int plen = chars_left < 63 ? chars_left : 63;
            memcpy(partial, wp, plen);
            partial[plen] = '\0';
            draw_str = partial;
            word_len = plen;
            truncated = true;
          }
          ww = measure_word(draw_str);
        }
        if (x > 0 && x + s_space_w + ww > screen_w) {
          x = 0;
          y += s_line_h;
        }
        if (x > 0)
          x += s_space_w;

        // Strict Check: Only draw if line is actually on screen.
        // This prevents "stream glitches" in the middle of screen when
        // scrolling back.
        // Check: Draw if ANY part of the line is on screen.
        // y + s_line_h > 0 (bottom of line is visible)
        // y < screen_h     (top of line is visible)
        if (mode > 0 && y + s_line_h > 0 && y < screen_h) {
          bool should_draw = (char_idx < max_chars) || is_suggestion;
          if (should_draw) {
            GColor draw_color = base_color;
            if (is_suggestion) {
              // Typing Animation for Suggestions
              // Cycle length = suggestion text length so ALL chars get revealed
              int cycle_len = tlen > 2 ? tlen : 25;
              int current_step =
                  (s_anim_counter / s_typing_speed_div) % cycle_len;

              // Optimized approach:
              int line_word_start = (int)(wp - seg);
              int line_word_end = line_word_start + word_len;

              if (current_step >= line_word_end) {
                // Draw full word
                graphics_context_set_text_color(ctx, s_dark_mode ? GColorWhite
                                                                 : GColorBlack);
                graphics_draw_text(ctx, draw_str, s_font,
                                   GRect(x + 2, y, ww + 4, s_line_h),
                                   GTextOverflowModeTrailingEllipsis,
                                   GTextAlignmentLeft, NULL);
              } else if (current_step >= line_word_start) {
                // Draw partial word
                int chars_to_show = current_step - line_word_start + 1;
                if (chars_to_show > 0 && chars_to_show < 64) {
                  char partial_word[64];
                  strncpy(partial_word, draw_str, chars_to_show);
                  partial_word[chars_to_show] = '\0';
                  graphics_context_set_text_color(
                      ctx, s_dark_mode ? GColorWhite : GColorBlack);
                  graphics_draw_text(ctx, partial_word, s_font,
                                     GRect(x + 2, y, ww + 4, s_line_h),
                                     GTextOverflowModeTrailingEllipsis,
                                     GTextAlignmentLeft, NULL);

                  // Draw Cursor?
                  // GSize p_size =
                  // graphics_text_layout_get_content_size(partial_word, ...);
                  // graphics_fill_rect(...)
                }
              }
              // Else: word is in the future, don't draw.
            } else {
              if (streaming) {
                int dist = max_chars - char_idx - word_len;
                if (dist < 8) {
                  int fade_step = dist / 3;
                  if (fade_step < 2)
                    draw_color = fade_color(fade_step);
                }
              }
              graphics_context_set_text_color(ctx, draw_color);
              graphics_draw_text(
                  ctx, draw_str, s_font, GRect(x + 2, y, ww + 4, s_line_h),
                  GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
            }
          }
        }
        x += ww;
        char_idx += word_len;

        *we = saved;
        if (!is_suggestion && (truncated || char_idx >= max_chars))
          goto done;
        wp = we;
      }
    }
  next_line:
    if (nl)
      p = nl + 1;
    else
      break;
  }

done:
  if (mode == 2) {
    s_cursor_x = x;
    s_cursor_y = y;
  }
  return y + s_line_h + ((mode > 0) ? s_scroll_offset : 4);
}

static void draw_clean_mode(GContext *ctx, GRect bounds) {
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  GFont body = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  GFont small = fonts_get_system_font(FONT_KEY_GOTHIC_14);

  // LAYOUT (bottom to top):
  // 1. Status bar (18px) - bottom
  // 2. Prompt/Suggestion (16px) - just above status
  // --- separator line ---
  // 3. Last tool (16px) - ABOVE the line
  // 4. Claude text (rest) - top

  int status_h = 18;
  int prompt_h = 16;
  int tool_h = s_last_tool[0] ? 16 : 0;
  int below_line = status_h + prompt_h;  // Below separator
  int above_line = tool_h;               // Above separator

  // Content zone for Claude text (everything above the tool line)
  int content_h = bounds.size.h - below_line - above_line - 4;
  if (content_h < 20) content_h = 20;  // Safety minimum
  int content_w = bounds.size.w - 8;
  if (content_w < 50) content_w = 50;  // Safety minimum

  // ===== 1. Draw Claude text (green) with gentle scroll =====
  if (s_claude_summary[0]) {
    int len = strlen(s_claude_summary);
    int offset = 0;

    // Only scroll if text is long enough
    if (len > 200) {
      // Simple character-based scroll: cycle through text
      int cycle = len - 150;  // How many chars to scroll through
      if (cycle > 0) {
        offset = (s_anim_counter * 3) % (cycle + 30);  // +30 for pause
        if (offset > cycle) offset = cycle;  // Pause at end
      }
    }

    // Find word boundary for offset
    if (offset > 0 && offset < len) {
      while (offset > 0 && s_claude_summary[offset] != ' ') offset--;
      if (s_claude_summary[offset] == ' ') offset++;
    }

    graphics_context_set_text_color(ctx, GColorMintGreen);
    graphics_draw_text(ctx, s_claude_summary + offset, body,
        GRect(4, 2, content_w, content_h),
        GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);

    // Scroll indicator if scrolling
    if (offset > 0) {
      graphics_context_set_fill_color(ctx, GColorYellow);
      graphics_fill_rect(ctx, GRect(bounds.size.w - 6, 4, 4, 4), 0, GCornerNone);
    }
  }

  // ===== 2. Last tool (cyan) - ABOVE separator line, with MARQUEE =====
  int tool_y = content_h;
  if (s_last_tool[0]) {
    static char tool_buf[48];
    int tool_len = strlen(s_last_tool);
    const char *tool_text = s_last_tool;

    // Marquee scroll if too long
    if (tool_len > 28) {
      int scroll_pos = (s_marquee_offset / 2) % (tool_len + 4);  // Slower scroll
      if (scroll_pos < tool_len) {
        int show_len = tool_len - scroll_pos;
        if (show_len > 35) show_len = 35;
        strncpy(tool_buf, s_last_tool + scroll_pos, show_len);
        tool_buf[show_len] = '\0';
      } else {
        strncpy(tool_buf, s_last_tool, 35);
        tool_buf[35] = '\0';
      }
      tool_text = tool_buf;
    }

    graphics_context_set_text_color(ctx, GColorCyan);
    graphics_draw_text(ctx, tool_text, small,
        GRect(4, tool_y, bounds.size.w - 8, tool_h),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }

  // ===== Separator line (below tool, above prompt) =====
  int line_y = content_h + tool_h + 2;
  graphics_context_set_stroke_color(ctx, GColorDarkGray);
  graphics_draw_line(ctx, GPoint(10, line_y), GPoint(bounds.size.w - 10, line_y));

  // ===== 3. Prompt OR Suggestion (yellow) - BELOW line, ABOVE status =====
  int prompt_y = line_y + 2;
  bool has_suggestion = (s_suggestion[0] != '\0');
  static char prompt_buf[48];

  if (has_suggestion) {
    // SUGGESTION: Blinking + Marquee scroll
    int sug_len = strlen(s_suggestion);

    // Marquee: scroll if text is longer than visible area (~30 chars)
    const char *scroll_text = s_suggestion;
    if (sug_len > 30) {
      int scroll_pos = s_marquee_offset % (sug_len + 5);
      if (scroll_pos < sug_len) {
        int show_len = sug_len - scroll_pos;
        if (show_len > 35) show_len = 35;
        strncpy(prompt_buf, s_suggestion + scroll_pos, show_len);
        prompt_buf[show_len] = '\0';
      } else {
        strncpy(prompt_buf, s_suggestion, 35);
        prompt_buf[35] = '\0';
      }
      scroll_text = prompt_buf;
    }

    // Blink: alternate yellow/dim
    if (s_cursor_visible) {
      graphics_context_set_text_color(ctx, GColorYellow);
    } else {
      graphics_context_set_text_color(ctx, GColorLightGray);
    }
    graphics_draw_text(ctx, scroll_text, small,
        GRect(4, prompt_y, bounds.size.w - 8, prompt_h),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  } else if (s_user_cmd[0]) {
    // User prompt: show END with "..." prefix
    graphics_context_set_text_color(ctx, GColorYellow);
    int len = strlen(s_user_cmd);
    if (len > 32) {
      snprintf(prompt_buf, sizeof(prompt_buf), "...%s", s_user_cmd + len - 29);
      graphics_draw_text(ctx, prompt_buf, small,
          GRect(4, prompt_y, bounds.size.w - 8, prompt_h),
          GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    } else {
      graphics_draw_text(ctx, s_user_cmd, small,
          GRect(4, prompt_y, bounds.size.w - 8, prompt_h),
          GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
  }

  // Status bar (colored based on status)
  int status_y = bounds.size.h - status_h;
  GColor status_bg = GColorDarkGray;
  GColor status_fg = GColorWhite;
  const char *status_text = s_status;

  // Priority: suggestion > active task > thinking > done/error
  if (has_suggestion) {
    status_bg = GColorCobaltBlue;
    status_fg = GColorWhite;
    status_text = "SEL = accept";
  } else if (s_task_running && s_active_task[0]) {
    // TASK RUNNING: GLOW effect (pulse between bright and dim purple)
    if (s_cursor_visible) {
      status_bg = GColorPurple;  // Bright
    } else {
      status_bg = GColorImperialPurple;  // Dim
    }
    status_fg = GColorWhite;
    status_text = s_active_task;  // Show task name
  } else if (strstr(s_status, "...") || strstr(s_status, "Working")) {
    // Thinking words (Harmonizing..., etc.) - orange
    status_bg = GColorOrange;
    status_fg = GColorBlack;
  } else if (strstr(s_status, "Done") || strstr(s_status, "Ready")) {
    status_bg = GColorIslamicGreen;
    status_fg = GColorWhite;
  } else if (strstr(s_status, "Error") || strstr(s_status, "Failed")) {
    status_bg = GColorRed;
    status_fg = GColorWhite;
  }

  graphics_context_set_fill_color(ctx, status_bg);
  graphics_fill_rect(ctx, GRect(0, status_y, bounds.size.w, status_h), 0, GCornerNone);
  graphics_context_set_text_color(ctx, status_fg);
  graphics_draw_text(ctx, status_text, small,
      GRect(4, status_y, bounds.size.w - 8, status_h),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  // Mode indicator
  graphics_context_set_text_color(ctx, GColorDarkGray);
  graphics_draw_text(ctx, "CLEAN", fonts_get_system_font(FONT_KEY_GOTHIC_09),
      GRect(bounds.size.w - 30, 0, 28, 10),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}

static void draw_menu(GContext *ctx, GRect bounds) {
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont small = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  int y = 5;

  // Title
  graphics_context_set_text_color(ctx, GColorCyan);
  graphics_draw_text(ctx, "VibeCoder", font,
      GRect(0, y, bounds.size.w, 22), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  y += 24;

  // Hint
  graphics_context_set_text_color(ctx, GColorDarkGray);
  graphics_draw_text(ctx, "UP/DN nav | SEL join", small,
      GRect(2, y, bounds.size.w - 4, 14), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  y += 16;

  // Sessions
  if (s_session_count > 0) {
    for (int i = 0; i < s_session_count && i < 5; i++) {
      if (i == s_selected_idx) {
        graphics_context_set_fill_color(ctx, GColorDarkGray);
        graphics_fill_rect(ctx, GRect(2, y, bounds.size.w - 4, 18), 0, GCornerNone);
        graphics_context_set_text_color(ctx, GColorWhite);
      } else {
        graphics_context_set_text_color(ctx, GColorLightGray);
      }
      graphics_draw_text(ctx, s_sessions[i], small,
          GRect(8, y, bounds.size.w - 16, 18), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      y += 18;
    }
  } else {
    graphics_context_set_text_color(ctx, GColorDarkGray);
    graphics_draw_text(ctx, "No sessions", small,
        GRect(4, y, bounds.size.w - 8, 18), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }

  // Bottom hints
  y = bounds.size.h - 32;
  graphics_context_set_text_color(ctx, GColorMintGreen);
  graphics_draw_text(ctx, "Long UP = New session", small,
      GRect(2, y, bounds.size.w - 4, 14), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  y += 14;
  graphics_context_set_text_color(ctx, GColorIcterine);
  graphics_draw_text(ctx, "Long DN = Refresh", small,
      GRect(2, y, bounds.size.w - 4, 14), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  // Menu mode
  if (s_state == STATE_MENU) {
    draw_menu(ctx, bounds);
    return;
  }

  // CLEAN mode - structured display
  if (s_display_mode == MODE_CLEAN) {
    draw_clean_mode(ctx, bounds);
    return;
  }

  // VERBOSE mode - streaming display (original)
  graphics_context_set_fill_color(ctx, bg_color());
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  if (s_buffer[0] == '\0')
    return;
  if (!s_font)
    s_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  init_metrics();

  int w = bounds.size.w - 2;
  // When no prompt, use FULL height (168px). 168/14 = 12 lines exactly.
  // When prompt (transient), reserve 14px. 154/14 = 11 lines exactly.
  int h = s_has_prompt ? (bounds.size.h - 14) : bounds.size.h;

  int show = s_chars_shown < s_chars_total ? s_chars_shown : s_chars_total;

  // Measure height (no draw)
  s_total_height = flow_pass(NULL, w, h, show, 0);

  // User request: Bottom alignment.
  int max_scroll = s_total_height - h;
  // If negative, it means content < screen.
  // We allow negative max_scroll to align text to bottom.

  if (s_auto_scroll) {
    s_scroll_offset = max_scroll;
  } else {
    // Manual scroll handling
    if (max_scroll < 0) {
      // Content smaller than screen: Lock to bottom
      s_scroll_offset = max_scroll;
    } else {
      // Normal content: clamp 0..max_scroll
      if (s_scroll_offset > max_scroll)
        s_scroll_offset = max_scroll;
      if (s_scroll_offset < 0)
        s_scroll_offset = 0;
    }
  }

  // Draw + get cursor position
  flow_pass(ctx, w, h, show, 2);

  // Blinking cursor block - aligned to text baseline
  if (s_cursor_visible && s_cursor_y + s_line_h > 0 && s_cursor_y < h) {
    graphics_context_set_fill_color(ctx, cursor_color());
    graphics_fill_rect(ctx,
                       GRect(s_cursor_x + 6, s_cursor_y + s_line_h - 7, 7, 7),
                       0, GCornerNone);
  }

  // Thinking indicator (pulsing dot in corner)
  if (s_chars_shown < s_chars_total) {
    graphics_context_set_fill_color(ctx, s_cursor_visible ? GColorVividCerulean
                                                          : bg_color());
    graphics_fill_rect(ctx, GRect(bounds.size.w - 8, 2, 6, 6), 0, GCornerNone);
  }
}

// Simple blink timer
static void blink_tick(void *data) {
  s_cursor_visible = !s_cursor_visible;
  s_anim_counter++;
  s_marquee_offset++;
  if (s_anim_counter >= 1000) s_anim_counter = 0;
  layer_mark_dirty(s_canvas);
  s_cursor_timer = app_timer_register(300, blink_tick, NULL);
}

// Streaming timer - characters per tick
static void stream_tick(void *data) {
  if (s_chars_shown < s_chars_total) {
    s_chars_shown += 5; // Viral speed
    if (s_chars_shown > s_chars_total)
      s_chars_shown = s_chars_total;
    s_auto_scroll = true;
    layer_mark_dirty(s_canvas);
    s_stream_timer = app_timer_register(25, stream_tick, NULL);
  } else {
    s_stream_timer = NULL;
  }
}

static void start_streaming() {
  if (s_stream_timer)
    app_timer_cancel(s_stream_timer);
  s_stream_timer = app_timer_register(25, stream_tick, NULL);
}

static void inbox_received_callback(DictionaryIterator *iterator,
                                    void *context) {
  bool needs_redraw = false;

  Tuple *t = dict_find(iterator, MESSAGE_KEY_TERMINAL_DATA);
  if (t) {
    const char *data = t->value->cstring;

    // MENU:session1,session2,...
    if (strncmp(data, "MENU:", 5) == 0) {
      s_session_count = 0;
      const char *p = data + 5;
      while (*p && s_session_count < 5) {
        const char *comma = strchr(p, ',');
        int len = comma ? (int)(comma - p) : (int)strlen(p);
        if (len > 31) len = 31;
        if (len > 0) {
          memcpy(s_sessions[s_session_count], p, len);
          s_sessions[s_session_count][len] = '\0';
          s_session_count++;
        }
        if (comma) p = comma + 1;
        else break;
      }
      s_state = STATE_MENU;
      s_selected_idx = 0;
      layer_mark_dirty(s_canvas);
      return;
    }

    // SESSION:name - joined a session
    if (strncmp(data, "SESSION:", 8) == 0) {
      strncpy(s_active_session, data + 8, sizeof(s_active_session) - 1);
      s_state = STATE_SESSION;
      s_buffer[0] = '\0';
      s_chars_shown = 0;
      s_chars_total = 0;
      strncpy(s_status, "Ready", sizeof(s_status));
      layer_mark_dirty(s_canvas);
      return;
    }

    // CLEAN:cmd|summary|status|tool|suggestion|activeTask - structured data
    if (strncmp(data, "CLEAN:", 6) == 0) {
      // Reset scroll when new content arrives
      s_clean_scroll = -1;

      // Clear buffers first
      s_user_cmd[0] = '\0';
      s_claude_summary[0] = '\0';
      s_last_tool[0] = '\0';
      s_suggestion[0] = '\0';
      s_active_task[0] = '\0';
      s_task_running = false;

      const char *p = data + 6;
      const char *sep1 = strchr(p, '|');
      if (sep1) {
        int len = (int)(sep1 - p);
        if (len > 127) len = 127;
        strncpy(s_user_cmd, p, len);
        s_user_cmd[len] = '\0';
        p = sep1 + 1;
        const char *sep2 = strchr(p, '|');
        if (sep2) {
          len = (int)(sep2 - p);
          if (len > 1023) len = 1023;
          strncpy(s_claude_summary, p, len);
          s_claude_summary[len] = '\0';
          p = sep2 + 1;
          const char *sep3 = strchr(p, '|');
          if (sep3) {
            len = (int)(sep3 - p);
            if (len > 31) len = 31;
            strncpy(s_status, p, len);
            s_status[len] = '\0';
            p = sep3 + 1;
            // Parse tool and suggestion
            const char *sep4 = strchr(p, '|');
            if (sep4) {
              len = (int)(sep4 - p);
              if (len > 63) len = 63;
              strncpy(s_last_tool, p, len);
              s_last_tool[len] = '\0';
              p = sep4 + 1;
              // Suggestion (5th field) and activeTask (6th field)
              const char *sep5 = strchr(p, '|');
              if (sep5) {
                len = (int)(sep5 - p);
                if (len > 127) len = 127;
                strncpy(s_suggestion, p, len);
                s_suggestion[len] = '\0';
                p = sep5 + 1;
                // Active task (6th field)
                strncpy(s_active_task, p, sizeof(s_active_task) - 1);
                s_active_task[sizeof(s_active_task) - 1] = '\0';
                s_task_running = (s_active_task[0] != '\0');
              } else {
                strncpy(s_suggestion, p, sizeof(s_suggestion) - 1);
                s_suggestion[sizeof(s_suggestion) - 1] = '\0';
                s_active_task[0] = '\0';
                s_task_running = false;
              }
            } else {
              strncpy(s_last_tool, p, sizeof(s_last_tool) - 1);
              s_last_tool[sizeof(s_last_tool) - 1] = '\0';
            }
          } else {
            strncpy(s_status, p, sizeof(s_status) - 1);
            s_status[sizeof(s_status) - 1] = '\0';
          }
        }
      }

      layer_mark_dirty(s_canvas);
      return;
    }

    // Regular output - only in session mode
    if (s_state != STATE_SESSION) return;

    memcpy(s_prev_buffer, s_buffer, sizeof(s_prev_buffer));
    strncpy(s_buffer, data, sizeof(s_buffer) - 1);
    s_buffer[sizeof(s_buffer) - 1] = '\0';

    // FIX: Strip trailing newlines to keep cursor inline with text
    int blen = strlen(s_buffer);
    while (blen > 0 && s_buffer[blen - 1] == '\n') {
      s_buffer[blen - 1] = '\0';
      blen--;
    }

    int new_chars = count_chars();
    s_chars_total = new_chars;

    // Strategy: find the last 2 lines of old buffer to be more robust
    int old_len = (int)strlen(s_prev_buffer);

    char *search_ptr = NULL;
    if (old_len > 10) {
      // Find last line
      char *last_line = s_prev_buffer;
      char *prev_line = s_prev_buffer;
      for (char *scan = s_prev_buffer; *scan;) {
        char *nl = strchr(scan, '\n');
        if (nl) {
          prev_line = last_line;
          last_line = nl + 1;
          scan = nl + 1;
        } else
          break;
      }
      // Use last 2 lines if possible, otherwise just last
      char *anchor = (last_line - prev_line > 5) ? prev_line : last_line;
      int anchor_len = old_len - (int)(anchor - s_prev_buffer);

      if (anchor_len > 5) {
        search_ptr = strstr(s_buffer, anchor);
      }
    }

    if (search_ptr) {
      // Find how many text characters are before/at the match point
      int match_offset = (int)(search_ptr - s_buffer);
      int kept_chars = 0;
      char *pp = s_buffer;
      while (pp < (s_buffer + match_offset) && *pp) {
        char *nl = strchr(pp, '\n');
        int len = nl ? (int)(nl - pp) : (int)strlen(pp);
        if (pp + len > s_buffer + match_offset)
          len = (int)(s_buffer + match_offset - pp);
        if (len > 1)
          kept_chars += len - 1;
        pp += len;
        if (*pp == '\n') {
          pp++;
        }
      }

      // Re-sync s_chars_shown if we are falling behind or jumping ahead
      if (s_chars_shown > new_chars)
        s_chars_shown = kept_chars;
      // Only start streaming if significant new content
      if (new_chars > s_chars_shown + 2) {
        start_streaming();
      } else {
        s_chars_shown = new_chars;
      }
    } else if (old_len == 0) {
      s_chars_shown = 0;
      start_streaming();
    } else {
      // Can't match - sync instantly to avoid flicker, or stream last bit
      s_chars_shown = new_chars > 40 ? new_chars - 40 : 0;
      start_streaming();
    }

    // Only auto-scroll if we were already auto-scrolling
    if (s_auto_scroll) {
      s_auto_scroll = true; // Redundant but explicit
    }
    needs_redraw = true;
  }

  // Prompt handling
  Tuple *p = dict_find(iterator, MESSAGE_KEY_PROMPT_FLAG);
  Layer *root = window_get_root_layer(s_window);
  GRect bounds = layer_get_bounds(root);
  Tuple *pt = dict_find(iterator, MESSAGE_KEY_PROMPT_TEXT);
  if (p) {
    if (pt) {
      char *raw = pt->value->cstring;
      char *pipe = strchr(raw, '|');
      if (pipe) {
        s_prompt_keys[0] = raw[0] - '0';
        s_prompt_keys[1] = raw[2] - '0';
        s_prompt_keys[2] = raw[4] - '0';
        strncpy(s_prompt_text, pipe + 1, sizeof(s_prompt_text) - 1);
        s_prompt_text[sizeof(s_prompt_text) - 1] = '\0';
      } else {
        strncpy(s_prompt_text, raw, sizeof(s_prompt_text) - 1);
        s_prompt_text[sizeof(s_prompt_text) - 1] = '\0';
      }
    } else {
      strncpy(s_prompt_text, "^ Yes  v No", sizeof(s_prompt_text));
      s_prompt_keys[0] = 1;
      s_prompt_keys[1] = 0;
      s_prompt_keys[2] = 2;
    }
    text_layer_set_text(s_prompt_layer, s_prompt_text);
    if (!s_has_prompt) {
      s_has_prompt = true;
      layer_set_frame(s_canvas, GRect(0, 0, bounds.size.w, bounds.size.h - 14));
      layer_set_bounds(s_canvas,
                       GRect(0, 0, bounds.size.w, bounds.size.h - 14));
      layer_set_hidden(text_layer_get_layer(s_prompt_layer), false);
      vibes_short_pulse();
      needs_redraw = true;
    }
  } else if (s_has_prompt) {
    s_has_prompt = false;
    layer_set_frame(s_canvas, GRect(0, 0, bounds.size.w, bounds.size.h));
    layer_set_bounds(s_canvas, GRect(0, 0, bounds.size.w, bounds.size.h));
    layer_set_hidden(text_layer_get_layer(s_prompt_layer), true);
    needs_redraw = true;
  }

  if (needs_redraw)
    layer_mark_dirty(s_canvas);
}

static void send_msg(const char *msg) {
  DictionaryIterator *iter;
  AppMessageResult res = app_message_outbox_begin(&iter);
  if (res != APP_MSG_OK || !iter)
    return;
  dict_write_cstring(iter, MESSAGE_KEY_TERMINAL_DATA, msg);
  app_message_outbox_send();
}

static void send_key(int num) {
  if (num <= 0)
    return;
  char buf[4];
  snprintf(buf, sizeof(buf), "%d", num);
  send_msg(buf);
}

static void send_accept() { send_msg("accept"); }

static void up_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_state == STATE_MENU) {
    if (s_session_count > 0 && s_selected_idx > 0) {
      s_selected_idx--;
      layer_mark_dirty(s_canvas);
    }
    return;
  }
  if (s_has_prompt) {
    send_key(s_prompt_keys[0]);
    vibes_short_pulse();
  } else if (s_display_mode == MODE_CLEAN) {
    // CLEAN mode: UP does nothing for now (no scroll)
    vibes_short_pulse();
  } else {
    s_auto_scroll = false;
    s_scroll_offset -= s_page_step;
    if (s_scroll_offset < 0)
      s_scroll_offset = 0;
    layer_mark_dirty(s_canvas);
  }
}
static void select_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_state == STATE_MENU) {
    if (s_session_count > 0) {
      char msg[48];
      snprintf(msg, sizeof(msg), "join:%s", s_sessions[s_selected_idx]);
      send_msg(msg);
      vibes_double_pulse();
    } else {
      send_msg("list");
    }
    return;
  }
  if (s_has_prompt) {
    send_key(s_prompt_keys[1]);
    vibes_short_pulse();
  } else if (s_display_mode == MODE_CLEAN) {
    // CLEAN mode: SELECT = accept suggestion
    if (s_suggestion[0]) {
      send_accept();
      vibes_short_pulse();
    } else {
      vibes_short_pulse();
    }
  } else if (s_auto_scroll) {
    send_accept();
    vibes_short_pulse();
  } else {
    s_auto_scroll = true;
    layer_mark_dirty(s_canvas);
  }
}
static void down_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_state == STATE_MENU) {
    if (s_session_count > 0 && s_selected_idx < s_session_count - 1) {
      s_selected_idx++;
      layer_mark_dirty(s_canvas);
    }
    return;
  }
  if (s_has_prompt) {
    send_key(s_prompt_keys[2]);
    vibes_double_pulse();
  } else if (s_display_mode == MODE_CLEAN) {
    // CLEAN mode: DOWN does nothing for now (no scroll)
    vibes_short_pulse();
  } else {
    s_auto_scroll = false;
    s_scroll_offset += s_page_step;
    layer_mark_dirty(s_canvas);
  }
}
static void up_long_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_state == STATE_MENU) {
    send_msg("create");
    vibes_short_pulse();
  }
}
static void down_long_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_state == STATE_MENU) {
    send_msg("list");
    vibes_short_pulse();
  } else if (s_state == STATE_SESSION) {
    // Toggle display mode (VERBOSE <-> CLEAN)
    s_display_mode = (s_display_mode == MODE_VERBOSE) ? MODE_CLEAN : MODE_VERBOSE;
    vibes_double_pulse();
    layer_mark_dirty(s_canvas);
  }
}
static void select_long_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_state == STATE_SESSION) {
    s_state = STATE_MENU;
    send_msg("leave");
    send_msg("list");
    layer_mark_dirty(s_canvas);
    vibes_short_pulse();
  }
}

static void click_config_provider(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_long_click_subscribe(BUTTON_ID_UP, 500, up_long_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, 500, down_long_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, select_long_handler, NULL);
}

static void window_load(Window *window) {
  Layer *wl = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(wl);
  s_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);

  s_canvas = layer_create(bounds);
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(wl, s_canvas);

  s_prompt_layer =
      text_layer_create(GRect(0, bounds.size.h - 14, bounds.size.w, 14));
  text_layer_set_background_color(s_prompt_layer, GColorDarkGray);
  text_layer_set_text_color(s_prompt_layer, GColorWhite);
  text_layer_set_font(s_prompt_layer,
                      fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_prompt_layer, GTextAlignmentCenter);
  layer_set_hidden(text_layer_get_layer(s_prompt_layer), true);
  layer_add_child(wl, text_layer_get_layer(s_prompt_layer));

  strncpy(s_buffer, "C> VibeCoder\nWConnecting...", sizeof(s_buffer));
  s_chars_total = count_chars();
  s_chars_shown = 0;
  start_streaming();
  s_cursor_timer = app_timer_register(300, blink_tick, NULL);
}

static void window_unload(Window *window) {
  if (s_cursor_timer)
    app_timer_cancel(s_cursor_timer);
  if (s_stream_timer)
    app_timer_cancel(s_stream_timer);
  layer_destroy(s_canvas);
  text_layer_destroy(s_prompt_layer);
}

static void init() {
  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(
      s_window, (WindowHandlers){.load = window_load, .unload = window_unload});
  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_outbox_sent(NULL);
  app_message_register_outbox_failed(NULL);
  app_message_open(4096, 512);
  window_stack_push(s_window, true);
}
static void deinit() { window_destroy(s_window); }
int main() {
  init();
  app_event_loop();
  deinit();
}
