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

// Streaming: character count
static int s_chars_shown = 0;
static int s_chars_total = 0;
static AppTimer *s_stream_timer = NULL;

// Blinking cursor
static bool s_cursor_visible = true;
static AppTimer *s_cursor_timer = NULL;
static int s_cursor_x = 0;
static int s_cursor_y = 0;

static GFont s_font;
static int s_line_h = 0;
static int s_space_w = 0;

static GColor bg_color() { return s_dark_mode ? GColorBlack : GColorWhite; }
static GColor cursor_color() { return s_dark_mode ? GColorWhite : GColorBlack; }

static GColor color_from_code(char c) {
    if (s_dark_mode) {
        switch (c) {
            case 'W': return GColorWhite;
            case 'B': return GColorVividCerulean;
            case 'C': return GColorCyan;
            case 'R': return GColorRed;
            case 'G': return GColorMintGreen;
            case 'Y': return GColorYellow;
            case 'O': return GColorOrange;
            case 'L': return GColorLightGray;
            case 'S': return GColorDarkGray;
            default:  return GColorWhite;
        }
    } else {
        switch (c) {
            case 'W': return GColorBlack;
            case 'B': return GColorCobaltBlue;
            case 'C': return GColorBlueMoon;
            case 'R': return GColorBulgarianRose;
            case 'G': return GColorDarkGreen;
            case 'Y': return GColorWindsorTan;
            case 'O': return GColorOrange;
            case 'L': return GColorDarkGray;
            case 'S': return GColorDarkGray;
            default:  return GColorBlack;
        }
    }
}

static int measure_word(const char *word) {
    GSize s = graphics_text_layout_get_content_size(
        word, s_font, GRect(0, 0, 200, 50),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
    return s.w;
}

static void init_metrics() {
    if (s_line_h > 0) return;
    GSize s = graphics_text_layout_get_content_size(
        "Ag", s_font, GRect(0, 0, 200, 50),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
    s_line_h = s.h;
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
        if (len > 1) count += len - 1;  // skip color code char
        if (nl) p = nl + 1; else break;
    }
    return count;
}

// Fade colors for streaming edge
static GColor fade_color(int steps_from_end) {
    if (s_dark_mode) {
        switch (steps_from_end) {
            case 0: return GColorDarkGray;
            case 1: return GColorLightGray;
            default: return GColorWhite;
        }
    } else {
        switch (steps_from_end) {
            case 0: return GColorLightGray;
            case 1: return GColorDarkGray;
            default: return GColorBlack;
        }
    }
}

// Single pass: measure or draw, limited to max_chars of text content
// mode: 0=measure only, 1=draw, 2=draw+cursor
static int flow_pass(GContext *ctx, int screen_w, int screen_h, int max_chars, int mode) {
    int x = 0, y = (mode > 0) ? -s_scroll_offset : 0;
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
                    base_color = s_cursor_visible ?
                        (s_dark_mode ? GColorLightGray : GColorDarkGray) : bg_color();
                } else {
                    base_color = color_from_code(p[0]);
                }
            }

            int tlen = len - 1;
            if (tlen > 255) tlen = 255;
            memcpy(seg, p + 1, tlen);
            seg[tlen] = '\0';

            char *wp = seg;
            while (*wp) {
                while (*wp == ' ') { wp++; char_idx++; if (char_idx >= max_chars) goto done; }
                if (!*wp) break;
                char *we = wp;
                while (*we && *we != ' ') we++;
                char saved = *we;
                *we = '\0';

                int word_len = (int)(we - wp);
                int chars_left = max_chars - char_idx;
                bool truncated = false;
                char *draw_str = wp;

                if (word_len > chars_left) {
                    // Partial word - copy and truncate
                    int plen = chars_left < 63 ? chars_left : 63;
                    memcpy(partial, wp, plen);
                    partial[plen] = '\0';
                    draw_str = partial;
                    word_len = plen;
                    truncated = true;
                }

                int ww = measure_word(draw_str);
                if (x > 0 && x + s_space_w + ww > screen_w) {
                    x = 0; y += s_line_h;
                }
                if (x > 0) x += s_space_w;

                if (mode > 0 && y + s_line_h > 0 && y < screen_h) {
                    GColor draw_color = base_color;
                    if (is_suggestion) {
                        // Force blink: override everything
                        draw_color = s_cursor_visible ?
                            (s_dark_mode ? GColorLightGray : GColorDarkGray) : bg_color();
                    } else if (streaming) {
                        int dist = max_chars - char_idx - word_len;
                        if (dist < 8) {
                            int fade_step = dist / 3;
                            if (fade_step < 2) draw_color = fade_color(fade_step);
                        }
                    }
                    graphics_context_set_text_color(ctx, draw_color);
                    graphics_draw_text(ctx, draw_str, s_font,
                        GRect(x + 2, y, ww + 4, s_line_h),
                        GTextOverflowModeTrailingEllipsis,
                        GTextAlignmentLeft, NULL);
                }
                x += ww;
                char_idx += word_len;

                *we = saved;
                if (truncated || char_idx >= max_chars) goto done;
                wp = we;
            }
        }
        if (nl) p = nl + 1; else break;
    }

done:
    if (mode == 2) {
        s_cursor_x = x;
        s_cursor_y = y;
    }
    return y + s_line_h + ((mode > 0) ? s_scroll_offset : 0);
}

static void canvas_update(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);
    graphics_context_set_fill_color(ctx, bg_color());
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    if (s_buffer[0] == '\0') return;
    if (!s_font) s_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
    init_metrics();

    int w = bounds.size.w - 4;
    int h = s_has_prompt ? (bounds.size.h - 5) : (bounds.size.h - 2);

    int show = s_chars_shown < s_chars_total ? s_chars_shown : s_chars_total;

    // Measure height (no draw)
    s_total_height = flow_pass(NULL, w, h, show, 0);

    int max_scroll = s_total_height - h;
    if (max_scroll < 0) max_scroll = 0;
    if (s_auto_scroll) {
        s_scroll_offset = max_scroll;
    } else {
        if (s_scroll_offset > max_scroll) s_scroll_offset = max_scroll;
        if (s_scroll_offset < 0) s_scroll_offset = 0;
    }

    // Draw + get cursor position
    flow_pass(ctx, w, h, show, 2);

    // Blinking cursor block - aligned to text baseline
    if (s_cursor_visible && s_cursor_y + s_line_h > 0 && s_cursor_y < h) {
        graphics_context_set_fill_color(ctx, cursor_color());
        graphics_fill_rect(ctx, GRect(s_cursor_x + 6, s_cursor_y + s_line_h - 7, 7, 7), 0, GCornerNone);
    }
}

// Cursor blink
static void cursor_blink(void *data) {
    s_cursor_visible = !s_cursor_visible;
    layer_mark_dirty(s_canvas);
    s_cursor_timer = app_timer_register(500, cursor_blink, NULL);
}

// Streaming timer - characters per tick
static void stream_tick(void *data) {
    if (s_chars_shown < s_chars_total) {
        s_chars_shown += 3;  // 3 chars per 25ms = visible letter-by-letter
        if (s_chars_shown > s_chars_total) s_chars_shown = s_chars_total;
        s_auto_scroll = true;
        layer_mark_dirty(s_canvas);
        s_stream_timer = app_timer_register(25, stream_tick, NULL);
    } else {
        s_stream_timer = NULL;
    }
}

static void start_streaming() {
    if (s_stream_timer) app_timer_cancel(s_stream_timer);
    s_stream_timer = app_timer_register(25, stream_tick, NULL);
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
    bool needs_redraw = false;

    Tuple *t = dict_find(iterator, MESSAGE_KEY_TERMINAL_DATA);
    if (t) {
        memcpy(s_prev_buffer, s_buffer, sizeof(s_prev_buffer));
        strncpy(s_buffer, t->value->cstring, sizeof(s_buffer) - 1);
        s_buffer[sizeof(s_buffer) - 1] = '\0';

        int new_chars = count_chars();
        s_chars_total = new_chars;

        // Strategy: find the last line of old buffer, search for it in new buffer.
        // Everything after that match point = new content to stream.
        int old_len = (int)strlen(s_prev_buffer);
        int new_len = (int)strlen(s_buffer);

        // Find last line of old buffer
        char *old_last = s_prev_buffer;
        for (char *scan = s_prev_buffer; *scan; ) {
            char *nl = strchr(scan, '\n');
            if (nl) { old_last = nl + 1; scan = nl + 1; }
            else break;
        }
        int old_last_len = old_len - (int)(old_last - s_prev_buffer);

        // Search for old's last line in new buffer
        char *match = NULL;
        if (old_last_len > 3) {
            match = strstr(s_buffer, old_last);
        }

        if (match) {
            // Count chars from buffer start to end of matched line
            int match_end = (int)(match - s_buffer) + old_last_len;
            // Find next newline after match to get to end of that line in new
            char *after = s_buffer + match_end;
            // Count text chars up to this point
            int kept_chars = 0;
            char *pp = s_buffer;
            while (pp < after && *pp) {
                char *nl = strchr(pp, '\n');
                if (!nl || nl >= after) {
                    int llen = (int)(after - pp);
                    if (llen > 1) kept_chars += llen - 1;
                    break;
                }
                int llen = (int)(nl - pp);
                if (llen > 1) kept_chars += llen - 1;
                pp = nl + 1;
            }
            if (kept_chars < new_chars) {
                // Show kept part instantly, stream new tail
                // But ensure at least 50 chars stream for visible effect
                int new_part = new_chars - kept_chars;
                if (new_part < 50) kept_chars = new_chars > 50 ? new_chars - 50 : 0;
                s_chars_shown = kept_chars;
                start_streaming();
            } else {
                // Nothing new
                s_chars_shown = new_chars;
            }
        } else if (old_len == 0) {
            // First content ever - stream from 0
            s_chars_shown = 0;
            start_streaming();
        } else {
            // Can't find old content - stream last 80 chars
            s_chars_shown = new_chars > 80 ? new_chars - 80 : 0;
            start_streaming();
        }

        s_auto_scroll = true;
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
            s_prompt_keys[0] = 1; s_prompt_keys[1] = 0; s_prompt_keys[2] = 2;
        }
        text_layer_set_text(s_prompt_layer, s_prompt_text);
        if (!s_has_prompt) {
            s_has_prompt = true;
            layer_set_frame(s_canvas, GRect(0, 0, bounds.size.w, bounds.size.h - 18));
            layer_set_bounds(s_canvas, GRect(0, 0, bounds.size.w, bounds.size.h - 18));
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

    if (needs_redraw) layer_mark_dirty(s_canvas);
}

static bool has_suggestion() {
    char *last = s_buffer;
    char *p = s_buffer;
    while (*p) {
        char *nl = strchr(p, '\n');
        if (nl) { last = nl + 1; p = nl + 1; }
        else break;
    }
    return (*last == 'S');
}

static void send_msg(const char *msg) {
    DictionaryIterator *iter;
    AppMessageResult res = app_message_outbox_begin(&iter);
    if (res != APP_MSG_OK || !iter) return;
    dict_write_cstring(iter, MESSAGE_KEY_TERMINAL_DATA, msg);
    app_message_outbox_send();
}

static void send_key(int num) {
    if (num <= 0) return;
    char buf[4];
    snprintf(buf, sizeof(buf), "%d", num);
    send_msg(buf);
}

static void send_accept() {
    send_msg("accept");
}

static void up_click_handler(ClickRecognizerRef recognizer, void *ctx) {
    if (s_has_prompt) { send_key(s_prompt_keys[0]); vibes_short_pulse(); }
    else { s_auto_scroll = false; s_scroll_offset -= 168; if (s_scroll_offset < 0) s_scroll_offset = 0; layer_mark_dirty(s_canvas); }
}
static void select_click_handler(ClickRecognizerRef recognizer, void *ctx) {
    if (s_has_prompt) {
        send_key(s_prompt_keys[1]); vibes_short_pulse();
    } else if (s_auto_scroll) {
        send_accept(); vibes_short_pulse();
    } else {
        s_auto_scroll = true; layer_mark_dirty(s_canvas);
    }
}
static void down_click_handler(ClickRecognizerRef recognizer, void *ctx) {
    if (s_has_prompt) { send_key(s_prompt_keys[2]); vibes_double_pulse(); }
    else { s_auto_scroll = false; s_scroll_offset += 168; layer_mark_dirty(s_canvas); }
}
static void back_long_handler(ClickRecognizerRef recognizer, void *ctx) {
    s_dark_mode = !s_dark_mode;
    window_set_background_color(s_window, bg_color());
    text_layer_set_background_color(s_prompt_layer, s_dark_mode ? GColorDarkGray : GColorLightGray);
    text_layer_set_text_color(s_prompt_layer, s_dark_mode ? GColorWhite : GColorBlack);
    vibes_short_pulse();
    layer_mark_dirty(s_canvas);
}

static void click_config_provider(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
    window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
    window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
    window_long_click_subscribe(BUTTON_ID_UP, 700, back_long_handler, NULL);
}

static void window_load(Window *window) {
    Layer *wl = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(wl);
    s_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);

    s_canvas = layer_create(bounds);
    layer_set_update_proc(s_canvas, canvas_update);
    layer_add_child(wl, s_canvas);

    s_prompt_layer = text_layer_create(GRect(0, bounds.size.h - 18, bounds.size.w, 18));
    text_layer_set_background_color(s_prompt_layer, GColorDarkGray);
    text_layer_set_text_color(s_prompt_layer, GColorWhite);
    text_layer_set_font(s_prompt_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text_alignment(s_prompt_layer, GTextAlignmentCenter);
    layer_set_hidden(text_layer_get_layer(s_prompt_layer), true);
    layer_add_child(wl, text_layer_get_layer(s_prompt_layer));

    strncpy(s_buffer, "C> VibeCoder\nWConnecting...", sizeof(s_buffer));
    s_chars_total = count_chars();
    s_chars_shown = 0;
    start_streaming();
    s_cursor_timer = app_timer_register(500, cursor_blink, NULL);
}

static void window_unload(Window *window) {
    if (s_cursor_timer) app_timer_cancel(s_cursor_timer);
    if (s_stream_timer) app_timer_cancel(s_stream_timer);
    layer_destroy(s_canvas);
    text_layer_destroy(s_prompt_layer);
}

static void init() {
    s_window = window_create();
    window_set_background_color(s_window, GColorBlack);
    window_set_click_config_provider(s_window, click_config_provider);
    window_set_window_handlers(s_window, (WindowHandlers){.load = window_load, .unload = window_unload});
    app_message_register_inbox_received(inbox_received_callback);
    app_message_register_outbox_sent(NULL);
    app_message_register_outbox_failed(NULL);
    app_message_open(4096, 512);
    window_stack_push(s_window, true);
}
static void deinit() { window_destroy(s_window); }
int main() { init(); app_event_loop(); deinit(); }
