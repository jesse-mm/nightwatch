/**
 * Per-painting looks: the crop, frame, color tuning and time placement a
 * reader saved for a painting, so they come back whenever it is hung again.
 *
 * Stored in localStorage ("nw-looks") as readable JSON with a version, looks
 * keyed by painting:
 *
 *   {"version": 1, "looks": {"200108369": {"fit": "fill", "frame": "gold",
 *     "palette": "defined", "dither": "atkinson", "brightness": 10,
 *     "contrast": -5, "textRow": "bottom", "textCol": "end", "timeSize": "s"}}}
 *
 * The shape is described by docs/schema/looks.schema.json; the fields and
 * their values are in FIELDS below. When a field changes meaning, bump VERSION
 * and add a step to MIGRATIONS.
 * Unknown fields or values are skipped and missing ones fall back to the
 * defaults, so fields can be added or dropped later without breaking saved
 * looks. About 160 bytes per painting.
 *
 * Shared by the phone (PebbleKit JS) and the settings page, like render.js.
 * ES5 on purpose: PebbleKit JS is not a modern browser.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NightWatchLooks = factory();
  }
}(this, function () {
  'use strict';

  var STORE_KEY = 'nw-looks';
  var VERSION = 1;

  // Setting → allowed values (a list), or a whole-number range; `empty: true`
  // also allows null (focus: null = the generator's smart crop).
  var FIELDS = {
    fit: ['fill', 'whole'],
    frame: ['none', 'gold', 'wood', 'gallery'],
    palette: ['defined', 'sun', 'room', 'backlight'],
    dither: ['atkinson', 'checker', 'none'],
    brightness: { min: -100, max: 100 },
    contrast: { min: -100, max: 100 },
    zoom: { min: 100, max: 200 },
    focusX: { min: 0, max: 10000, empty: true },
    focusY: { min: 0, max: 10000, empty: true },
    textRow: ['top', 'center', 'bottom'],
    textCol: ['auto', 'start', 'center', 'end'],
    timeSize: ['s', 'm', 'l']
  };

  var KEYS = Object.keys(FIELDS);

  // What a painting without a saved look starts with from the defaults instead
  // of inheriting from the previous painting: its color adjustments, zoom and
  // position. Crop, frame and time placement carry over.
  var FRESH = ['palette', 'dither', 'brightness', 'contrast', 'zoom', 'focusX', 'focusY'];

  function isList(field) {
    return Object.prototype.toString.call(field) === '[object Array]';
  }

  /** A value for a range field, or undefined when it doesn't fit. */
  function inRange(field, value) {
    if (value === null && field.empty) {
      return null;
    }
    if (typeof value !== 'number' || !isFinite(value)) {
      return undefined;
    }
    return Math.min(field.max, Math.max(field.min, Math.round(value)));
  }

  /** The look fields of `settings`. */
  function encode(settings) {
    var look = {};
    KEYS.forEach(function (key) {
      var field = FIELDS[key];
      var value = isList(field) ? settings[key] : inRange(field, settings[key]);
      look[key] = value === undefined ? (field.empty ? null : field.min) : value;
    });
    return look;
  }

  /**
   * A stored look as settings; missing or unknown values come from `defaults`.
   * Null when there is no usable look.
   */
  function decode(look, defaults) {
    if (!look || typeof look !== 'object') {
      return null;
    }
    var out = {};
    KEYS.forEach(function (key) {
      var value = look[key];
      var field = FIELDS[key];
      if (isList(field)) {
        out[key] = field.indexOf(value) >= 0 ? value : defaults[key];
      } else {
        var v = inRange(field, value);
        out[key] = v === undefined ? defaults[key] : v;
      }
    });
    return out;
  }

  // MIGRATIONS[n] turns a look of version n into version n + 1 (in place),
  // like settings.js. Version 1 is the first; nothing to migrate yet.
  var MIGRATIONS = [];

  /** Every saved look at the current version, painting key → look. */
  function readAll(storage) {
    try {
      return fromStored(JSON.parse(storage.getItem(STORE_KEY)));
    } catch (e) {
      return {}; // unreadable: start over rather than fail
    }
  }

  /** `{version, looks}` (from storage or a backup) → painting key → look, migrated. */
  function fromStored(stored) {
    if (!stored || typeof stored !== 'object' || typeof stored.version !== 'number' || stored.version > VERSION) {
      return {};
    }
    var map = stored.looks || {};
    var out = {};
    for (var key in map) {
      if (Object.prototype.hasOwnProperty.call(map, key) && map[key] && typeof map[key] === 'object') {
        out[key] = map[key];
        for (var v = stored.version; v < VERSION; v++) {
          MIGRATIONS[v - 1](out[key]);
        }
      }
    }
    return out;
  }

  /** The saved look for a painting, or null. */
  function get(storage, paintingKey, defaults) {
    var all = readAll(storage);
    return Object.prototype.hasOwnProperty.call(all, paintingKey) ? decode(all[paintingKey], defaults) : null;
  }

  /** Remember the look in `settings` for a painting. */
  function save(storage, paintingKey, settings) {
    if (!paintingKey) {
      return;
    }
    var all = readAll(storage);
    all[paintingKey] = encode(settings);
    try {
      storage.setItem(STORE_KEY, JSON.stringify(toStored(all)));
    } catch (e) {
      // Storage full or unavailable: the look just isn't remembered.
    }
  }

  /** Every saved look, painting key → look (for the settings page). */
  function all(storage) {
    return readAll(storage);
  }

  /** Painting key → look as stored: `{version, looks}`. */
  function toStored(map) {
    return { version: VERSION, looks: map || {} };
  }

  /** Replace every saved look, e.g. from a backup (`{version, looks}`). */
  function replaceAll(storage, stored) {
    var map = fromStored(stored);
    var clean = {};
    for (var key in map) {
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        clean[key] = map[key];
      }
    }
    try {
      storage.setItem(STORE_KEY, JSON.stringify(toStored(clean)));
    } catch (e) {
      // Storage full or unavailable: the backup just isn't restored.
    }
  }

  return {
    VERSION: VERSION,
    FIELDS: FIELDS,
    KEYS: KEYS,
    FRESH: FRESH,
    encode: encode,
    decode: decode,
    get: get,
    save: save,
    all: all,
    fromStored: fromStored,
    toStored: toStored,
    replaceAll: replaceAll
  };
}));
