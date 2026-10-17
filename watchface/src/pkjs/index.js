/**
 * Treasure Trove — phone side.
 *
 * Responsibilities:
 *  1. Learn the watch's screen (size, color, row stride, shape) from its Hello.
 *  2. Once per day, ask the server for a random painting rendered for that
 *     screen, and keep it in localStorage so relaunching the face is instant
 *     and works offline.
 *  3. Stream the bytes to the watch in chunks.
 *  4. Open the custom settings page and forward the choices to the watch.
 *
 * Written in ES5 on purpose: the PebbleKit JS runtime is not a modern browser.
 */
var CONFIG = require('./config');
var base64 = require('./base64');
var rotation = require('./rotation');
var render = require('./render');
var looks = require('./looks');
var settingsLib = require('./settings');

var SETTINGS_KEY = 'tt-settings';
var ART_KEY = 'tt-art';

var DEFAULTS = settingsLib.DEFAULTS;

var watch = null;        // screen info from the watch's Hello
var fetching = false;
var pendingHang = null;  // painting picked in settings while a fetch was running
// True after the watchface (re)starts: its screen is black until we send a
// painting. Cleared once we've sent one.
var watchEmpty = true;
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
  return [watch.w, watch.h, watch.round, settings.fit].join(':');
}

function screenQuery(settings) {
  return 'w=' + watch.w + '&h=' + watch.h + '&round=' + watch.round +
    '&fit=' + settings.fit + '&era=' + settings.era;
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
  var row = s.textRow === 'top' ? 0 : 1;
  var col = ['start', 'center', 'end'].indexOf(s.textCol);
  if (watch && watch.round) {
    col = 1;
  } else if (col < 0) {
    col = 2;
  }
  return row * 3 + col;
}

function sendImage(bytes) {
  if (bytes.length !== watch.stride * watch.h) {
    console.log('Image has ' + bytes.length + ' bytes, watch expects ' + (watch.stride * watch.h));
    return;
  }
  // Drop any half-sent older image still in the queue.
  queue = queue.filter(function (item) {
    return item.message.ImgChunk === undefined && item.message.ImgBegin === undefined &&
      item.message.ImgEnd === undefined;
  });
  enqueue({ ImgBegin: bytes.length });
  for (var offset = 0; offset < bytes.length; offset += watch.chunk) {
    // A plain Array: what Pebble.sendAppMessage expects for byte arrays.
    enqueue({
      ImgOffset: offset,
      ImgChunk: Array.prototype.slice.call(bytes, offset, offset + watch.chunk)
    });
  }
  enqueue({ ImgEnd: 1 });
  watchEmpty = false;
}

// -------------------------------------------------------------------- server

var REQUEST_TIMEOUT_MS = 60000;

/**
 * GET with a timeout that works everywhere. iOS's XMLHttpRequest has no
 * `timeout`/`ontimeout`, so a hanging request would never call back and leave
 * `fetching` stuck; we time out ourselves and call back exactly once.
 */
function get(url, onSuccess, onError) {
  var xhr = new XMLHttpRequest();
  var settled = false;
  var finish = function (fn, value) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    fn(value);
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
      finish(onError, 'HTTP ' + xhr.status + ': ' + xhr.responseText);
    }
  };
  xhr.onerror = function () { finish(onError, 'network error'); };
  xhr.onabort = function () { finish(onError, 'aborted'); };
  xhr.send();
}

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
    fetchArt('/api/art/' + encodeURIComponent(hangKey), settings, period);
    return true;
  }
  // A pinned painting stays until it's unpinned; rotation doesn't apply.
  if (settings.pinned) {
    if (!(current && art.meta.key === settings.pinned)) {
      fetchArt('/api/art/' + encodeURIComponent(settings.pinned), settings, period);
      return true;
    }
    return false;
  }
  var due = !art || !art.meta || (settings.rotation !== 'off' && art.period !== period);
  if (!due) {
    if (!current) {
      // Same painting, different screen or fit: fetch its other crop.
      fetchArt('/api/art/' + encodeURIComponent(art.meta.key), settings, art.period);
      return true;
    }
    return false;
  }
  if (settings.selection === 'featured') {
    fetchArt('/api/art/featured', settings, period,
      '&day=' + rotation.featuredDay(settings.rotation, now));
  } else {
    fetchArt('/api/art/random', settings, period);
  }
  return true;
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

/**
 * Fetch a painting and send it to the watch.
 * @param {string} period the rotation period it belongs to (see rotation.js)
 * @param {string} [extraQuery] e.g. '&day=12'
 */
function fetchArt(path, settings, period, extraQuery) {
  fetching = true;
  var base = CONFIG.SERVER_URL;
  var done = function () {
    fetching = false;
    if (pendingHang) {
      var key = pendingHang;
      pendingHang = null;
      ensureArt(key);
    }
  };
  var fail = function (why) {
    console.log('Could not load painting: ' + why);
    // The watch keeps whatever it shows (a launch already got the cached
    // painting); just try again later.
    scheduleRetry();
    done();
  };

  get(base + path + '?' + screenQuery(settings) + (extraQuery || ''), function (text) {
    var meta;
    try {
      meta = JSON.parse(text);
    } catch (e) {
      fail('bad JSON from server: ' + e);
      return;
    }
    get(base + meta.rgbUrl + '&format=b64', function (crop) {
      retryCount = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      var record = {
        date: today(),
        period: period,
        cropKey: cropKey(settings),
        crop: crop,
        cropW: meta.render.width,
        cropH: meta.render.height,
        meta: {
          key: meta.key,
          title: meta.title,
          artist: meta.artist,
          date: meta.date,
          objectNumber: meta.objectNumber,
          webUrl: meta.webUrl,
          imageUrl: meta.imageUrl,
          iiifBase: meta.iiifBase,
          license: meta.license,
          licenseUrl: meta.licenseUrl,
          cropMode: meta.render && meta.render.crop ? meta.render.crop.mode : null,
          cropUrl: base + meta.cropUrl
        }
      };
      // A painting with a saved look gets it back; others keep the current one.
      var current = loadSettings();
      var look = looks.get(localStorage, meta.key, current);
      if (look && applyLook(current, look) && look.fit !== settings.fit) {
        // Saved with the other crop: fetch that one instead (still fetching).
        fetchArt('/api/art/' + encodeURIComponent(meta.key), loadSettings(), period);
        return;
      }
      try {
        localStorage.setItem(ART_KEY, JSON.stringify(record));
      } catch (e) {
        console.log('Could not cache painting: ' + e);
      }
      sendImage(composeFor(record, loadSettings()));
      done();
    }, fail);
  }, fail);
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

Pebble.addEventListener('showConfiguration', function () {
  var art = readJson(ART_KEY);
  var state = {
    settings: settingsLib.toStored(loadSettings()),
    art: art ? art.meta : null,
    watch: watch,
    looks: looksForPage()
  };
  Pebble.openURL(CONFIG.SERVER_URL + '/config/#' + encodeURIComponent(JSON.stringify(state)));
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
