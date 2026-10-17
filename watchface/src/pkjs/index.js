/**
 * Treasure Trove — phone side.
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

var SETTINGS_KEY = 'tt-settings';
var ART_KEY = 'tt-art';
// The catalog manifest, and each catalog file we loaded (tt-catalog-<pool>).
var CATALOG_KEY = 'tt-catalog';
// Rows of paintings the settings page handed over (pinned or hung), by key.
var ROWS_KEY = 'tt-rows';
// The pinned painting's own copy (the whole painting, PNG), so it stays
// usable, crops and zoom included, if the Rijksmuseum drops it.
var SOURCE_KEY = 'tt-pinned-source';
// A pinned painting we can no longer get: shown on the settings page.
var UNAVAILABLE_KEY = 'tt-unavailable';

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

/** Send the cached painting (render it first if it's a crop). */
function showCached(art, settings) {
  if (art && art.crop) {
    sendImage(composeFor(art, settings));
  } else if (art && art.raw) {
    // Cached by an older version: already the watch's bytes.
    sendImage(base64.decode(art.raw));
  }
}

// ---------------------------------------------------------------- messaging

var queue = [];
var sending = false;

/** AppMessages must go one at a time; retry with back-off on NACK. */
function enqueue(message, onDone) {
  queue.push({ message: message, onDone: onDone, tries: 0 });
  pump();
}

function pump() {
  if (sending || queue.length === 0) {
    return;
  }
  sending = true;
  var item = queue[0];
  Pebble.sendAppMessage(item.message, function () {
    queue.shift();
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
      queue.shift();
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
  var art = readJson(ART_KEY);
  var current = !!(art && art.crop && art.cropKey === cropKey(settings));
  var now = new Date();
  var period = rotation.period(settings.rotation, now);

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
  var due = !art || !art.meta || (settings.rotation !== 'off' && art.period !== period);
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
  }
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
function showNewArt(cat, key, settings, period, rgb, size) {
  var painting = cat.get(key);
  retryCount = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  var record = {
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
  var look = looks.get(localStorage, painting.key, settings);
  var previous = readJson(ART_KEY);
  var samePainting = previous && previous.meta && previous.meta.key === painting.key;
  if (look) {
    applyLook(settings, look);
  } else if (!samePainting) {
    // A painting without a saved look starts with default colors, zoom and
    // position (looks.FRESH); crop, frame and time placement carry over.
    var changed = false;
    looks.FRESH.forEach(function (k) {
      if (settings[k] !== DEFAULTS[k]) {
        settings[k] = DEFAULTS[k];
        changed = true;
      }
    });
    if (changed) {
      storeSettings(settings);
    }
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
    is24h: p.Is24h
  };
  watchArtId = p.ArtId || 0;
  if (p.Hello === 1) {
    // The watchface just started: its screen is empty.
    watchEmpty = true;
    sendSettings(loadSettings());
  }
  ensureArt(); // Hello 2 = new day; the date check picks a new painting.
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
  var keys = [SETTINGS_KEY, 'tt-looks', ART_KEY, CATALOG_KEY, ROWS_KEY, SOURCE_KEY, UNAVAILABLE_KEY];
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
    fetching: fetching,
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
  }
});
