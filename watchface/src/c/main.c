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
/* The last painting, kept on the watch so it shows instantly on the next
 * launch (e.g. after the menu) instead of being sent again. ART_META_KEY holds
 * its id and size; the bytes follow in PERSIST_DATA_MAX_LENGTH pieces from
 * ART_DATA_KEY. Only where an app may store enough (1 MB on Pebble Time 2,
 * Round 2 and 2 Duo; 4 KB on older watches, too little for a painting). */
#define ART_META_KEY 2
#define ART_DATA_KEY 100
/* How long a flick shows the time is a setting: 1..REVEAL_MAX_MIN minutes. */
#define REVEAL_MAX_MIN 60
#define HELLO_RETRIES 5

/* Color watches only (basalt, chalk, emery, gabbro), so the paintings can be
 * 8-bit and the inbox can be large. */
#define INBOX_SIZE 4096
/* Room for dictionary + tuple headers + the offset tuple. */
#define CHUNK_SIZE (INBOX_SIZE - 48)

/* Text sits this far from the screen edge. Round screens need more. */
#define MARGIN PBL_IF_ROUND_ELSE(10, 4)
#define BOX_PAD 3
#define AMPM_GAP 2
/* Time and date fonts per size (S, M, L). System fonts draw with some empty
 * space above the glyphs; the insets trim it so the box hugs the digits. Tune
 * in the emulator if a font changes. Only the M time font has AM/PM letters;
 * the others draw AM/PM separately in the date font. */
typedef struct {
  const char *time_font;
  const char *date_font;
  int8_t time_inset;
  int8_t date_inset;
  bool time_has_ampm;
} TextSize;

static const TextSize TEXT_SIZES[] = {
  { FONT_KEY_LECO_20_BOLD_NUMBERS, FONT_KEY_GOTHIC_14_BOLD, 6, 4, false },
  { FONT_KEY_LECO_26_BOLD_NUMBERS_AM_PM, FONT_KEY_LECO_20_BOLD_NUMBERS, 7, 6, true },
  { FONT_KEY_LECO_36_BOLD_NUMBERS, FONT_KEY_LECO_26_BOLD_NUMBERS_AM_PM, 10, 7, false },
};
#define SIZE_S 0

typedef enum { ClockAuto = 0, Clock12 = 1, Clock24 = 2 } ClockMode;
typedef enum { DateDayMonth = 0, DateMonthDay = 1, DateDay = 2 } DateFormat;
/* Separator between day and month: '-', '/' or '.'. */
static const char DATE_SEPARATORS[] = { '-', '/', '.' };
/* Where the time and date sit: row * 3 + column. */
/* Values are what the phone sends; RowCenter came later, hence 2. */
typedef enum { RowTop = 0, RowBottom = 1, RowCenter = 2 } TextRow;
typedef enum { ColLeft = 0, ColCenter = 1, ColRight = 2 } TextCol;
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
  uint8_t text_pos;
  uint8_t time_size;
  /* Width of the painting frame (if any), so the text sits on the painting. */
  uint8_t text_inset;
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
static uint32_t s_art_id;       /* phone's id of the painting shown; 0 = none/partial */
static uint32_t s_pending_id;   /* id of the painting being received */
static bool s_art_unsaved;      /* received since the last save to storage */

typedef struct {
  uint32_t id;
  uint32_t size;
} ArtMeta;

static bool s_revealed;
static AppTimer *s_reveal_timer;
static bool s_tap_subscribed;
static int s_hello_tries;

static GFont s_time_font;
static GFont s_date_font;
static char s_time_text[12];
static char s_ampm_text[4];
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
    /* Bottom-right corner on rectangular screens, bottom-center on round ones. */
    .text_pos = RowBottom * 3 + PBL_IF_ROUND_ELSE(ColCenter, ColRight),
    .time_size = SIZE_S,
  };
}

static void load_settings(void) {
  default_settings();
  if (persist_exists(SETTINGS_KEY)) {
    persist_read_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
  }
}

static const TextSize *text_size(void) {
  return &TEXT_SIZES[s_settings.time_size < ARRAY_LENGTH(TEXT_SIZES) ? s_settings.time_size : SIZE_S];
}

static void load_fonts(void) {
  s_time_font = fonts_get_system_font(text_size()->time_font);
  s_date_font = fonts_get_system_font(text_size()->date_font);
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
  s_ampm_text[0] = '\0';
  if (use24) {
    strftime(s_time_text, sizeof(s_time_text), "%H:%M", t);
  } else {
    bool ampm_inline = !s_settings.hide_ampm && text_size()->time_has_ampm;
    strftime(s_time_text, sizeof(s_time_text), ampm_inline ? "%I:%M %p" : "%I:%M", t);
    if (!s_settings.hide_ampm && !ampm_inline) {
      strftime(s_ampm_text, sizeof(s_ampm_text), "%p", t);
    }
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
  /* The watch's own clock style, so the settings page knows if "Auto" is 12h. */
  dict_write_int32(it, MESSAGE_KEY_Is24h, clock_is_24h_style() ? 1 : 0);
  /* The painting we already show (restored from storage): the phone skips
   * sending it again when it would send the same one. */
  dict_write_int32(it, MESSAGE_KEY_ArtId, (int32_t)s_art_id);
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
    Tuple *id = dict_find(iter, MESSAGE_KEY_ArtId);
    s_pending_id = id ? id->value->uint32 : 0;
    s_art_id = 0; /* the bitmap is being overwritten */
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
    if (s_art_ready) {
      s_art_id = s_pending_id;
      s_art_unsaved = true;
    }
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
  if (read_int(iter, MESSAGE_KEY_TextPos, &v) && v >= 0 && v < 9) { s_settings.text_pos = v; changed = true; }
  if (read_int(iter, MESSAGE_KEY_TimeSize, &v) && v >= 0 && v < (int32_t)ARRAY_LENGTH(TEXT_SIZES)) {
    s_settings.time_size = v;
    changed = true;
  }
  if (read_int(iter, MESSAGE_KEY_TextInset, &v)) { s_settings.text_inset = v < 0 ? 0 : (v > 60 ? 60 : v); changed = true; }
  if (read_int(iter, MESSAGE_KEY_RevealMinutes, &v)) {
    s_settings.reveal_minutes = v < 1 ? 1 : (v > REVEAL_MAX_MIN ? REVEAL_MAX_MIN : v);
    changed = true;
  }

  if (changed) {
    persist_write_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
    load_fonts();
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

/* White text, on the box or with an outline. */
static void draw_text(GContext *ctx, const char *text, GFont font, GRect r, GTextAlignment align,
                      bool boxed) {
  if (boxed) {
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, text, font, r, GTextOverflowModeFill, align, NULL);
  } else {
    draw_outlined(ctx, text, font, r, align);
  }
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

  const TextSize *size = text_size();
  bool show_time = s_settings.show_time;
  bool show_date = s_settings.show_date;
  bool show_ampm = show_time && s_ampm_text[0];
  GSize ts = show_time ? measure(s_time_text, s_time_font, area.size.w) : GSize(0, 0);
  GSize as = show_ampm ? measure(s_ampm_text, s_date_font, area.size.w) : GSize(0, 0);
  GSize ds = show_date ? measure(s_date_text, s_date_font, area.size.w) : GSize(0, 0);

  /* Visible heights (without the font's built-in top space). */
  int16_t time_h = show_time ? ts.h - size->time_inset : 0;
  int16_t ampm_h = show_ampm ? as.h - size->date_inset : 0;
  int16_t date_h = show_date ? ds.h - size->date_inset : 0;
  int16_t gap = (show_time && show_date) ? 2 : 0;
  /* AM/PM (when drawn separately) sits after the digits, bottom-aligned. */
  int16_t line_w = ts.w + (show_ampm ? AMPM_GAP + as.w : 0);
  int16_t block_w = line_w > ds.w ? line_w : ds.w;
  int16_t block_h = time_h + date_h + gap;

  TextRow row = s_settings.text_pos / 3;
  /* Round screens only offer top or bottom, always centered. */
  TextCol col = PBL_IF_ROUND_ELSE(ColCenter, s_settings.text_pos % 3);
  /* Round screens keep the text a little further in from the top and bottom.
   * With a painting frame, the text sits inside it, on the painting. */
  int16_t margin = MARGIN + s_settings.text_inset;
  int16_t edge = margin + PBL_IF_ROUND_ELSE(8, 0);
  int16_t top = row == RowTop      ? area.origin.y + edge
              : row == RowCenter ? area.origin.y + (area.size.h - block_h) / 2
                                 : area.origin.y + area.size.h - edge - block_h;
  int16_t left = col == ColLeft    ? area.origin.x + margin
               : col == ColRight   ? area.origin.x + area.size.w - margin - block_w
                                   : area.origin.x + (area.size.w - block_w) / 2;
  GTextAlignment align = col == ColLeft    ? GTextAlignmentLeft
                       : col == ColRight   ? GTextAlignmentRight
                                           : GTextAlignmentCenter;

  bool boxed = s_settings.box_mode == BoxAlways;
  if (boxed) {
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, GRect(left - BOX_PAD, top - BOX_PAD, block_w + 2 * BOX_PAD,
                                  block_h + 2 * BOX_PAD), 3, GCornersAll);
  }

  int16_t y = top;
  if (show_date) {
    draw_text(ctx, s_date_text, s_date_font, GRect(left, y - size->date_inset, block_w, ds.h),
              align, boxed);
    y += date_h + gap;
  }
  if (show_time) {
    int16_t x = col == ColLeft    ? left
              : col == ColRight   ? left + block_w - line_w
                                  : left + (block_w - line_w) / 2;
    /* Left-aligned in a slightly wider box so the measured text never wraps. */
    draw_text(ctx, s_time_text, s_time_font, GRect(x, y - size->time_inset, ts.w + 4, ts.h),
              GTextAlignmentLeft, boxed);
    if (show_ampm) {
      int16_t ampm_top = y + time_h - ampm_h;
      draw_text(ctx, s_ampm_text, s_date_font,
                GRect(x + ts.w + AMPM_GAP, ampm_top - size->date_inset, as.w + 4, as.h),
                GTextAlignmentLeft, boxed);
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

/* ----------------------------------------------------------------- storage */

static size_t art_size(void) {
  return (size_t)s_stride * s_screen.h;
}

static bool can_store_art(void) {
  /* Room for the painting plus settings and some slack. */
  return persist_get_max_size() >= art_size() + 2048;
}

/* Keep the painting for the next launch. Called on exit, as the storage guide
 * recommends (writing ~45-70 KB can pause the watch briefly). */
static void save_art(void) {
  if (!s_art || !s_art_ready || !s_art_unsaved || !s_art_id || !can_store_art()) {
    return;
  }
  /* Drop the old description first, so a half-written painting is never used. */
  persist_delete(ART_META_KEY);
  const uint8_t *data = gbitmap_get_data(s_art);
  size_t size = art_size();
  for (size_t offset = 0, key = ART_DATA_KEY; offset < size; offset += PERSIST_DATA_MAX_LENGTH, key++) {
    size_t len = size - offset < PERSIST_DATA_MAX_LENGTH ? size - offset : PERSIST_DATA_MAX_LENGTH;
    if (persist_write_data(key, data + offset, len) != (int)len) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "could not save the painting at %u", (unsigned)offset);
      return;
    }
  }
  ArtMeta meta = { .id = s_art_id, .size = size };
  persist_write_data(ART_META_KEY, &meta, sizeof(meta));
  s_art_unsaved = false;
}

/* Show the painting kept by the last launch, if it fits this screen. */
static void restore_art(void) {
  ArtMeta meta;
  if (!s_art || !persist_exists(ART_META_KEY) ||
      persist_read_data(ART_META_KEY, &meta, sizeof(meta)) != (int)sizeof(meta) ||
      meta.size != art_size() || !meta.id) {
    return;
  }
  uint8_t *data = gbitmap_get_data(s_art);
  for (size_t offset = 0, key = ART_DATA_KEY; offset < meta.size; offset += PERSIST_DATA_MAX_LENGTH, key++) {
    size_t len = meta.size - offset < PERSIST_DATA_MAX_LENGTH ? meta.size - offset : PERSIST_DATA_MAX_LENGTH;
    if (persist_read_data(key, data + offset, len) != (int)len) {
      memset(data, 0xC0, meta.size);
      return;
    }
  }
  s_art_id = meta.id;
  s_art_ready = true;
}

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
    restore_art();
  }

  s_art_layer = layer_create(bounds);
  layer_set_update_proc(s_art_layer, art_update);
  layer_add_child(root, s_art_layer);

  s_text_layer = layer_create(bounds);
  layer_set_update_proc(s_text_layer, text_update);
  layer_add_child(root, s_text_layer);
}

static void window_unload(Window *window) {
  save_art();
  layer_destroy(s_text_layer);
  layer_destroy(s_art_layer);
  if (s_art) {
    gbitmap_destroy(s_art);
    s_art = NULL;
  }
}

static void init(void) {
  load_settings();
  load_fonts();

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
