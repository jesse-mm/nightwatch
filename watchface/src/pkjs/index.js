/**
 * NightWatch — phone side.
 *
 * Responsibilities:
 *  1. Learn the watch's screen (size, color, row stride, shape) from its Hello.
 *  2. When a new painting is due, pick it from the bundled catalog, download
 *     its planned crop from the Rijksmuseum's IIIF server, tone and dither it,
 *     and keep it in localStorage so relaunching the face is instant and works
 *     offline.
 *  3. Stream the bytes to the watch in chunks.
 *  4. Open the custom settings page and forward the choices to the watch.
 *
 * Written in ES5 on purpose: the PebbleKit JS runtime is not a modern browser.
 */
var CONFIG = require('./config');
var base64 = require('./base64');
var scatter = require('./scatter');
var rotation = require('./rotation');
var render = require('./render');
var looks = require('./looks');
var settingsLib = require('./settings');
var png = require('./png');
var Catalog = require('./catalog');
// Where the settings page and the catalog files are hosted (static files; no
// server of our own): SETTINGS_URL/ and SETTINGS_URL/catalog/.
var PAGE_URL = CONFIG.SETTINGS_URL;

var SETTINGS_KEY = 'nw-settings';
var ART_KEY = 'nw-art';
// The catalog manifest, and each catalog file we loaded (nw-catalog-<pool>).
var CATALOG_KEY = 'nw-catalog';
// Rows of paintings the settings page handed over (pinned or hung), by key.
var ROWS_KEY = 'nw-rows';
// The pinned painting's own copy (the whole painting, PNG), so it stays
// usable, crops and zoom included, if the Rijksmuseum drops it.
var SOURCE_KEY = 'nw-pinned-source';
// A pinned painting we can no longer get: shown on the settings page.
var UNAVAILABLE_KEY = 'nw-unavailable';
// Paintings for the coming periods, sent to the watch ahead of time (see
// syncQueue): like nw-art, plus the period's start and the id on the watch.
var QUEUE_KEY = 'nw-queue';

var DEFAULTS = settingsLib.DEFAULTS;

var watch = null;        // screen info from the watch's Hello
var fetching = false;
var pendingHang = null;  // painting picked in settings while a fetch was running
// True after the watchface (re)starts: its screen is black until we send a
// painting. Cleared once we've sent one.
var watchEmpty = true;
// Id of the painting the watch shows (it keeps it between launches where it
// can); 0 = none or unknown. Sending the same painting again is skipped.
var watchArtId = 0;
// Ids of the paintings the watch keeps for later, next due first.
var watchQueue = [];
var prefetching = false;
// Downloads ahead since the last Hello: a safety stop, never a download loop.
var prefetches = 0;
var retryTimer = null;
var retryCount = 0;
var RETRY_MINUTES = [2, 5, 15, 30];

// ------------------------------------------------------------------ storage

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (e) {
    console.log('Ignoring unreadable ' + key + ': ' + e);
    return null;
  }
}

function loadSettings() {
  return settingsLib.load(readJson(SETTINGS_KEY));
}

function storeSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsLib.toStored(settings)));
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function today() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * Identifies the crop a painting needs for this watch: the server only cuts
 * per screen and fit. Color tuning and frame are applied here (render.js),
 * so changing them never needs a download.
 */
function cropKey(settings) {
  var key = [watch.w, watch.h, watch.round, settings.fit];
  // Cover asks the Rijksmuseum for exactly the visible part, so zoom and
  // position are part of the crop (a change downloads it again).
  if (settings.fit !== 'whole') {
    key.push(settings.zoom, settings.focusX, settings.focusY);
  }
  return key.join(':');
}

/** The watch's bytes for a cached crop with the current tuning and frame. */
function composeFor(art, settings) {
  return render.compose(base64.decode(art.crop), art.cropW, art.cropH, {
    w: watch.w,
    h: watch.h,
    stride: watch.stride,
    round: !!watch.round,
    fit: settings.fit,
    frame: settings.frame,
    palette: settings.palette,
    dither: settings.dither,
    brightness: settings.brightness,
    contrast: settings.contrast
  });
}

/**
 * The settings a painting is shown with: its saved look, or for one without
 * the default colors, zoom and position (looks.FRESH); crop, frame and time
 * placement carry over from `settings`.
 */
function lookFor(settings, key) {
  var out = {};
  for (var k in settings) {
    if (Object.prototype.hasOwnProperty.call(settings, k)) {
      out[k] = settings[k];
    }
  }
  var look = looks.get(localStorage, key, settings);
  if (look) {
    for (var l in look) {
      if (Object.prototype.hasOwnProperty.call(look, l)) {
        out[l] = look[l];
      }
    }
  } else {
    looks.FRESH.forEach(function (f) {
      out[f] = DEFAULTS[f];
    });
  }
  return out;
}

/** Send the cached painting (render it first if it's a crop). */
function showCached(art, settings) {
  if (art && art.crop) {
    sendImage(composeFor(art, settings));
  }
}

// ---------------------------------------------------------------- messaging

var queue = [];
// Paintings sent ahead (QueueBegin/QueueChunk/QueueEnd): only while `queue`
// is empty, so settings and the painting on show never wait for them.
var background = [];
var sending = false;

/** AppMessages must go one at a time; retry with back-off on NACK. */
function enqueue(message, onDone) {
  queue.push({ message: message, onDone: onDone, tries: 0 });
  pump();
}

function enqueueBackground(message, qid, onDone) {
  background.push({ message: message, onDone: onDone, tries: 0, qid: qid });
  pump();
}

/** Take a message off whichever list holds it now (both get replaced). */
function drop(item) {
  [queue, background].forEach(function (list) {
    var i = list.indexOf(item);
    if (i >= 0) {
      list.splice(i, 1);
    }
  });
}

function pump() {
  if (sending) {
    return;
  }
  var list = queue.length ? queue : background;
  if (list.length === 0) {
    return;
  }
  sending = true;
  var item = list[0];
  Pebble.sendAppMessage(item.message, function () {
    drop(item);
    sending = false;
    if (item.onDone) {
      item.onDone();
    }
    pump();
  }, function () {
    sending = false;
    item.tries += 1;
    if (item.tries > 5) {
      console.log('Giving up on message after 5 tries');
      drop(item);
    }
    setTimeout(pump, 250 * item.tries);
  });
}

function sendSettings(s) {
  enqueue({
    ShowTime: s.showTime ? 1 : 0,
    ClockMode: s.clockMode === '12' ? 1 : (s.clockMode === '24' ? 2 : 0),
    HideAmPm: s.hideAmPm ? 1 : 0,
    ShowDate: s.showDate ? 1 : 0,
    DateFormat: s.dateFormat === 'mm-dd' ? 1 : (s.dateFormat === 'dd' ? 2 : 0),
    DateSep: Math.max(0, ['-', '/', '.'].indexOf(s.dateSep)),
    HideUntilShake: s.hideUntilShake ? 1 : 0,
    RevealMinutes: Math.min(60, Math.max(1, Math.round(Number(s.revealMinutes) || 1))),
    BoxMode: s.boxMode === 'always' ? 1 : 0,
    TextPos: textPos(s),
    TimeSize: Math.max(0, ['s', 'm', 'l'].indexOf(s.timeSize)),
    // The text sits inside a painting frame, on the painting.
    TextInset: watch ? render.frameBorder(s.frame, watch.w, watch.h) : 0
  });
}

/** Row * 3 + column. Round screens are always centered; "auto" is the right on others. */
function textPos(s) {
  var row = { top: 0, bottom: 1, center: 2 }[s.textRow];
  if (row === undefined) {
    row = 1;
  }
  var col = ['start', 'center', 'end'].indexOf(s.textCol);
  if (watch && watch.round) {
    col = 1;
  } else if (col < 0) {
    col = 2;
  }
  return row * 3 + col;
}

/** FNV-1a: a cheap 32-bit fingerprint of the watch's bytes (never 0). */
function artId(bytes) {
  var h = 0x811c9dc5;
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul ? Math.imul(h, 0x01000193) : (h * 0x01000193) | 0;
  }
  return (h | 0) || 1;
}

function sendImage(bytes) {
  if (bytes.length !== watch.stride * watch.h) {
    console.log('Image has ' + bytes.length + ' bytes, watch expects ' + (watch.stride * watch.h));
    return;
  }
  var id = artId(bytes);
  if (id === watchArtId) {
    console.log('The watch already shows this painting; not sending it again');
    watchEmpty = false;
    return;
  }
  var queued = watchQueue.indexOf(id);
  if (queued >= 0) {
    // The watch has it stored already: just hang it (it drops the ones before).
    console.log('Hanging the painting the watch keeps');
    enqueue({ QueueShow: id });
    watchQueue = watchQueue.slice(queued + 1);
    watchArtId = id;
    watchEmpty = false;
    return;
  }
  // Drop any half-sent older image still in the queue.
  queue = queue.filter(function (item) {
    return item.message.ImgChunk === undefined && item.message.ImgBegin === undefined &&
      item.message.ImgEnd === undefined;
  });
  enqueue({ ImgBegin: bytes.length, ArtId: id });
  // Shuffled, so the painting dissolves in on the watch (see scatter.js).
  var stream = scatter.shuffle(bytes);
  for (var offset = 0; offset < stream.length; offset += watch.chunk) {
    // A plain Array: what Pebble.sendAppMessage expects for byte arrays.
    enqueue({
      ImgOffset: offset,
      ImgChunk: Array.prototype.slice.call(stream, offset, offset + watch.chunk)
    });
  }
  enqueue({ ImgEnd: 1 });
  watchArtId = id;
  watchEmpty = false;
}

// -------------------------------------------------------------------- server

var REQUEST_TIMEOUT_MS = 60000;

/**
 * Make sure the watch shows today's painting.
 * @param {string} [hangKey] hang this painting (picked on the settings page) instead
 * @returns {boolean} whether a download started (false = nothing new needed)
 */
function ensureArt(hangKey) {
  if (!watch) {
    return false;
  }
  var settings = loadSettings();
  var now = new Date();
  var period = rotation.period(settings.rotation, now);
  // A new period with its painting fetched ahead: hang that one, no download.
  if (!fetching && !hangKey && promoteDue(settings, period)) {
    settings = loadSettings();
  }
  var art = readJson(ART_KEY);
  var current = !!(art && art.crop && art.cropKey === cropKey(settings));

  // A freshly started watchface is black until it gets a painting. Send the
  // cached one straight away (even yesterday's, or one made with other
  // settings), then fetch anything newer in the background. Never leave the
  // watch waiting on the network.
  if (watchEmpty) {
    showCached(art, settings);
  }
  if (fetching) {
    if (hangKey) {
      pendingHang = hangKey;
    }
    return true;
  }
  if (hangKey) {
    startFetch(false, byKey(hangKey), period);
    return true;
  }
  // A pinned painting stays until it's unpinned; rotation doesn't apply.
  if (settings.pinned) {
    if (!(current && art.meta.key === settings.pinned)) {
      startFetch(false, byKey(settings.pinned), period);
      return true;
    }
    return false;
  }
  // A painting from a later period is the watch running ahead of our clock.
  var due = !art || !art.meta || (settings.rotation !== 'off' && art.period !== period &&
    !rotation.isAfter(art.period, period));
  if (!due) {
    if (!current) {
      // Same painting, different screen, fit, zoom or position: fetch that crop.
      startFetch(false, byKey(art.meta.key), art.period);
      return true;
    }
    return false;
  }
  // A new painting: check for a new catalog, then load just the file we need.
  if (settings.selection === 'featured') {
    var day = rotation.featuredDay(settings.rotation, now);
    startFetch(true, function (cat, ok, fail) {
      withPool(cat, 'featured', function () {
        var p = cat.featured(day);
        return p ? ok(p.key) : fail('no Featured paintings');
      }, fail);
    }, period);
  } else {
    startFetch(true, function (cat, ok, fail) {
      var pool = cat.poolFor(settings.era);
      withPool(cat, pool, function () {
        var p = cat.random(pool);
        return p ? ok(p.key) : fail('no paintings in ' + pool);
      }, fail);
    }, period);
  }
  return true;
}

// ----------------------------------------------------------------- catalog

function byKey(key) {
  return function (cat, ok) {
    ok(key);
  };
}

/** The catalog from its manifest: cached, or fetched when `refresh` (or none). */
function withCatalog(refresh, done, fail) {
  var cached = readJson(CATALOG_KEY);
  if (cached && !refresh) {
    done(Catalog.create(cached));
    return;
  }
  getText(PAGE_URL + '/catalog/manifest.json', function (text) {
    var manifest;
    try {
      manifest = JSON.parse(text);
    } catch (e) {
      fail('bad catalog manifest: ' + e);
      return;
    }
    if (cached && cached.id !== manifest.id) {
      // A new catalog: its files replace the ones we kept.
      (cached.files || []).forEach(function (f) {
        localStorage.removeItem(CATALOG_KEY + '-' + f.pool);
      });
    }
    localStorage.setItem(CATALOG_KEY, text);
    done(Catalog.create(manifest));
  }, function (why) {
    // Offline: the cached catalog still works.
    if (cached) {
      done(Catalog.create(cached));
    } else {
      fail('no catalog: ' + why);
    }
  });
}

/** Make sure a pool's file (e.g. 1600s.json) is in the catalog: cached or fetched. */
function withPool(cat, pool, done, fail) {
  if (cat.has(pool) || cat.add(readJson(CATALOG_KEY + '-' + pool))) {
    done();
    return;
  }
  var file = cat.fileFor(pool);
  if (!file) {
    fail('no catalog file for ' + pool);
    return;
  }
  getText(PAGE_URL + '/catalog/' + file, function (text) {
    var part;
    try {
      part = JSON.parse(text);
    } catch (e) {
      fail('bad catalog file ' + file + ': ' + e);
      return;
    }
    if (!cat.add(part)) {
      fail(file + ' is from another catalog version');
      return;
    }
    try {
      localStorage.setItem(CATALOG_KEY + '-' + pool, text);
    } catch (e) {
      console.log('Not caching ' + file + ': ' + e);
    }
    done();
  }, fail);
}

/** Add the paintings we know without a file: the one on the watch, pinned, hung. */
function addKnownRows(cat) {
  var rows = readJson(ROWS_KEY) || {};
  for (var key in rows) {
    if (Object.prototype.hasOwnProperty.call(rows, key)) {
      cat.addRow(rows[key]);
    }
  }
  var art = readJson(ART_KEY);
  if (art && art.row) {
    cat.addRow(art.row);
  }
}

/**
 * Pick a painting and fetch it: `choose(cat, ok(key), fail(why))` runs once
 * the catalog is there. `refresh` checks for a new catalog first.
 */
function startFetch(refresh, choose, period) {
  fetching = true;
  withCatalog(refresh, function (cat) {
    addKnownRows(cat);
    choose(cat, function (key) {
      fetchArt(cat, key, period);
    }, fetchFailed);
  }, fetchFailed);
}

function fetchDone() {
  fetching = false;
  if (pendingHang) {
    var key = pendingHang;
    pendingHang = null;
    ensureArt(key);
    return;
  }
  syncQueue();
}

function fetchFailed(why) {
  console.log('Could not load painting: ' + why);
  // The watch keeps whatever it shows (a launch already got the cached
  // painting); just try again later.
  scheduleRetry();
  fetchDone();
}

/**
 * Make a painting's saved look the current settings. Returns whether anything
 * changed (the watch is told about time placement and size).
 */
function applyLook(settings, look) {
  var changed = false;
  for (var k in look) {
    if (Object.prototype.hasOwnProperty.call(look, k) && settings[k] !== look[k]) {
      settings[k] = look[k];
      changed = true;
    }
  }
  if (changed) {
    storeSettings(settings);
    sendSettings(settings);
  }
  return changed;
}

/** Try again later when the server or network is unavailable. */
function scheduleRetry() {
  if (retryTimer) {
    return;
  }
  var minutes = RETRY_MINUTES[Math.min(retryCount, RETRY_MINUTES.length - 1)];
  retryCount += 1;
  console.log('Retrying in ' + minutes + ' min');
  retryTimer = setTimeout(function () {
    retryTimer = null;
    ensureArt();
  }, minutes * 60000);
}

/** GET text (the catalog files) with our own timeout, calling back once. */
function getText(url, onSuccess, onError) {
  var xhr = new XMLHttpRequest();
  var settled = false;
  var finish = function (fn, value) {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      fn(value);
    }
  };
  var timer = setTimeout(function () {
    finish(onError, 'timeout');
    try {
      xhr.abort();
    } catch (e) {
      console.log('Could not abort timed-out request: ' + e);
    }
  }, REQUEST_TIMEOUT_MS);
  xhr.open('GET', url, true);
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      finish(onSuccess, xhr.responseText);
    } else {
      finish(onError, 'HTTP ' + xhr.status + ' for ' + url);
    }
  };
  xhr.onerror = function () { finish(onError, 'network error'); };
  xhr.onabort = function () { finish(onError, 'aborted'); };
  xhr.send();
}

/**
 * Download a picture's bytes. Binary XHR isn't guaranteed in every PebbleKit
 * JS runtime, so try an ArrayBuffer first and fall back to the old
 * "x-user-defined" text trick (each char code is a byte). iOS's XMLHttpRequest
 * has no `timeout`/`ontimeout`, so we time out ourselves and call back once.
 */
function getBytes(url, onSuccess, onError, asText) {
  var xhr = new XMLHttpRequest();
  var settled = false;
  var finish = function (fn, value) {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      fn(value);
    }
  };
  var timer = setTimeout(function () {
    finish(onError, 'timeout');
    try {
      xhr.abort();
    } catch (e) {
      console.log('Could not abort timed-out request: ' + e);
    }
  }, REQUEST_TIMEOUT_MS);
  xhr.open('GET', url, true);
  if (asText) {
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
  } else {
    try {
      xhr.responseType = 'arraybuffer';
    } catch (e) {
      console.log('No binary XHR here: ' + e);
    }
  }
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      finish(onError, 'HTTP ' + xhr.status);
      return;
    }
    var bytes = null;
    if (!asText && xhr.response && xhr.response.byteLength) {
      bytes = new Uint8Array(xhr.response);
    } else if (asText && typeof xhr.responseText === 'string') {
      var text = xhr.responseText;
      bytes = new Uint8Array(text.length);
      for (var i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 0xff;
      }
    }
    // Only trust a real PNG: some runtimes hand back an empty or text-decoded
    // buffer instead of failing.
    if (bytes && png.isPng(bytes)) {
      finish(onSuccess, bytes);
    } else if (!asText) {
      console.log('Binary download not supported here; trying text');
      settled = true;
      clearTimeout(timer);
      getBytes(url, onSuccess, onError, true);
    } else if (CONFIG.DEV_BASE64_URL) {
      // Development only (the emulator can't download binary data): a helper
      // (scripts/emulator-images.mjs) sends the image as base64.
      settled = true;
      clearTimeout(timer);
      getText(CONFIG.DEV_BASE64_URL + encodeURIComponent(url), function (text) {
        var decoded = new Uint8Array(base64.decode(text));
        if (png.isPng(decoded)) {
          onSuccess(decoded);
        } else {
          onError('the dev helper sent no PNG');
        }
      }, onError);
    } else {
      finish(onError, 'this phone app cannot download binary data (got ' +
        (bytes ? bytes.length : 0) + ' unusable bytes)');
    }
  };
  xhr.onerror = function () { finish(onError, 'network error'); };
  xhr.onabort = function () { finish(onError, 'aborted'); };
  xhr.send();
}

/** A failure that won't fix itself: the painting or its image is gone. */
function isGone(why) {
  return /HTTP 40[34]|HTTP 410|not in the catalog/.test(String(why));
}

/** Note on the settings page that the pinned painting can't be fetched any more. */
function markUnavailable(key, title, reason, usingCopy) {
  console.log('Pinned painting ' + key + ' is unavailable: ' + reason);
  localStorage.setItem(UNAVAILABLE_KEY, JSON.stringify({
    key: key, title: title || '', reason: reason, usingCopy: usingCopy, since: today()
  }));
}

function clearUnavailable(key) {
  var note = readJson(UNAVAILABLE_KEY);
  if (note && (!key || note.key === key)) {
    localStorage.removeItem(UNAVAILABLE_KEY);
  }
}

/** Keep a copy of the pinned painting (once), for when the Rijksmuseum drops it. */
function keepPinnedCopy(cat, key) {
  var copy = readJson(SOURCE_KEY);
  if (copy && copy.key === key) {
    return;
  }
  var req = cat.workImage(key, watch, 200);
  if (!req) {
    return;
  }
  getBytes(req.url, function (file) {
    try {
      localStorage.setItem(SOURCE_KEY, JSON.stringify({ key: key, row: cat.row(key), png: base64.encode(file) }));
      console.log('Kept a copy of the pinned painting (' + file.length + ' bytes)');
    } catch (e) {
      console.log('Could not keep a copy of the pinned painting: ' + e);
    }
  }, function (why) {
    console.log('Could not download a copy of the pinned painting: ' + why);
  });
}

/**
 * Cut the crop from the pinned painting's own copy (see keepPinnedCopy), the
 * way the settings page does. Returns {rgb, w, h}, or null without a copy.
 */
function cropFromCopy(cat, key, settings) {
  var copy = readJson(SOURCE_KEY);
  if (!copy || copy.key !== key) {
    return null;
  }
  cat.addRow(copy.row);
  var image = png.decode(new Uint8Array(base64.decode(copy.png)));
  var w = watch.w;
  var h = watch.h;
  var rect = { x: 0, y: 0, w: image.width, h: image.height };
  if (settings.fit === 'whole') {
    var contain = cat.cropRequest(key, watch, 'whole');
    w = contain.width;
    h = contain.height;
  } else {
    var v = cat.coverView(key, watch, settings);
    rect = { x: v.x * image.width, y: v.y * image.height, w: v.w * image.width, h: v.h * image.height };
  }
  return { rgb: render.cropRect(image.data, image.width, image.height, rect, w, h), w: w, h: h };
}

/** Cache a painting's toned crop and send it to the watch. */
/** What we keep of a painting's crop (nw-art, and each nw-queue entry). */
function artRecord(cat, key, settings, period, rgb, size) {
  var painting = cat.get(key);
  return {
    date: today(),
    period: period,
    cropKey: cropKey(settings),
    crop: base64.encode(rgb),
    cropW: size.w,
    cropH: size.h,
    // Its catalog row: enough to fetch another crop later without a file.
    row: cat.row(key),
    meta: {
      key: painting.key,
      title: painting.title,
      artist: painting.artist,
      date: painting.date,
      objectNumber: painting.objectNumber,
      webUrl: painting.webUrl,
      imageUrl: painting.imageUrl,
      iiifBase: painting.iiifBase,
      license: painting.license,
      licenseUrl: painting.licenseUrl
    }
  };
}

function showNewArt(cat, key, settings, period, rgb, size) {
  retryCount = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  var record = artRecord(cat, key, settings, period, rgb, size);
  try {
    localStorage.setItem(ART_KEY, JSON.stringify(record));
  } catch (e) {
    console.log('Could not cache painting: ' + e);
  }
  sendImage(composeFor(record, loadSettings()));
}

/**
 * Get a painting's crop straight from the Rijksmuseum (IIIF cuts the planned
 * region), tone it, cache it and send it to the watch. A pinned painting that
 * is gone (not in the catalog, or its image removed) is never retried: the
 * settings page says so, and its own copy (if kept) still serves crops.
 * @param {object} cat the catalog, with this painting's row in it
 * @param {string} key the painting
 * @param {string} period the rotation period it belongs to (see rotation.js)
 */
function fetchArt(cat, key, period) {
  var settings = loadSettings();
  var pinned = settings.pinned === key;
  var copy = readJson(SOURCE_KEY);
  if (pinned && copy && copy.key === key) {
    cat.addRow(copy.row);
  }
  var title = (cat.get(key) || {}).title;

  /** Serve a pinned painting from its copy, or note it's unavailable. */
  var gone = function (why) {
    var cut = null;
    if (pinned) {
      try {
        cut = cropFromCopy(cat, key, settings);
      } catch (e) {
        console.log('Could not use the pinned copy: ' + e);
      }
      markUnavailable(key, title, String(why), Boolean(cut));
    } else {
      console.log('Painting ' + key + ' is gone: ' + why);
    }
    if (cut) {
      showNewArt(cat, key, settings, period, render.tone(cut.rgb), { w: cut.w, h: cut.h });
    }
    fetchDone(); // no retry: it won't come back by itself
  };

  var painting = cat.get(key);
  if (!painting) {
    gone('not in the catalog');
    return;
  }

  // Settle the look first, so we ask for the right part of the painting once.
  // A painting with a saved look gets it back; a new one without starts at its
  // planned view (zoom and position belong to one painting); others keep the
  // current settings.
  var previous = readJson(ART_KEY);
  var samePainting = previous && previous.meta && previous.meta.key === painting.key;
  if (!samePainting || looks.get(localStorage, painting.key, settings)) {
    applyLook(settings, lookFor(settings, painting.key));
  }

  var request = cat.cropRequest(painting.key, watch, settings.fit, settings);
  if (!request) {
    fetchFailed('no crop for this screen');
    return;
  }
  getBytes(request.url, function (file) {
    var rgb;
    var size;
    try {
      var image = png.decode(file);
      size = { w: image.width, h: image.height };
      rgb = render.tone(image.data);
    } catch (e) {
      fetchFailed('could not decode the picture: ' + e);
      return;
    }
    if (pinned) {
      clearUnavailable(key);
    }
    showNewArt(cat, key, settings, period, rgb, size);
    if (pinned) {
      keepPinnedCopy(cat, key);
    }
    fetchDone();
  }, function (why) {
    if (isGone(why)) {
      gone(why);
    } else {
      fetchFailed(why);
    }
  });
}

// ------------------------------------------------------------ sent ahead
// Watches with room to store paintings (Pebble Time 2, Round 2: QueueCap in
// the Hello) get the next few periods' paintings ahead of time, each with the
// moment it is due. The watch hangs them itself, so a new painting still comes
// at midnight when the phone is away. The phone keeps the same paintings in
// nw-queue and, when the watch reports one on show, makes it the current one.

/** What the coming periods should show: `{period, from, day, plan}`. */
function upcomingPlan(settings, now) {
  if (!watch || !watch.queueCap || settings.pinned || settings.rotation === 'off') {
    return [];
  }
  var plan = settings.selection === 'featured' ? 'featured' : 'random:' + settings.era;
  return rotation.upcoming(settings.rotation, now, watch.queueCap).map(function (p) {
    return { period: p.period, from: Math.floor(p.start.getTime() / 1000), day: p.featuredDay, plan: plan };
  });
}

function readQueue() {
  var q = readJson(QUEUE_KEY);
  return Object.prototype.toString.call(q) === '[object Array]' ? q : [];
}

function writeQueue(entries) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
    return true;
  } catch (e) {
    console.log('Could not keep paintings ahead: ' + e);
    return false;
  }
}

/** Ids (int32) packed as little-endian bytes, as the watch reads them. */
function packIds(ids) {
  var bytes = [];
  ids.forEach(function (id) {
    for (var i = 0; i < 4; i++) {
      bytes.push((id >>> (8 * i)) & 0xff);
    }
  });
  return bytes;
}

function unpackIds(bytes) {
  var ids = [];
  for (var i = 0; bytes && i + 3 < bytes.length; i += 4) {
    ids.push((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) | 0);
  }
  return ids;
}

/** What decides a painting's bytes besides its crop. */
function renderSig(settings) {
  return [watch.w, watch.h, watch.stride, watch.round, settings.fit, settings.frame, settings.palette,
    settings.dither, settings.brightness, settings.contrast].join(':');
}

/**
 * Make a painting sent ahead the current one (nw-art), with its look, and drop
 * it and the ones before it from nw-queue.
 */
function promote(entry) {
  var entries = readQueue();
  var keep = entries.filter(function (e) {
    return e.from > entry.from;
  });
  writeQueue(keep);
  var settings = loadSettings();
  applyLook(settings, lookFor(settings, entry.meta.key));
  var record = {};
  ['period', 'cropKey', 'crop', 'cropW', 'cropH', 'row', 'meta'].forEach(function (k) {
    record[k] = entry[k];
  });
  record.date = today();
  try {
    localStorage.setItem(ART_KEY, JSON.stringify(record));
  } catch (e) {
    console.log('Could not cache painting: ' + e);
  }
  console.log('Now showing ' + entry.meta.key + ', sent ahead for ' + entry.period);
}

/** The watch hung a painting we sent ahead: make it ours too. */
function promoteShown(id) {
  var entries = readQueue();
  for (var i = 0; id && i < entries.length; i++) {
    if (entries[i].id === id) {
      promote(entries[i]);
      return;
    }
  }
}

/** A new period began and we have its painting: make it current. */
function promoteDue(settings, period) {
  if (settings.pinned || settings.rotation === 'off') {
    return false;
  }
  var art = readJson(ART_KEY);
  if (art && (art.period === period || rotation.isAfter(art.period, period))) {
    return false;
  }
  var plan = settings.selection === 'featured' ? 'featured' : 'random:' + settings.era;
  var entries = readQueue();
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].period === period && entries[i].plan === plan) {
      promote(entries[i]);
      return true;
    }
  }
  return false;
}

/** Stream a painting to the watch's store, in storage-sized pieces. */
function sendAhead(entry, bytes) {
  var id = entry.id;
  console.log('Sending ' + entry.meta.key + ' ahead for ' + entry.period);
  enqueueBackground({ QueueBegin: bytes.length, ArtId: id, QueueFrom: entry.from }, id);
  // The watch writes each chunk straight to storage, in 256-byte pieces.
  var chunk = Math.floor(watch.chunk / 256) * 256;
  for (var offset = 0; offset < bytes.length; offset += chunk) {
    enqueueBackground({
      ImgOffset: offset,
      QueueChunk: Array.prototype.slice.call(bytes, offset, offset + chunk)
    }, id);
  }
  enqueueBackground({ QueueEnd: 1 }, id, function () {
    if (watchQueue.indexOf(id) < 0) {
      watchQueue.push(id);
    }
  });
}

/**
 * Bring the paintings sent ahead in line with the settings: drop the ones no
 * longer planned, render the rest (their ids change with frame or tuning),
 * tell the watch which to keep, send it the missing ones and fetch the next
 * one still missing.
 */
function syncQueue() {
  if (!watch || !watch.queueCap) {
    return;
  }
  var settings = loadSettings();
  var art = readJson(ART_KEY);
  // Only periods after the one on show (the watch's clock may run ahead of ours).
  var plan = upcomingPlan(settings, new Date()).filter(function (p) {
    return !(art && (art.period === p.period || rotation.isAfter(art.period, p.period)));
  });
  var stored = readQueue();
  var entries = stored.filter(function (e) {
    var wanted = plan.some(function (p) {
      return p.period === e.period && p.plan === e.plan;
    });
    return wanted && e.meta && e.cropKey === cropKey(lookFor(settings, e.meta.key));
  });
  var dirty = entries.length !== stored.length;
  entries.forEach(function (e) {
    var look = lookFor(settings, e.meta.key);
    var sig = renderSig(look);
    if (e.sig !== sig || !e.id) {
      e.id = artId(composeFor(e, look));
      e.sig = sig;
      dirty = true;
    }
  });
  if (dirty) {
    writeQueue(entries);
  }

  var ids = entries.map(function (e) {
    return e.id;
  });
  // Pending transfers of paintings no longer wanted can go (qid 0: QueueKeep).
  background = background.filter(function (item) {
    return item.qid === 0 || ids.indexOf(item.qid) >= 0;
  });
  var sendingIds = background.map(function (item) {
    return item.qid;
  });
  if (watchQueue.some(function (id) { return ids.indexOf(id) < 0; })) {
    // An id 0 matches nothing: an empty list would be no list at all.
    enqueueBackground({ QueueKeep: packIds(ids.length ? ids : [0]) }, 0);
    watchQueue = watchQueue.filter(function (id) {
      return ids.indexOf(id) >= 0;
    });
  }
  entries.forEach(function (e) {
    if (watchQueue.indexOf(e.id) < 0 && sendingIds.indexOf(e.id) < 0) {
      sendAhead(e, composeFor(e, lookFor(settings, e.meta.key)));
    }
  });

  var missing = plan.filter(function (p) {
    return !entries.some(function (e) {
      return e.period === p.period;
    });
  });
  if (missing.length && !fetching && !prefetching && prefetches < 2 * watch.queueCap) {
    prefetches += 1;
    prefetch(missing[0], entries);
  }
}

/** Fetch the painting for one coming period and keep it in nw-queue. */
function prefetch(slot, entries) {
  prefetching = true;
  var art = readJson(ART_KEY);
  var taken = entries.map(function (e) {
    return e.meta.key;
  });
  if (art && art.meta) {
    taken.push(art.meta.key);
  }
  var done = function (why) {
    prefetching = false;
    if (why) {
      // Try again with the next Hello (launch or new day); no retry storm.
      console.log('Could not fetch a painting ahead: ' + why);
    }
  };
  withCatalog(false, function (cat) {
    addKnownRows(cat);
    var pick = function (pool) {
      withPool(cat, pool, function () {
        var p = null;
        if (slot.plan === 'featured') {
          p = cat.featured(slot.day);
        } else {
          // Not one we show or sent ahead already, if we can help it.
          for (var tries = 0; tries < 10 && (!p || taken.indexOf(p.key) >= 0); tries++) {
            p = cat.random(pool);
          }
        }
        if (!p) {
          done('no painting for ' + slot.period);
          return;
        }
        var settings = lookFor(loadSettings(), p.key);
        var request = cat.cropRequest(p.key, watch, settings.fit, settings);
        if (!request) {
          done('no crop for this screen');
          return;
        }
        getBytes(request.url, function (file) {
          var entry;
          try {
            var image = png.decode(file);
            entry = artRecord(cat, p.key, settings, slot.period, render.tone(image.data),
              { w: image.width, h: image.height });
          } catch (e) {
            done('could not decode the picture: ' + e);
            return;
          }
          entry.from = slot.from;
          entry.plan = slot.plan;
          // Settings may have changed while downloading: syncQueue sorts it out.
          var current = readQueue().filter(function (e) {
            return e.period !== slot.period;
          });
          current.push(entry);
          current.sort(function (a, b) {
            return a.from - b.from;
          });
          var stored = writeQueue(current);
          done(stored ? null : 'no room on the phone');
          if (stored) {
            syncQueue();
          }
        }, done);
      }, done);
    };
    pick(slot.plan === 'featured' ? 'featured' : cat.poolFor(settingsEra(slot.plan)));
  }, done);
}

/** The era of a "random:<era>" plan. */
function settingsEra(plan) {
  return plan.split(':')[1] || 'any';
}

// -------------------------------------------------------------------- events

Pebble.addEventListener('ready', function () {
  // The watch may have said hello before we were running; ask again.
  enqueue({ PhoneReady: 1 });
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload;
  if (p.Hello === undefined) {
    return;
  }
  watch = {
    w: p.ScreenW,
    h: p.ScreenH,
    stride: p.RowStride,
    round: p.IsRound,
    chunk: p.ChunkSize,
    is24h: p.Is24h,
    queueCap: p.QueueCap || 0
  };
  watchArtId = p.ArtId || 0;
  watchQueue = unpackIds(p.QueueIds);
  prefetches = 0;
  // The watch may have hung a painting we sent ahead (e.g. at midnight).
  promoteShown(watchArtId);
  if (p.Hello === 1) {
    // The watchface just started: its screen is empty, and whatever was on
    // its way to the watch's store is lost.
    watchEmpty = true;
    background = [];
    sendSettings(loadSettings());
  }
  // Hello 2 = new day; the date check picks a new painting.
  if (!ensureArt()) {
    syncQueue();
  }
});

/**
 * The saved looks, for previews on the settings page. They travel in the
 * page's URL, so past ~100 KB (hundreds of looks) the page goes without them;
 * the phone still applies them when it hangs a painting.
 */
function looksForPage() {
  var saved = looks.all(localStorage);
  return JSON.stringify(saved).length > 100000 ? {} : saved;
}

// ------------------------------------------------------------------- debug
// A build with DEBUG: true in config.js (e.g. a sideloaded dev build) opens
// the settings page with ?debug=true: it shows the phone's state and offers
// actions the phone runs when the page closes (see runDebug).

/** Every localStorage key we use, with the cached catalog files. */
function storageKeys() {
  var keys = [SETTINGS_KEY, 'nw-looks', ART_KEY, QUEUE_KEY, CATALOG_KEY, ROWS_KEY, SOURCE_KEY, UNAVAILABLE_KEY];
  var manifest = readJson(CATALOG_KEY);
  ((manifest && manifest.files) || []).forEach(function (f) {
    keys.push(CATALOG_KEY + '-' + f.pool);
  });
  return keys;
}

/** What the debug pane shows: stored items and their sizes, and the state. */
function debugInfo() {
  var storage = {};
  storageKeys().forEach(function (key) {
    var value = localStorage.getItem(key);
    if (value !== null && value !== undefined) {
      storage[key] = String(value).length;
    }
  });
  var art = readJson(ART_KEY);
  var manifest = readJson(CATALOG_KEY);
  return {
    storage: storage,
    catalogId: manifest ? manifest.id : null,
    painting: art ? { key: art.meta.key, title: art.meta.title, period: art.period, cropKey: art.cropKey, date: art.date } : null,
    watchArtId: watchArtId,
    queue: readQueue().map(function (e) {
      return { key: e.meta.key, title: e.meta.title, period: e.period, id: e.id, onWatch: watchQueue.indexOf(e.id) >= 0 };
    }),
    watchQueue: watchQueue,
    fetching: fetching,
    prefetching: prefetching,
    retryCount: retryCount,
    config: { SETTINGS_URL: PAGE_URL, DEV_BASE64_URL: CONFIG.DEV_BASE64_URL || null }
  };
}

/** Run a debug action from the settings page. */
function runDebug(action) {
  console.log('Debug: ' + action);
  if (action === 'reset') {
    // Everything we stored, as after a fresh install (the watch keeps its own
    // copy of the painting until a new one arrives).
    storageKeys().forEach(function (key) {
      localStorage.removeItem(key);
    });
    watchArtId = 0;
    watchEmpty = true;
    sendSettings(loadSettings());
    ensureArt();
  } else if (action === 'clear-catalog') {
    storageKeys().forEach(function (key) {
      if (key.indexOf(CATALOG_KEY) === 0) {
        localStorage.removeItem(key);
      }
    });
  } else if (action === 'new-painting') {
    // Forget the current period, so the rotation picks a painting now.
    var art = readJson(ART_KEY);
    if (art) {
      art.period = 'debug';
      localStorage.setItem(ART_KEY, JSON.stringify(art));
    }
    ensureArt();
  } else if (action === 'resend') {
    watchArtId = 0;
    showCached(readJson(ART_KEY), loadSettings());
  }
}

Pebble.addEventListener('showConfiguration', function () {
  var art = readJson(ART_KEY);
  // Rows of the paintings we know (on the watch, pinned): the page shows them
  // without loading catalog files.
  var rows = readJson(ROWS_KEY) || {};
  if (art && art.row) {
    rows[art.row[0]] = art.row;
  }
  var state = {
    settings: settingsLib.toStored(loadSettings()),
    art: art ? art.meta : null,
    watch: watch,
    looks: looksForPage(),
    rows: rows,
    // The pinned painting can't be fetched any more (shown as a notice).
    unavailable: readJson(UNAVAILABLE_KEY)
  };
  if (CONFIG.DEBUG) {
    state.debug = debugInfo();
  }
  Pebble.openURL(PAGE_URL + '/' + (CONFIG.DEBUG ? '?debug=true' : '') + '#' +
    encodeURIComponent(JSON.stringify(state)));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) {
    return; // closed without saving
  }
  var result;
  try {
    result = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    // Some phones hand us the response already decoded.
    try {
      result = JSON.parse(e.response);
    } catch (err2) {
      console.log('Could not read settings: ' + err + ' / ' + err2);
      return;
    }
  }
  // A debug action from the settings page (?debug=true) instead of settings.
  if (result.debug) {
    runDebug(result.debug);
    return;
  }
  // The page says which settings version it speaks.
  var sent = result.settings || {};
  var stamped = { version: result.version };
  for (var key in sent) {
    if (Object.prototype.hasOwnProperty.call(sent, key)) {
      stamped[key] = sent[key];
    }
  }
  var incoming = settingsLib.load(stamped);
  var settings = loadSettings();
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(sent, k)) {
      settings[k] = incoming[k];
    }
  }
  storeSettings(settings);
  sendSettings(settings);
  // Rows for the paintings the page picked (hung or pinned), so we can fetch
  // them without loading their catalog file. Keep only the pinned one besides.
  if (result.rows && typeof result.rows === 'object') {
    var keep = {};
    var known = readJson(ROWS_KEY) || {};
    if (settings.pinned && known[settings.pinned]) {
      keep[settings.pinned] = known[settings.pinned];
    }
    for (var rk in result.rows) {
      if (Object.prototype.hasOwnProperty.call(result.rows, rk)) {
        keep[rk] = result.rows[rk];
      }
    }
    localStorage.setItem(ROWS_KEY, JSON.stringify(keep));
  }
  // The pinned painting's copy and notice only matter while it stays pinned.
  var copy = readJson(SOURCE_KEY);
  if (copy && copy.key !== settings.pinned) {
    localStorage.removeItem(SOURCE_KEY);
  }
  var note = readJson(UNAVAILABLE_KEY);
  if (note && note.key !== settings.pinned) {
    clearUnavailable();
  }
  // A restored backup replaces every saved look.
  if (result.looks && typeof result.looks === 'object') {
    looks.replaceAll(localStorage, result.looks);
  }
  // The reader changed the look: remember it for the painting that ends up on
  // the watch, so it comes back whenever that painting is hung again.
  if (result.saveLook) {
    var hung = typeof result.artKey === 'string' ? result.artKey : null;
    var cached = readJson(ART_KEY);
    looks.save(localStorage, hung || (cached && cached.meta && cached.meta.key), settings);
  }
  // The painting previewed on the settings page, or another crop if the fit
  // changed; otherwise just re-render the cached crop (tuning and frame are
  // applied here, no download).
  if (!ensureArt(typeof result.artKey === 'string' ? result.artKey : undefined)) {
    showCached(readJson(ART_KEY), settings);
    // Frame, tuning or rotation may have changed what was sent ahead.
    syncQueue();
  }
});
