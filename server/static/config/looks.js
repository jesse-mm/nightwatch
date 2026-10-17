/**
 * Per-painting looks: the crop, frame, color tuning and time placement a
 * reader saved for a painting, so they come back whenever it is hung again.
 *
 * Stored in localStorage as one small map, painting key → compact string:
 * the LOOK fields in order, joined by commas, each an option index or a
 * number, e.g. "0,1,0,2,10,-5,1,0,0". Unknown or missing parts fall back to
 * the defaults passed in, so the format can grow at the end.
 *
 * Shared by the phone (PebbleKit JS) and the settings page, like render.js.
 * ES5 on purpose: PebbleKit JS is not a modern browser.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TreasureLooks = factory();
  }
}(this, function () {
  'use strict';

  var STORE_KEY = 'tt-looks';

  // Order matters: it is the storage format. Only append.
  var LOOK = [
    { key: 'fit', options: ['fill', 'whole'] },
    { key: 'frame', options: ['none', 'gold', 'wood', 'gallery'] },
    { key: 'palette', options: ['defined', 'sun', 'room', 'backlight'] },
    { key: 'dither', options: ['atkinson', 'checker', 'none'] },
    { key: 'brightness' },
    { key: 'contrast' },
    { key: 'textRow', options: ['bottom', 'top'] },
    { key: 'textCol', options: ['auto', 'left', 'center', 'right'] },
    { key: 'timeSize', options: ['s', 'm', 'l'] }
  ];

  /** The look in `settings` as a compact string. */
  function encode(settings) {
    return LOOK.map(function (field) {
      var value = settings[field.key];
      if (!field.options) {
        return String(Math.round(Number(value) || 0));
      }
      return String(Math.max(0, field.options.indexOf(value)));
    }).join(',');
  }

  /** The settings a compact string stands for; missing parts come from `defaults`. */
  function decode(text, defaults) {
    var parts = String(text || '').split(',');
    var out = {};
    LOOK.forEach(function (field, i) {
      var part = parts[i];
      var n = Number(part);
      if (part === undefined || part === '' || isNaN(n)) {
        out[field.key] = defaults[field.key];
      } else if (field.options) {
        out[field.key] = field.options[n] !== undefined ? field.options[n] : defaults[field.key];
      } else {
        out[field.key] = Math.min(100, Math.max(-100, Math.round(n)));
      }
    });
    return out;
  }

  function readAll(storage) {
    try {
      return JSON.parse(storage.getItem(STORE_KEY)) || {};
    } catch (e) {
      return {}; // unreadable: start over rather than fail
    }
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
      storage.setItem(STORE_KEY, JSON.stringify(all));
    } catch (e) {
      // Storage full or unavailable: the look just isn't remembered.
    }
  }

  /** Every saved look, painting key → compact string (for the settings page). */
  function all(storage) {
    return readAll(storage);
  }

  return {
    KEYS: LOOK.map(function (field) { return field.key; }),
    encode: encode,
    decode: decode,
    get: get,
    save: save,
    all: all
  };
}));
