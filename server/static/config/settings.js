/**
 * The watchface settings: defaults, the storage version and migrations.
 *
 * Stored by the phone in localStorage ("tt-settings") as the settings plus a
 * `version`. The shape is described by docs/schema/settings.schema.json. When a
 * stored setting changes meaning, bump VERSION and add a step to MIGRATIONS;
 * `load` runs every step from the stored version up, then keeps only known
 * settings and fills the rest from DEFAULTS.
 *
 * Shared by the phone (PebbleKit JS) and the settings page, like render.js.
 * ES5 on purpose: PebbleKit JS is not a modern browser.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TreasureSettings = factory();
  }
}(this, function () {
  'use strict';

  var VERSION = 1;

  var DEFAULTS = {
    showTime: true,
    clockMode: 'auto',     // auto | 12 | 24
    hideAmPm: false,
    showDate: true,
    dateFormat: 'dd-mm',   // dd-mm | mm-dd | dd
    dateSep: '-',          // - | / | .
    hideUntilShake: false,
    revealMinutes: 1,      // how long a flick shows the time (1-60)
    boxMode: 'off',        // off | always
    textRow: 'bottom',     // top | center | bottom
    textCol: 'auto',       // start | center | end; auto = end (round screens: always center)
    timeSize: 's',         // s | m | l
    fit: 'fill',           // fill | whole
    palette: 'defined',    // defined | sun | room | backlight
    dither: 'atkinson',    // atkinson | checker | none
    brightness: 0,         // -100..100
    contrast: 0,           // -100..100
    frame: 'none',         // none | gold | wood | gallery
    selection: 'featured', // featured (365 most-read) | random
    era: 'any',            // for random: any | pre1600 | 1600s | 1700s | 1800s | 1900s
    rotation: 'daily',     // daily | weekly | monthly | off
    pinned: ''             // key of a painting chosen by id; set = no rotation
  };

  // MIGRATIONS[n] turns version n into version n + 1 (in place), e.g.
  //   function (s) { if (s.frame === 'oak') s.frame = 'wood'; }
  // turns version 1 into 2. Version 1 is the first; nothing to migrate yet.
  var MIGRATIONS = [];

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Settings from storage (any version, or nothing): migrated, complete. */
  function load(stored) {
    var s = {};
    var key;
    stored = stored && typeof stored === 'object' ? stored : {};
    for (key in stored) {
      if (has(stored, key) && key !== 'version') {
        s[key] = stored[key];
      }
    }
    var version = typeof stored.version === 'number' && stored.version <= VERSION ? stored.version : VERSION;
    for (var v = version; v < VERSION; v++) {
      MIGRATIONS[v - 1](s);
    }
    var out = {};
    for (key in DEFAULTS) {
      if (has(DEFAULTS, key)) {
        out[key] = has(s, key) ? s[key] : DEFAULTS[key];
      }
    }
    return out;
  }

  /** What goes into storage: the settings plus the current version. */
  function toStored(settings) {
    var out = { version: VERSION };
    for (var key in DEFAULTS) {
      if (has(DEFAULTS, key)) {
        out[key] = has(settings, key) ? settings[key] : DEFAULTS[key];
      }
    }
    return out;
  }

  return {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    load: load,
    toStored: toStored
  };
}));
