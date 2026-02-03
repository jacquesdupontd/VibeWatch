#include <pebble.h>

static Window *s_window;
static Layer *s_canvas_layer;

// State
static char s_display_text[32];
static int s_char_pos = 0;
static bool s_cursor_visible = true;
static int s_phase = 0;  // 0=time, 1=date, 2=ready to, 3=vibecode glitch
static bool s_typing = true;
static int s_pause_counter = 0;
static int s_glitch_counter = 0;
static int s_glitch_font_idx = 0;
static GColor s_glitch_color;
static GColor s_bg_color;
static int s_cursor_size = 12;  // Grows during glitch
static int s_cursor_offset_x = 0;  // Random offset during glitch
static int s_cursor_offset_y = 0;
static int s_cursor_shape = 0;  // 0=square, 1=wide, 2=tall, 3=circle

// CHAOS SYSTEM - 60 levels based on minute
static int s_chaos_level = 0;      // 0-5 (minute / 10)
static int s_chaos_intensity = 0;  // 0-9 (minute % 10)
static int s_current_minute = 0;
static int s_current_hour = 0;
static int s_text_shake_x = 0;     // Text shake offset
static int s_text_shake_y = 0;
static int s_scanline_offset = 0;  // For scanline effect
static bool s_is_special_time = false;
static int s_special_mode = 0;     // 0=none, 1=midnight, 2=420, 3=1111, 4=1337

// Messages
static char s_time_str[16];
static char s_date_str[16];
static const char *READY_TO = "ready to";
static const char *VIBECODE = "vibecode";

// Alternative taglines for variety (used at chaos level 2+)
static const char *TAGLINES[] = {
    "vibecode",
    "let's code",
    "hack mode",
    "building...",
    "shipping",
    "creating...",
};
static const int NUM_TAGLINES = 6;

// Glitch words - meaningful words that flash during chaos
static const char *GLITCH_WORDS[] = {
    "vibecode",
    "create",
    "build",
    "ship it",
    "hack",
    "code",
    "vibe",
    "chaos",
    "flow",
    "make",
    "dream",
    "do it",
};
static const int NUM_GLITCH_WORDS = 12;

// First loop flag - ensures first cycle shows "vibecode"
static bool s_first_loop = true;

// Available fonts for glitch
static const char* FONT_KEYS[] = {
    FONT_KEY_GOTHIC_28_BOLD,
    FONT_KEY_GOTHIC_24_BOLD,
    FONT_KEY_BITHAM_30_BLACK,
    FONT_KEY_ROBOTO_CONDENSED_21,
    FONT_KEY_GOTHIC_28,
    FONT_KEY_DROID_SERIF_28_BOLD,
};
static const int NUM_FONTS = 6;

// Glitch colors - more intense at higher chaos levels
static GColor get_random_color() {
    // At chaos level 5+, add more extreme colors
    int max_colors = 7 + s_chaos_level;
    if (max_colors > 11) max_colors = 11;

    int r = rand() % max_colors;
    switch (r) {
        case 0: return GColorWhite;
        case 1: return GColorCyan;
        case 2: return GColorMagenta;
        case 3: return GColorYellow;
        case 4: return GColorMalachite;
        case 5: return GColorVividCerulean;
        case 6: return GColorOrange;
        case 7: return GColorRed;
        case 8: return GColorShockingPink;
        case 9: return GColorSpringBud;
        case 10: return GColorElectricBlue;
        default: return GColorWhite;
    }
}

// Time context for richer easter eggs
static int s_current_day = 0;      // 0=Sunday, 1=Monday, etc.
static int s_current_month = 0;    // 0=Jan, 11=Dec
static int s_current_date = 0;     // 1-31
static int s_time_of_day = 0;      // 0=night, 1=morning, 2=work, 3=evening

// Context-aware glitch words
static const char *NIGHT_WORDS[] = {"dream", "sleep", "stars", "moon", "rest"};
static const char *MORNING_WORDS[] = {"coffee", "wake up", "rise", "begin", "fresh"};
static const char *WORK_WORDS[] = {"focus", "build", "create", "ship it", "grind"};
static const char *EVENING_WORDS[] = {"done", "relax", "chill", "unwind", "vibe"};
static const char *WEEKEND_WORDS[] = {"freedom", "party", "enjoy", "lazy", "fun"};

// Check for special times (easter eggs)
static void check_special_time() {
    s_is_special_time = false;
    s_special_mode = 0;

    // === TIME-BASED ===
    if (s_current_hour == 0 && s_current_minute == 0) {
        s_is_special_time = true;
        s_special_mode = 1;  // Midnight - "new loop"
    } else if (s_current_hour == 4 && s_current_minute == 20) {
        s_is_special_time = true;
        s_special_mode = 2;  // 4:20 - Green mode
    } else if (s_current_hour == 11 && s_current_minute == 11) {
        s_is_special_time = true;
        s_special_mode = 3;  // 11:11 - Make a wish
    } else if (s_current_hour == 13 && s_current_minute == 37) {
        s_is_special_time = true;
        s_special_mode = 4;  // 13:37 - Hacker mode
    } else if (s_current_hour == 22 && s_current_minute == 22) {
        s_is_special_time = true;
        s_special_mode = 5;  // 22:22 - "sync"
    } else if (s_current_hour == s_current_minute && s_current_hour < 24) {
        // Any matching hour:minute (01:01, 02:02, etc.)
        s_special_mode = 6;  // Subtle sync mode
    }

    // === DAY-BASED ===
    if (s_current_day == 1 && s_current_hour == 9 && s_current_minute < 30) {
        s_special_mode = 10;  // Monday 9am - "coffee"
    } else if (s_current_day == 5 && s_current_hour == 17) {
        s_special_mode = 11;  // Friday 5pm - "freedom!"
    } else if (s_current_day == 5 && s_current_date == 13) {
        s_special_mode = 12;  // Friday 13th - spooky mode
    }

    // === DATE-BASED ===
    if (s_current_month == 0 && s_current_date == 1) {
        s_special_mode = 20;  // Jan 1 - New Year
    } else if (s_current_month == 1 && s_current_date == 14) {
        s_special_mode = 21;  // Feb 14 - Valentine
    } else if (s_current_month == 9 && s_current_date == 31) {
        s_special_mode = 22;  // Oct 31 - Halloween
    } else if (s_current_month == 11 && s_current_date == 25) {
        s_special_mode = 23;  // Dec 25 - Christmas
    } else if (s_current_month == 11 && s_current_date == 31) {
        s_special_mode = 24;  // Dec 31 - NYE countdown
    }

    // === MINUTE 42 - Answer to everything ===
    if (s_current_minute == 42) {
        s_special_mode = 42;
    }

    // === TIME OF DAY ===
    if (s_current_hour >= 0 && s_current_hour < 6) {
        s_time_of_day = 0;  // Night
    } else if (s_current_hour >= 6 && s_current_hour < 12) {
        s_time_of_day = 1;  // Morning
    } else if (s_current_hour >= 12 && s_current_hour < 18) {
        s_time_of_day = 2;  // Work/Afternoon
    } else {
        s_time_of_day = 3;  // Evening
    }
}

// Get chaos-adjusted glitch duration
static int get_glitch_duration() {
    // Base: 80-100, scales up with chaos
    return 80 + (s_chaos_level * 20) + (s_chaos_intensity * 2);
}

// Calculate text shake based on chaos
static void update_text_shake() {
    if (s_chaos_level == 0) {
        // Even at level 0: rare micro-shake (5% chance, ±1px)
        if (rand() % 20 == 0) {
            s_text_shake_x = (rand() % 3) - 1;
            s_text_shake_y = (rand() % 3) - 1;
        } else {
            s_text_shake_x = 0;
            s_text_shake_y = 0;
        }
    } else if (s_chaos_level < 3) {
        // Subtle but VISIBLE shake (±2px)
        int range = 2 + s_chaos_level;
        s_text_shake_x = (rand() % (range * 2 + 1)) - range;
        s_text_shake_y = (rand() % (range * 2 + 1)) - range;
    } else if (s_chaos_level < 5) {
        // More noticeable (±5px)
        int range = 3 + s_chaos_level + s_chaos_intensity / 3;
        s_text_shake_x = (rand() % (range * 2 + 1)) - range;
        s_text_shake_y = (rand() % (range * 2 + 1)) - range;
    } else {
        // Full chaos - constant trembling (±8px)
        int range = 6 + s_chaos_intensity / 2;
        s_text_shake_x = (rand() % (range * 2 + 1)) - range;
        s_text_shake_y = (rand() % (range * 2 + 1)) - range;
    }
}

static void update_strings() {
    time_t now = time(NULL);
    struct tm *t = localtime(&now);
    strftime(s_time_str, sizeof(s_time_str), "%H:%M", t);
    strftime(s_date_str, sizeof(s_date_str), "%a %b %d", t);

    // Update chaos levels
    s_current_minute = t->tm_min;
    s_current_hour = t->tm_hour;
    s_chaos_level = s_current_minute / 10;      // 0-5
    s_chaos_intensity = s_current_minute % 10;  // 0-9

    // Update date context
    s_current_day = t->tm_wday;    // 0=Sunday, 1=Monday, etc.
    s_current_month = t->tm_mon;   // 0=Jan, 11=Dec
    s_current_date = t->tm_mday;   // 1-31

    check_special_time();
}

static const char* get_current_message() {
    switch (s_phase) {
        case 0: return s_time_str;
        case 1: return s_date_str;
        case 2: return READY_TO;
        case 3: {
            // FIRST LOOP = always "vibecode" (for viral video hook)
            if (s_first_loop) {
                return VIBECODE;
            }

            // === SPECIAL TIME MESSAGES ===
            switch (s_special_mode) {
                case 1: return "new loop!";     // Midnight
                case 3: return "make wish";     // 11:11
                case 4: return "1337 h4x";      // 13:37
                case 5: return "in sync";       // 22:22
                case 6: return "aligned";       // Any XX:XX
                case 10: return "coffee...";    // Monday 9am
                case 11: return "freedom!";     // Friday 5pm
                case 12: return "spooky";       // Friday 13th
                case 20: return "new year!";    // Jan 1
                case 21: return "love <3";      // Feb 14
                case 22: return "boo!";         // Halloween
                case 23: return "ho ho ho";     // Christmas
                case 24: return "countdown";    // Dec 31
                case 42: return "42";           // The Answer
                default: break;
            }

            // Chaos level affects tagline variety
            if (s_chaos_level >= 2 && (rand() % 10) < s_chaos_level) {
                return TAGLINES[rand() % NUM_TAGLINES];
            }
            return VIBECODE;
        }
        default: return s_time_str;
    }
}

static void canvas_update_proc(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);

    // Background - changes based on chaos and glitch state
    GColor bg = s_bg_color;

    // Background flicker - even at level 0, rare winks
    if (s_phase != 3) {
        int flicker_chance;
        if (s_chaos_level == 0) {
            flicker_chance = 100;  // 1% chance
        } else if (s_chaos_level < 3) {
            flicker_chance = 30 - s_chaos_level * 5;  // 3-7% chance
        } else {
            flicker_chance = 15 - s_chaos_level;  // 10-15% chance
        }
        if (rand() % flicker_chance == 0) {
            bg = (rand() % 2) ? GColorDarkGray : GColorBlack;
        }
    }

    // Special mode backgrounds
    switch (s_special_mode) {
        case 2: bg = GColorIslamicGreen; break;           // 4:20 green
        case 12: bg = GColorDarkGray; break;              // Friday 13th dark
        case 21: bg = GColorDarkCandyAppleRed; break;     // Valentine red
        case 22: bg = GColorOrange; break;                // Halloween orange
        case 23:                                          // Christmas alternating
            bg = (rand() % 2) ? GColorDarkGreen : GColorDarkCandyAppleRed;
            break;
        default: break;
    }

    graphics_context_set_fill_color(ctx, bg);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    // Scanline effect - starts at level 2, more intense at higher levels
    bool show_scanlines = false;
    if (s_chaos_level >= 4) {
        show_scanlines = true;  // Always at level 4+
    } else if (s_chaos_level >= 2) {
        show_scanlines = (rand() % 3) == 0;  // 33% at level 2-3
    } else if (s_chaos_level >= 1) {
        show_scanlines = (rand() % 10) == 0;  // 10% at level 1
    } else {
        show_scanlines = (rand() % 50) == 0;  // 2% rare wink at level 0
    }

    if (show_scanlines) {
        graphics_context_set_fill_color(ctx, GColorDarkGray);
        int spacing = 6 - s_chaos_level;  // Denser scanlines at higher chaos
        if (spacing < 2) spacing = 2;
        for (int i = s_scanline_offset; i < bounds.size.h; i += spacing) {
            graphics_fill_rect(ctx, GRect(0, i, bounds.size.w, 1), 0, GCornerNone);
        }
        s_scanline_offset = (s_scanline_offset + 1) % spacing;
    }

    // Font selection - occasional variations even at low chaos
    GFont font;
    GColor text_color = GColorWhite;

    if (s_phase == 3 && s_glitch_counter > 0) {
        font = fonts_get_system_font(FONT_KEYS[s_glitch_font_idx]);
        text_color = s_glitch_color;
    } else if (s_phase != 0) {  // Never glitch the time font
        int font_glitch_chance;
        if (s_chaos_level >= 4) {
            font_glitch_chance = 3;  // 33%
        } else if (s_chaos_level >= 2) {
            font_glitch_chance = 15;  // 7%
        } else {
            font_glitch_chance = 50;  // 2% rare wink
        }
        if (rand() % font_glitch_chance == 0) {
            font = fonts_get_system_font(FONT_KEYS[rand() % NUM_FONTS]);
        } else {
            font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
        }
    } else {
        font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
    }

    // Text color instability - rare winks even at level 0
    if (s_phase != 0) {  // Never glitch time color (except via special modes)
        int color_glitch_chance;
        if (s_chaos_level >= 4) {
            color_glitch_chance = 5;   // 20%
        } else if (s_chaos_level >= 2) {
            color_glitch_chance = 20;  // 5%
        } else {
            color_glitch_chance = 80;  // 1.25% rare wink
        }
        if (rand() % color_glitch_chance == 0) {
            text_color = get_random_color();
        }
    }

    // Special mode colors
    switch (s_special_mode) {
        case 2: text_color = GColorMalachite; break;        // 4:20 green
        case 4: text_color = GColorCyan; break;             // 1337 cyan hacker
        case 10: text_color = GColorRajah; break;           // Monday coffee brown-ish
        case 11: text_color = GColorYellow; break;          // Friday freedom yellow
        case 12: text_color = GColorRed; break;             // Friday 13th red
        case 21: text_color = GColorMagenta; break;         // Valentine pink
        case 22: text_color = GColorBlack; break;           // Halloween black on orange
        case 23: text_color = GColorWhite; break;           // Christmas white
        case 42: text_color = GColorVividCerulean; break;   // 42 - deep thought blue
        default: break;
    }

    // Night mode = dimmer colors
    if (s_time_of_day == 0 && s_special_mode == 0) {
        text_color = GColorLightGray;
    }

    const int CURSOR_GAP = 4;
    int y = 59;

    // Apply text shake (but time always readable - less shake)
    int shake_x = s_text_shake_x;
    int shake_y = s_text_shake_y;
    if (s_phase == 0) {
        // Time is always more stable
        shake_x = shake_x / 3;
        shake_y = shake_y / 3;
    }

    // Draw text with shake
    graphics_context_set_text_color(ctx, text_color);
    graphics_draw_text(ctx, s_display_text, font,
        GRect(shake_x, y + shake_y, bounds.size.w, 40),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    // Draw cursor
    if (s_cursor_visible) {
        GSize cursor_text_size = graphics_text_layout_get_content_size(
            s_display_text, font,
            GRect(0, 0, bounds.size.w, bounds.size.h),
            GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);

        int cursor_x, cursor_y;

        if (s_cursor_size >= bounds.size.w) {
            // Full screen cursor - centered
            cursor_x = 0;
            cursor_y = 0;
            graphics_context_set_fill_color(ctx, text_color);
            graphics_fill_rect(ctx, bounds, 0, GCornerNone);
            // Redraw text on top with contrasting color
            GColor contrast = (s_chaos_level >= 5) ? get_random_color() : s_bg_color;
            graphics_context_set_text_color(ctx, contrast);
            graphics_draw_text(ctx, s_display_text, font,
                GRect(shake_x, y + shake_y, bounds.size.w, 40),
                GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
        } else {
            if (strlen(s_display_text) == 0) {
                cursor_x = bounds.size.w / 2 - s_cursor_size / 2;
            } else {
                cursor_x = (bounds.size.w + cursor_text_size.w) / 2 + CURSOR_GAP;
            }
            cursor_y = y + 16 - (s_cursor_size - 12) / 2;

            // Apply random offset during glitch
            cursor_x += s_cursor_offset_x;
            cursor_y += s_cursor_offset_y;

            // Keep cursor on screen
            if (cursor_x < 0) cursor_x = 0;
            if (cursor_x + s_cursor_size > bounds.size.w) {
                cursor_x = bounds.size.w - s_cursor_size;
            }
            if (cursor_y < 0) cursor_y = 0;
            if (cursor_y + s_cursor_size > bounds.size.h) {
                cursor_y = bounds.size.h - s_cursor_size;
            }

            // Draw cursor with morphing shapes during glitch
            graphics_context_set_fill_color(ctx, text_color);
            switch (s_cursor_shape) {
                case 1:  // Wide rectangle
                    graphics_fill_rect(ctx, GRect(cursor_x, cursor_y + s_cursor_size/4,
                        s_cursor_size * 2, s_cursor_size / 2), 0, GCornerNone);
                    break;
                case 2:  // Tall rectangle
                    graphics_fill_rect(ctx, GRect(cursor_x + s_cursor_size/4, cursor_y,
                        s_cursor_size / 2, s_cursor_size * 2), 0, GCornerNone);
                    break;
                case 3:  // Circle
                    graphics_fill_circle(ctx, GPoint(cursor_x + s_cursor_size/2, cursor_y + s_cursor_size/2),
                        s_cursor_size / 2);
                    break;
                default:  // Square
                    graphics_fill_rect(ctx, GRect(cursor_x, cursor_y, s_cursor_size, s_cursor_size), 0, GCornerNone);
                    break;
            }
        }
    }
}

static void animation_tick(void *context);

static void next_phase() {
    s_phase = (s_phase + 1) % 4;
    if (s_phase == 0) {
        update_strings();
    }
    s_char_pos = 0;
    s_display_text[0] = '\0';
    s_typing = true;
    s_pause_counter = 0;
    s_glitch_counter = 0;
    s_cursor_size = 12;  // Reset cursor size
    s_cursor_offset_x = 0;
    s_cursor_offset_y = 0;
    s_bg_color = GColorBlack;  // Reset background
}

static void glitch_tick(void *context) {
    int max_glitch = get_glitch_duration();

    if (s_glitch_counter >= max_glitch) {
        // Glitch done, mark first loop complete
        s_first_loop = false;
        next_phase();
        app_timer_register(100, animation_tick, NULL);
        return;
    }

    // Update text shake during glitch
    update_text_shake();

    // Flash meaningful words during glitch - MORE variety
    // Change words more frequently (every 3 ticks instead of 5)
    if (s_glitch_counter % 3 == 0) {
        int word_choice = rand() % 10;
        if (word_choice < 3) {
            // 30%: Context-aware word based on time of day / weekend
            bool is_weekend = (s_current_day == 0 || s_current_day == 6);
            if (is_weekend) {
                strncpy(s_display_text, WEEKEND_WORDS[rand() % 5], sizeof(s_display_text));
            } else {
                switch (s_time_of_day) {
                    case 0: strncpy(s_display_text, NIGHT_WORDS[rand() % 5], sizeof(s_display_text)); break;
                    case 1: strncpy(s_display_text, MORNING_WORDS[rand() % 5], sizeof(s_display_text)); break;
                    case 2: strncpy(s_display_text, WORK_WORDS[rand() % 5], sizeof(s_display_text)); break;
                    case 3: strncpy(s_display_text, EVENING_WORDS[rand() % 5], sizeof(s_display_text)); break;
                }
            }
        } else if (word_choice < 5) {
            // 20%: Generic glitch word
            strncpy(s_display_text, GLITCH_WORDS[rand() % NUM_GLITCH_WORDS], sizeof(s_display_text));
        } else {
            // 50%: Keep vibecode (still recognizable but more variety)
            strncpy(s_display_text, VIBECODE, sizeof(s_display_text));
        }
    }

    // Random font and color every tick
    s_glitch_font_idx = rand() % NUM_FONTS;
    s_glitch_color = get_random_color();

    // Cursor visibility - more chaotic at higher chaos levels
    int visibility_threshold = 3 - s_chaos_level / 2;
    if (visibility_threshold < 1) visibility_threshold = 1;
    s_cursor_visible = (rand() % visibility_threshold) != 0;

    // Calculate phase thresholds based on total glitch duration
    int phase1_end = max_glitch * 30 / 100;
    int phase2_end = max_glitch * 70 / 100;

    // More cursor shapes at higher chaos
    int max_shapes = 4 + (s_chaos_level >= 4 ? 1 : 0);  // 5 shapes at high chaos
    s_cursor_shape = rand() % max_shapes;

    // Growth speed scales with chaos
    int growth_multiplier = 1 + s_chaos_level / 2;

    if (s_glitch_counter < phase1_end) {
        // Phase 1: Cursor grows slowly, starts moving around
        s_cursor_size = 12 + s_glitch_counter * growth_multiplier;
        // Movement range increases with chaos
        int range = 30 + s_chaos_level * 10;
        s_cursor_offset_x = (rand() % (range * 2)) - range;
        s_cursor_offset_y = (rand() % (range * 2)) - range;
        s_bg_color = GColorBlack;
    } else if (s_glitch_counter < phase2_end) {
        // Phase 2: Cursor grows faster, goes ANYWHERE on screen
        int base_size = 42 + (s_chaos_level * 10);
        s_cursor_size = base_size + (s_glitch_counter - phase1_end) * 2 * growth_multiplier;
        // Full screen random position - wilder at higher chaos
        int wild_range = 84 + s_chaos_level * 20;
        s_cursor_offset_x = (rand() % (wild_range * 2)) - wild_range - 40;
        s_cursor_offset_y = (rand() % (wild_range * 2)) - wild_range - 40;

        // At chaos 4+, background starts flickering in phase 2
        if (s_chaos_level >= 4 && (rand() % 5) == 0) {
            s_bg_color = get_random_color();
        } else {
            s_bg_color = GColorBlack;
        }
    } else {
        // Phase 3: Full screen mode - background flashes with cursor
        s_cursor_size = 200 + s_chaos_level * 20;
        s_cursor_offset_x = 0;
        s_cursor_offset_y = 0;
        s_bg_color = get_random_color();

        // At highest chaos, even more extreme effects
        if (s_chaos_level >= 5) {
            // Multi-flash effect
            if ((rand() % 3) == 0) {
                s_cursor_shape = rand() % 4;
            } else {
                s_cursor_shape = 0;  // Square for full screen
            }
        } else {
            s_cursor_shape = 0;
        }
    }

    s_glitch_counter++;
    layer_mark_dirty(s_canvas_layer);

    // Vary speed - faster at higher chaos levels
    int delay;
    int speed_bonus = s_chaos_level * 5;

    if (s_glitch_counter < phase1_end) {
        delay = 50 - speed_bonus + (rand() % 30);
    } else if (s_glitch_counter < phase2_end) {
        delay = 40 - speed_bonus + (rand() % 30);
    } else {
        // Full screen slightly slower for impact, but faster at high chaos
        delay = 60 - speed_bonus + (rand() % 40);
    }

    // Minimum delay
    if (delay < 16) delay = 16;  // ~60fps max

    app_timer_register(delay, glitch_tick, NULL);
}

// Typing error characters for glitchy effect
static const char GLITCH_CHARS[] = "!@#$%^&*<>?";

static void animation_tick(void *context) {
    // Update text shake - even at low chaos, occasional updates for micro-winks
    if (s_chaos_level >= 5) {
        update_text_shake();  // Every tick
    } else if (s_chaos_level >= 3) {
        if ((rand() % 3) == 0) update_text_shake();  // 33%
    } else if (s_chaos_level >= 1) {
        if ((rand() % 8) == 0) update_text_shake();  // 12%
    } else {
        if ((rand() % 20) == 0) update_text_shake();  // 5% rare micro-wink
    }

    if (s_typing) {
        const char *msg = get_current_message();
        if (s_char_pos < (int)strlen(msg)) {
            // Typing error chance - rare even at level 0, more common at high chaos
            bool make_typo = false;
            if (s_phase != 0) {  // Never typo the time
                int typo_chance;
                if (s_chaos_level >= 3) {
                    typo_chance = (s_chaos_level - 1) * 8 + s_chaos_intensity;  // 16-50%
                } else if (s_chaos_level >= 1) {
                    typo_chance = 3 + s_chaos_level * 2 + s_chaos_intensity / 3;  // 3-10%
                } else {
                    typo_chance = 2;  // 2% rare wink
                }
                make_typo = (rand() % 100) < typo_chance;
            }

            if (make_typo) {
                // Type a wrong character, will be "corrected" next tick
                s_display_text[s_char_pos] = GLITCH_CHARS[rand() % 10];
                s_display_text[s_char_pos + 1] = '\0';
                layer_mark_dirty(s_canvas_layer);
                // Quick backspace effect
                app_timer_register(50 + (rand() % 30), animation_tick, NULL);
            } else {
                s_display_text[s_char_pos] = msg[s_char_pos];
                s_display_text[s_char_pos + 1] = '\0';
                s_char_pos++;
                layer_mark_dirty(s_canvas_layer);

                // Typing speed varies with chaos
                int base_delay = 80 - s_chaos_level * 5;
                int variance = 70 + s_chaos_level * 10;
                app_timer_register(base_delay + (rand() % variance), animation_tick, NULL);
            }
        } else {
            s_typing = false;
            s_pause_counter = 0;

            if (s_phase == 3) {
                // Delay before glitch varies with chaos
                int glitch_delay = 200 - s_chaos_level * 20;
                if (glitch_delay < 50) glitch_delay = 50;
                app_timer_register(glitch_delay, glitch_tick, NULL);
            } else {
                app_timer_register(100, animation_tick, NULL);
            }
        }
    } else {
        s_pause_counter++;
        // Pause duration varies with chaos - shorter at high chaos
        int base_pause = (s_phase == 2) ? 20 : 25;
        int pause_duration = base_pause - s_chaos_level * 2;
        if (pause_duration < 10) pause_duration = 10;

        // At high chaos, time phase gets extra long pause to stay readable
        if (s_phase == 0 && s_chaos_level >= 4) {
            pause_duration = 30;
        }

        if (s_pause_counter >= pause_duration) {
            next_phase();
            app_timer_register(100, animation_tick, NULL);
        } else {
            layer_mark_dirty(s_canvas_layer);
            app_timer_register(100, animation_tick, NULL);
        }
    }
}

static void cursor_blink(void *context) {
    if (s_phase != 3 || s_glitch_counter == 0) {
        s_cursor_visible = !s_cursor_visible;
        layer_mark_dirty(s_canvas_layer);
    }
    app_timer_register(400, cursor_blink, NULL);
}

// Shake timer for permanent chaos effect
static void shake_tick(void *context) {
    if (s_chaos_level >= 5) {
        // Permanent shake at meltdown level
        update_text_shake();
        layer_mark_dirty(s_canvas_layer);
    }
    // Continue shake timer
    app_timer_register(100, shake_tick, NULL);
}

static void tick_handler(struct tm *tick_time, TimeUnits units) {
    update_strings();

    // Log chaos change for debug
    APP_LOG(APP_LOG_LEVEL_INFO, "Minute %d: Chaos L%d I%d",
            s_current_minute, s_chaos_level, s_chaos_intensity);

    if (s_phase == 0 && !s_typing) {
        strncpy(s_display_text, s_time_str, sizeof(s_display_text));
        layer_mark_dirty(s_canvas_layer);
    }
}

static void window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(root);

    window_set_background_color(window, GColorBlack);

    s_canvas_layer = layer_create(bounds);
    layer_set_update_proc(s_canvas_layer, canvas_update_proc);
    layer_add_child(root, s_canvas_layer);

    update_strings();  // This also initializes chaos levels
    s_display_text[0] = '\0';
    s_phase = 0;
    s_char_pos = 0;
    s_typing = true;
    s_glitch_color = GColorWhite;
    s_bg_color = GColorBlack;
    s_cursor_size = 12;
    s_text_shake_x = 0;
    s_text_shake_y = 0;
    s_first_loop = true;  // First loop always shows "vibecode"

    APP_LOG(APP_LOG_LEVEL_INFO, "VibeFace starting - Chaos L%d I%d (minute %d)",
            s_chaos_level, s_chaos_intensity, s_current_minute);

    app_timer_register(500, animation_tick, NULL);
    app_timer_register(400, cursor_blink, NULL);
    app_timer_register(100, shake_tick, NULL);  // Shake timer for high chaos
}

static void window_unload(Window *window) {
    layer_destroy(s_canvas_layer);
}

static void init() {
    // Seed random with current time for true randomness
    srand(time(NULL));

    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers) {
        .load = window_load,
        .unload = window_unload,
    });
    window_stack_push(s_window, true);
    tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
}

static void deinit() {
    window_destroy(s_window);
}

int main(void) {
    init();
    app_event_loop();
    deinit();
}
