/**
 * Treasure Trove — phone side.
 *
 * Responsibilities:
 *  1. Learn the watch's screen (size, colour, row stride, shape) from its Hello.
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

var SETTINGS_KEY = 'tt-settings';
var ART_KEY = 'tt-art';

var DEFAULTS = {
  showTime: true,
  clockMode: 'auto',     // auto | 12 | 24
  hideAmPm: false,
  showDate: true,
  dateFormat: 'dd-mm',   // dd-mm | mm-dd
  hideUntilShake: false,
  revealMinutes: 1,      // how long a flick shows the time (1-60)
  boxMode: 'off',        // off | always
  fit: 'fill',           // fill | whole
  palette: 'defined',    // defined | sun | room | backlight
  frame: 'none',         // none | gold | wood | gallery
  selection: 'featured', // featured (365 most-read) | random
  era: 'any',            // for random: any | pre1600 | 1600s | 1700s | 1800s | 1900s
  rotation: 'daily',     // daily | weekly | monthly | off
  pinned: ''             // key of a painting chosen by id; set = no rotation
};

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
  var saved = readJson(SETTINGS_KEY) || {};
  var s = {};
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
      s[k] = Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : DEFAULTS[k];
    }
  }
  return s;
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function today() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** Identifies one rendering of a painting for this watch + settings. */
function renderKey(settings) {
  return [watch.w, watch.h, watch.stride, watch.round, settings.fit, settings.palette,
    settings.frame].join(':');
}

function screenQuery(settings) {
  return 'w=' + watch.w + '&h=' + watch.h + '&color=1&stride=' + watch.stride +
    '&round=' + watch.round + '&fit=' + settings.fit + '&palette=' + settings.palette +
    '&frame=' + settings.frame + '&era=' + settings.era;
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
    DateFormat: s.dateFormat === 'mm-dd' ? 1 : 0,
    HideUntilShake: s.hideUntilShake ? 1 : 0,
    RevealMinutes: Math.min(60, Math.max(1, Math.round(Number(s.revealMinutes) || 1))),
    BoxMode: s.boxMode === 'always' ? 1 : 0
  });
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
    enqueue({ ImgOffset: offset, ImgChunk: bytes.slice(offset, offset + watch.chunk) });
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
 */
function ensureArt(hangKey) {
  if (!watch) {
    return;
  }
  var settings = loadSettings();
  var art = readJson(ART_KEY);
  var current = !!(art && art.raw && art.renderKey === renderKey(settings));
  var now = new Date();
  var period = rotation.period(settings.rotation, now);

  // A freshly started watchface is black until it gets a painting. Send the
  // cached one straight away (even yesterday's, or one made with other
  // settings), then fetch anything newer in the background. Never leave the
  // watch waiting on the network.
  if (watchEmpty && art && art.raw) {
    sendImage(base64.decode(art.raw));
  }
  if (fetching) {
    if (hangKey) {
      pendingHang = hangKey;
    }
    return;
  }
  if (hangKey) {
    fetchArt('/api/art/' + encodeURIComponent(hangKey), settings, period);
    return;
  }
  // A pinned painting stays until it's unpinned; rotation doesn't apply.
  if (settings.pinned) {
    if (!(current && art.meta.key === settings.pinned)) {
      fetchArt('/api/art/' + encodeURIComponent(settings.pinned), settings, period);
    }
    return;
  }
  var due = !art || !art.meta || (settings.rotation !== 'off' && art.period !== period);
  if (!due) {
    if (!current) {
      // Same painting, different screen/framing/colours: re-render it.
      fetchArt('/api/art/' + encodeURIComponent(art.meta.key), settings, art.period);
    }
    return;
  }
  if (settings.selection === 'featured') {
    fetchArt('/api/art/featured', settings, period,
      '&day=' + rotation.featuredDay(settings.rotation, now));
  } else {
    fetchArt('/api/art/random', settings, period);
  }
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
    get(base + meta.rawUrl + '&format=b64', function (raw) {
      retryCount = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      var record = {
        date: today(),
        period: period,
        renderKey: renderKey(settings),
        raw: raw,
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
          wiki: meta.wiki || null,
          crop: meta.render && meta.render.crop ? meta.render.crop.mode : null,
          previewUrl: base + meta.previewUrl
        }
      };
      try {
        localStorage.setItem(ART_KEY, JSON.stringify(record));
      } catch (e) {
        console.log('Could not cache painting: ' + e);
      }
      sendImage(base64.decode(raw));
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

Pebble.addEventListener('showConfiguration', function () {
  var art = readJson(ART_KEY);
  var now = new Date();
  var state = {
    settings: loadSettings(),
    art: art ? art.meta : null,
    watch: watch,
    // Featured day per rotation, so the page can preview the right painting.
    featuredDay: {
      daily: rotation.featuredDay('daily', now),
      weekly: rotation.featuredDay('weekly', now),
      monthly: rotation.featuredDay('monthly', now),
      off: rotation.featuredDay('off', now)
    }
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
  var settings = loadSettings();
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(result.settings || {}, k)) {
      settings[k] = result.settings[k];
    }
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  sendSettings(settings);
  // The painting previewed on the settings page; otherwise re-render only if
  // framing, frame or colours changed.
  ensureArt(typeof result.artKey === 'string' ? result.artKey : undefined);
});
