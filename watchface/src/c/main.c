/*
 * Treasure Trove — art first, time second.
 *
 * The phone (src/pkjs) fetches a painting already converted to this watch's
 * exact bitmap layout and streams it over AppMessage. We copy the bytes straight
 * into a GBitmap: no PNG decoding, so peak memory is one bitmap. Rows appear as
 * they arrive, like a canvas being unrolled.
 *
 * Gestures (watchfaces get no buttons, so we use the accelerometer "tap"):
 *   flick wrist → show the time for a minute (when "hide until flick" is on)
 */
#include <pebble.h>

#define SETTINGS_KEY 1
/* How long a flick shows the time is a setting: 1..REVEAL_MAX_MIN minutes. */
#define REVEAL_MAX_MIN 60
#define HELLO_RETRIES 5

/* Colour watches only (basalt, chalk, emery, gabbro), so the paintings can be
 * 8-bit and the inbox can be large. */
#define INBOX_SIZE 4096
/* Room for dictionary + tuple headers + the offset tuple. */
#define CHUNK_SIZE (INBOX_SIZE - 48)

/* Text sits this far from the screen edge. Round screens need more. */
#define MARGIN PBL_IF_ROUND_ELSE(10, 4)
#define BOX_PAD 3
/* System fonts draw with some empty space above the glyphs; these trim the box
 * so it hugs the digits. Tune in the emulator if a future font changes. */
#define TIME_TOP_INSET 7
#define DATE_TOP_INSET 6

typedef enum { ClockAuto = 0, Clock12 = 1, Clock24 = 2 } ClockMode;
typedef enum { DateDayMonth = 0, DateMonthDay = 1, DateDay = 2 } DateFormat;
/* Separator between day and month: '-', '/' or '.'. */
static const char DATE_SEPARATORS[] = { '-', '/', '.' };
/* 2 was a double-flick toggle; older saved settings with it now mean Off. */
typedef enum { BoxOff = 0, BoxAlways = 1 } BoxMode;

typedef struct {
  bool show_time;
  uint8_t clock_mode;
  bool hide_ampm;
  bool show_date;
  uint8_t date_format;
  bool hide_until_shake;
  uint8_t box_mode;
  /* Added later: settings saved before these existed keep the defaults. */
  uint8_t reveal_minutes;
  uint8_t date_sep;
} Settings;

static Settings s_settings;
static Window *s_window;
static Layer *s_art_layer;
static Layer *s_text_layer;
static GBitmap *s_art;
static GSize s_screen;
static uint16_t s_stride;

static uint32_t s_expected;     /* bytes in the current transfer, 0 = none */
static uint32_t s_received;     /* highest byte written so far */
static bool s_art_ready;        /* a complete painting has been received */

static bool s_revealed;
static AppTimer *s_reveal_timer;
static bool s_tap_subscribed;
static int s_hello_tries;

static GFont s_time_font;
static GFont s_date_font;
static char s_time_text[12];
static char s_date_text[8];

/* ---------------------------------------------------------------- settings */

static void default_settings(void) {
  s_settings = (Settings){
    .show_time = true,
    .clock_mode = ClockAuto,
    .hide_ampm = false,
    .show_date = true,
    .date_format = DateDayMonth,
    .hide_until_shake = false,
    .box_mode = BoxOff,
    .reveal_minutes = 1,
  };
}

static void load_settings(void) {
  default_settings();
  if (persist_exists(SETTINGS_KEY)) {
    persist_read_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
  }
}

static bool any_text_enabled(void) {
  return s_settings.show_time || s_settings.show_date;
}

/* -------------------------------------------------------------------- time */

static void update_strings(void) {
  time_t now = time(NULL);
  struct tm *t = localtime(&now);

  bool use24 = s_settings.clock_mode == Clock24 ||
               (s_settings.clock_mode == ClockAuto && clock_is_24h_style());
  if (use24) {
    strftime(s_time_text, sizeof(s_time_text), "%H:%M", t);
  } else {
    strftime(s_time_text, sizeof(s_time_text),
             s_settings.hide_ampm ? "%I:%M" : "%I:%M %p", t);
    if (s_time_text[0] == '0') {  /* "09:41" → "9:41" */
      memmove(s_time_text, s_time_text + 1, strlen(s_time_text));
    }
  }
  char format[8];
  char sep = DATE_SEPARATORS[s_settings.date_sep < sizeof(DATE_SEPARATORS) ? s_settings.date_sep : 0];
  if (s_settings.date_format == DateDay) {
    snprintf(format, sizeof(format), "%%d");
  } else if (s_settings.date_format == DateMonthDay) {
    snprintf(format, sizeof(format), "%%m%c%%d", sep);
  } else {
    snprintf(format, sizeof(format), "%%d%c%%m", sep);
  }
  strftime(s_date_text, sizeof(s_date_text), format, t);
}

/* --------------------------------------------------------------- messaging */

static void send_hello(int32_t reason) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) {
    return;
  }
  dict_write_int32(it, MESSAGE_KEY_Hello, reason);
  dict_write_int32(it, MESSAGE_KEY_ScreenW, s_screen.w);
  dict_write_int32(it, MESSAGE_KEY_ScreenH, s_screen.h);
  dict_write_int32(it, MESSAGE_KEY_RowStride, s_stride);
  dict_write_int32(it, MESSAGE_KEY_IsRound, PBL_IF_ROUND_ELSE(1, 0));
  dict_write_int32(it, MESSAGE_KEY_ChunkSize, CHUNK_SIZE);
  /* The watch's own clock style, so the settings page knows if "Like my phone" is 12h. */
  dict_write_int32(it, MESSAGE_KEY_Is24h, clock_is_24h_style() ? 1 : 0);
  app_message_outbox_send();
}

static void hello_retry(void *data) {
  send_hello(1);
}

static void outbox_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  /* The phone side may not be running yet; it also pings us when it is ready. */
  if (s_hello_tries++ < HELLO_RETRIES) {
    app_timer_register(1000 * s_hello_tries, hello_retry, NULL);
  }
}

static void apply_tap_subscription(void);

static void handle_image(DictionaryIterator *iter) {
  Tuple *t;
  uint32_t total = (uint32_t)s_stride * s_screen.h;

  if ((t = dict_find(iter, MESSAGE_KEY_ImgBegin))) {
    s_expected = (t->value->uint32 == total) ? total : 0;
    s_received = 0;
    if (!s_expected) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "image size %lu != %lu", (unsigned long)t->value->uint32,
              (unsigned long)total);
    }
  }
  if ((t = dict_find(iter, MESSAGE_KEY_ImgChunk)) && s_expected && s_art) {
    Tuple *o = dict_find(iter, MESSAGE_KEY_ImgOffset);
    uint32_t offset = o ? o->value->uint32 : s_received;
    uint32_t len = t->length;
    if (offset + len <= s_expected) {
      memcpy(gbitmap_get_data(s_art) + offset, t->value->data, len);
      if (offset + len > s_received) {
        s_received = offset + len;
      }
      layer_mark_dirty(s_art_layer);
    }
  }
  if ((t = dict_find(iter, MESSAGE_KEY_ImgEnd)) && s_expected) {
    s_art_ready = s_received >= s_expected;
    s_expected = 0;
    layer_mark_dirty(s_art_layer);
    layer_mark_dirty(s_text_layer);
  }
}

static bool read_int(DictionaryIterator *iter, uint32_t key, int32_t *out) {
  Tuple *t = dict_find(iter, key);
  if (!t) {
    return false;
  }
  *out = t->value->int32;
  return true;
}

static void inbox_received(DictionaryIterator *iter, void *ctx) {
  int32_t v;
  bool changed = false;

  if (dict_find(iter, MESSAGE_KEY_PhoneReady)) {
    s_hello_tries = 0;
    send_hello(1);
  }

  if (read_int(iter, MESSAGE_KEY_ShowTime, &v)) { s_settings.show_time = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_ClockMode, &v)) { s_settings.clock_mode = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_HideAmPm, &v)) { s_settings.hide_ampm = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_ShowDate, &v)) { s_settings.show_date = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_DateFormat, &v)) { s_settings.date_format = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_DateSep, &v)) { s_settings.date_sep = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_HideUntilShake, &v)) { s_settings.hide_until_shake = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_BoxMode, &v)) { s_settings.box_mode = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_RevealMinutes, &v)) {
    s_settings.reveal_minutes = v < 1 ? 1 : (v > REVEAL_MAX_MIN ? REVEAL_MAX_MIN : v);
    changed = true;
  }

  if (changed) {
    persist_write_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
    update_strings();
    apply_tap_subscription();
    layer_mark_dirty(s_text_layer);
  }

  handle_image(iter);
}

/* ---------------------------------------------------------------- gestures */

static void reveal_timeout(void *data) {
  s_reveal_timer = NULL;
  s_revealed = false;
  layer_mark_dirty(s_text_layer);
}

static uint32_t reveal_ms(void) {
  uint8_t m = s_settings.reveal_minutes;
  return (uint32_t)(m < 1 ? 1 : m) * 60000u;
}

static void tap_handler(AccelAxisType axis, int32_t direction) {
  if (s_settings.hide_until_shake) {
    s_revealed = true;
    if (s_reveal_timer) {
      app_timer_reschedule(s_reveal_timer, reveal_ms());
    } else {
      s_reveal_timer = app_timer_register(reveal_ms(), reveal_timeout, NULL);
    }
  }
  layer_mark_dirty(s_text_layer);
}

/* Only listen to the accelerometer when a setting needs it (battery). */
static void apply_tap_subscription(void) {
  bool want = any_text_enabled() && s_settings.hide_until_shake;
  if (want && !s_tap_subscribed) {
    accel_tap_service_subscribe(tap_handler);
  } else if (!want && s_tap_subscribed) {
    accel_tap_service_unsubscribe();
  }
  s_tap_subscribed = want;
}

/* ----------------------------------------------------------------- drawing */

static void art_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  if (s_art && (s_art_ready || s_received > 0)) {
    graphics_context_set_compositing_mode(ctx, GCompOpAssign);
    graphics_draw_bitmap_in_rect(ctx, s_art, bounds);
  }
}

/* White text with a 1px black outline: readable on most paintings without
 * covering any of them. */
static void draw_outlined(GContext *ctx, const char *text, GFont font, GRect r,
                          GTextAlignment align) {
  static const int8_t offsets[4][2] = { { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } };
  graphics_context_set_text_color(ctx, GColorBlack);
  for (int i = 0; i < 4; i++) {
    GRect o = GRect(r.origin.x + offsets[i][0], r.origin.y + offsets[i][1], r.size.w, r.size.h);
    graphics_draw_text(ctx, text, font, o, GTextOverflowModeFill, align, NULL);
  }
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, text, font, r, GTextOverflowModeFill, align, NULL);
}

static GSize measure(const char *text, GFont font, int16_t max_w) {
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, max_w, 60),
                                               GTextOverflowModeFill, GTextAlignmentLeft);
}

static void text_update(Layer *layer, GContext *ctx) {
  if (!any_text_enabled()) {
    return;
  }
  /* Until the first painting arrives, always show the time so the face is
   * never just black. */
  if (s_settings.hide_until_shake && !s_revealed && s_art_ready) {
    return;
  }

#if PBL_API_EXISTS(layer_get_unobstructed_bounds)
  GRect area = layer_get_unobstructed_bounds(layer);
#else
  GRect area = layer_get_bounds(layer);
#endif

  bool show_time = s_settings.show_time;
  bool show_date = s_settings.show_date;
  GSize ts = show_time ? measure(s_time_text, s_time_font, area.size.w) : GSize(0, 0);
  GSize ds = show_date ? measure(s_date_text, s_date_font, area.size.w) : GSize(0, 0);

  /* Visible heights (without the font's built-in top space). */
  int16_t time_h = show_time ? ts.h - TIME_TOP_INSET : 0;
  int16_t date_h = show_date ? ds.h - DATE_TOP_INSET : 0;
  int16_t gap = (show_time && show_date) ? 2 : 0;
  int16_t block_w = ts.w > ds.w ? ts.w : ds.w;
  int16_t block_h = time_h + date_h + gap;

  /* Bottom-right corner on rectangular screens, bottom-centre on round ones. */
  GTextAlignment align = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentRight);
  int16_t bottom = area.origin.y + area.size.h - MARGIN - PBL_IF_ROUND_ELSE(8, 0);
#ifdef PBL_ROUND
  int16_t left = area.origin.x + (area.size.w - block_w) / 2;
#else
  int16_t left = area.origin.x + area.size.w - MARGIN - block_w;
#endif
  int16_t top = bottom - block_h;

  bool boxed = s_settings.box_mode == BoxAlways;
  if (boxed) {
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, GRect(left - BOX_PAD, top - BOX_PAD, block_w + 2 * BOX_PAD,
                                  block_h + 2 * BOX_PAD), 3, GCornersAll);
  }

  int16_t y = top;
  if (show_date) {
    GRect r = GRect(left, y - DATE_TOP_INSET, block_w, ds.h);
    if (boxed) {
      graphics_context_set_text_color(ctx, GColorWhite);
      graphics_draw_text(ctx, s_date_text, s_date_font, r, GTextOverflowModeFill, align, NULL);
    } else {
      draw_outlined(ctx, s_date_text, s_date_font, r, align);
    }
    y += date_h + gap;
  }
  if (show_time) {
    GRect r = GRect(left, y - TIME_TOP_INSET, block_w, ts.h);
    if (boxed) {
      graphics_context_set_text_color(ctx, GColorWhite);
      graphics_draw_text(ctx, s_time_text, s_time_font, r, GTextOverflowModeFill, align, NULL);
    } else {
      draw_outlined(ctx, s_time_text, s_time_font, r, align);
    }
  }
}

static void tick_handler(struct tm *t, TimeUnits changed) {
  update_strings();
  layer_mark_dirty(s_text_layer);
  if (changed & DAY_UNIT) {
    send_hello(2);  /* new day → the phone hangs a new painting */
  }
}

#if PBL_API_EXISTS(unobstructed_area_service_subscribe)
static void unobstructed_change(AnimationProgress progress, void *ctx) {
  layer_mark_dirty(s_text_layer);
}
#endif

/* ------------------------------------------------------------------ window */

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  s_screen = bounds.size;

  s_art = gbitmap_create_blank(s_screen, GBitmapFormat8Bit);
  if (s_art) {
    s_stride = gbitmap_get_bytes_per_row(s_art);
    /* 0xC0 = opaque black (0b11RRGGBB). */
    memset(gbitmap_get_data(s_art), 0xC0,
           (size_t)s_stride * s_screen.h);
  }

  s_art_layer = layer_create(bounds);
  layer_set_update_proc(s_art_layer, art_update);
  layer_add_child(root, s_art_layer);

  s_text_layer = layer_create(bounds);
  layer_set_update_proc(s_text_layer, text_update);
  layer_add_child(root, s_text_layer);
}

static void window_unload(Window *window) {
  layer_destroy(s_text_layer);
  layer_destroy(s_art_layer);
  if (s_art) {
    gbitmap_destroy(s_art);
    s_art = NULL;
  }
}

static void init(void) {
  load_settings();
  s_time_font = fonts_get_system_font(FONT_KEY_LECO_26_BOLD_NUMBERS_AM_PM);
  s_date_font = fonts_get_system_font(FONT_KEY_LECO_20_BOLD_NUMBERS);

  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, false);

  update_strings();
  tick_timer_service_subscribe(MINUTE_UNIT | DAY_UNIT, tick_handler);
  apply_tap_subscription();
#if PBL_API_EXISTS(unobstructed_area_service_subscribe)
  unobstructed_area_service_subscribe((UnobstructedAreaHandlers){
    .change = unobstructed_change,
    .did_change = NULL,
    .will_change = NULL,
  }, NULL);
#endif

  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(INBOX_SIZE, 256);
  send_hello(1);
}

static void deinit(void) {
  if (s_tap_subscribed) {
    accel_tap_service_unsubscribe();
  }
  tick_timer_service_unsubscribe();
  app_message_deregister_callbacks();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
