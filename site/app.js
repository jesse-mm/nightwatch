// Treasure Trove settings page.
// Opened by the phone app with the current state in the URL hash, and closed by
// navigating to `return_to` (emulator) or `pebblejs://close#` with the result.

const DEFAULTS = window.TreasureSettings.DEFAULTS;
// Translated text (i18n.js, translations/*.json). i18n.js loads this file once
// the texts are in.
const t = (key, vars) => window.TreasureI18n.t(key, vars);

// Settings the preview reacts to: a new fit needs another crop from the server;
// tuning and frame are applied right here (render.js, the same code as the phone).
const CROP_KEYS = ['fit'];
const LOCAL_KEYS = ['palette', 'frame', 'dither', 'brightness', 'contrast'];
// What "Reset to defaults" restores under Advanced color settings.
const COLOR_KEYS = ['palette', 'dither', 'brightness', 'contrast'];

function readState() {
  try {
    const raw = decodeURIComponent(location.hash.slice(1));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const state = readState();
// Migrated to this page's settings version (the phone may be older or newer).
const settings = window.TreasureSettings.load(state.settings);
// The double-flick box toggle was removed; treat older saved values as off.
if (settings.boxMode !== 'always') settings.boxMode = 'off';
const art = state.art || null;
const watch = state.watch || { w: 144, h: 168, round: 0 };
// "auto" is where the watch puts the time by default.
if (settings.textCol === 'auto') settings.textCol = watch.round ? 'center' : 'end';

// Looks saved per painting on the phone (looks.js): crop, frame, color tuning
// and time placement. A painting shown here gets its saved look back.
const savedLooks = state.looks || {};
let restoredLooks = null; // a restored backup's looks, written by the phone on save
let lookTouched = false;
// The painting on the watch keeps its own colors, zoom and position when it's
// shown again (Undo); others without a saved look start from the defaults.
const initialFresh = Object.fromEntries(window.TreasureLooks.FRESH.map((k) => [k, settings[k]]));
const freshDefaults = Object.fromEntries(window.TreasureLooks.FRESH.map((k) => [k, DEFAULTS[k]])); // the reader changed the look: the phone saves it with the painting
// A painting picked on this page; only hung on the watch when saved.
let chosen = null;
// The painting the label currently describes (for the viewer).
let shown = art;

const $ = (id) => document.getElementById(id);

// ---------------- preview ----------------

const scale = Math.max(1, Math.min(2, Math.floor((window.innerWidth - 64) / watch.w)));
const screenEl = $('screen');
screenEl.style.setProperty('--sw', `${watch.w * scale}px`);
screenEl.style.setProperty('--sh', `${watch.h * scale}px`);
screenEl.style.setProperty('--scale', String(scale));
screenEl.classList.toggle('round', Boolean(watch.round));
$('frame').classList.toggle('round', Boolean(watch.round));

const canvas = $('art');
canvas.width = watch.w;
canvas.height = watch.h;
// The crop on screen: full-color RGB from the server, before tuning and frame.
let crop = null;
// The painting catalog (the catalog/ folder next to this page); pictures come straight
// from the Rijksmuseum's IIIF server, so there is no server of our own.
const catalogReady = fetch('catalog/manifest.json')
  .then((res) => {
    if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
    return res.json();
  })
  .then((manifest) => {
    const cat = window.TreasureCatalog.create(manifest);
    // The paintings the phone knows (on the watch, pinned): no file needed.
    for (const row of Object.values(state.rows || {})) cat.addRow(row);
    return cat;
  });

/** Load one catalog file (a pool: 'featured', an era or 'undated') if needed. */
async function loadPool(cat, pool) {
  if (cat.has(pool)) return;
  const file = cat.fileFor(pool);
  if (!file) throw new Error(`no catalog file for ${pool}`);
  const res = await fetch(`catalog/${file}`);
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  if (!cat.add(await res.json())) throw new Error(t('error.catalogChanged'));
}
// The catalog once loaded (draw() needs it synchronously for Cover views).
let catalog = null;
catalogReady.then((cat) => {
  catalog = cat;
});

// ---------------- how the preview is shown ----------------
// A page-only preference (not a watch setting): show the watch's pixels as they
// look on a Pebble Time 2 screen indoors or in daylight (measured palettes).

const LIGHTS = ['room', 'sun'];

function savedPreviewLight() {
  try {
    const saved = localStorage.getItem('tt-preview-light');
    return LIGHTS.includes(saved) ? saved : 'room';
  } catch {
    return 'room';
  }
}

let previewLight = savedPreviewLight();

const miniScreen = $('mini-screen');
miniScreen.classList.toggle('round', Boolean(watch.round));

function savedMiniTime() {
  try {
    return localStorage.getItem('tt-mini-time') !== '0';
  } catch {
    return true;
  }
}

let miniTime = savedMiniTime();

function applyPreviewLight() {
  // The time is drawn in white on the watch: show the white this screen can show.
  const [r, g, b] = window.TreasureRender.toScreenRGBA(Uint8Array.of(0xff), 1, 1, 1, previewLight);
  screenEl.style.setProperty('--screen-white', `rgb(${r} ${g} ${b})`);
  miniScreen.style.setProperty('--screen-white', `rgb(${r} ${g} ${b})`);
  screenEl.classList.add('mip');
}

document.querySelectorAll('input[name=previewLight]').forEach((radio) => {
  radio.checked = radio.value === previewLight;
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    previewLight = radio.value;
    try {
      localStorage.setItem('tt-preview-light', previewLight);
    } catch {
      // Private mode: the choice just isn't remembered.
    }
    applyPreviewLight();
    draw();
  });
});
applyPreviewLight();

/** Draw the watch's pixels for the current crop, tuning and frame. */
function draw() {
  if (!crop) return;
  let rgb = crop.rgb;
  let w = crop.w;
  let h = crop.h;
  // Cover: cut the visible part out of the large copy, at screen size, and
  // tone it, like the phone does with the part it downloads.
  if (crop.kind === 'work' && catalog) {
    const v = catalog.coverView(crop.key, watch, settings);
    rgb = window.TreasureRender.tone(window.TreasureRender.cropRect(crop.rgb, crop.w, crop.h,
      { x: v.x * crop.w, y: v.y * crop.h, w: v.w * crop.w, h: v.h * crop.h }, watch.w, watch.h));
    w = watch.w;
    h = watch.h;
  }
  const bytes = window.TreasureRender.compose(rgb, w, h, {
    w: watch.w,
    h: watch.h,
    stride: watch.w,
    round: Boolean(watch.round),
    fit: settings.fit,
    frame: settings.frame,
    palette: settings.palette,
    dither: settings.dither,
    brightness: settings.brightness,
    contrast: settings.contrast,
  });
  const rgba = window.TreasureRender.toScreenRGBA(bytes, watch.w, watch.h, watch.w, previewLight);
  canvas.getContext('2d').putImageData(new ImageData(rgba, watch.w, watch.h), 0, 0);
  canvas.hidden = false;
  $('screen-empty').hidden = true;
  // The small preview pinned to the top shows the same pixels.
  const mini = $('mini-art');
  mini.width = watch.w;
  mini.height = watch.h;
  mini.getContext('2d').drawImage(canvas, 0, 0);
  hideLoader();
}

/** Load a crop image and read its pixels. */
function loadCrop(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
      const rgb = new Uint8Array(c.width * c.height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i];
        rgb[j + 1] = rgba[i + 1];
        rgb[j + 2] = rgba[i + 2];
      }
      resolve({ rgb, w: c.width, h: c.height });
    };
    img.onerror = () => reject(new Error(t('error.paintingLoad')));
    img.crossOrigin = 'anonymous'; // the IIIF server allows reading the pixels
    img.src = url;
  });
}

/** Show a painting: fetch its crop, then draw it with the current settings. */
async function showPainting(meta) {
  const cat = await catalogReady;
  catalog = cat;
  // Cover: the whole painting at twice the screen's size, to pan and zoom over.
  // Contain: the whole painting fitted inside the screen, toned once.
  const cover = settings.fit !== 'whole';
  const req = cover ? cat.workImage(meta.key, watch, 200) : cat.cropRequest(meta.key, watch, 'whole');
  if (!req) throw new Error(t('error.noPicture'));
  const loaded = await loadCrop(req.url);
  if (!cover) loaded.rgb = window.TreasureRender.tone(loaded.rgb);
  crop = { ...loaded, kind: cover ? 'work' : 'contain', key: meta.key };
  updateViewControls();
  canvas.setAttribute('aria-label', t('preview.ariaLabel', { title: meta.title || t('art.untitled'), artist: meta.artist || t('art.unknownArtist') }));
  draw();
  screenEl.classList.remove('loading');
}

// "Auto" follows the watch's clock setting, which the watch reports.
// Older watch builds don't send it, so fall back to this browser's locale.
function clockIs24h() {
  if (watch.is24h !== undefined) return Boolean(watch.is24h);
  return phoneUses24h();
}

function phoneUses24h() {
  const opts = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
  if (opts.hourCycle) return opts.hourCycle === 'h23' || opts.hourCycle === 'h24';
  return opts.hour12 === false;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function renderPreview() {
  const now = new Date();
  const use24 = settings.clockMode === '24' || (settings.clockMode === 'auto' && clockIs24h());
  let time;
  let ampm = '';
  if (use24) {
    time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  } else {
    time = `${now.getHours() % 12 || 12}:${pad(now.getMinutes())}`;
    if (!settings.hideAmPm) ampm = now.getHours() < 12 ? 'AM' : 'PM';
  }
  // Like the watch: only the M time font has AM/PM letters; S and L draw them
  // separately in the smaller date font.
  const ampmInline = settings.timeSize === 'm';
  if (ampm && ampmInline) time += ` ${ampm}`;
  const dd = pad(now.getDate());
  const mm = pad(now.getMonth() + 1);
  const sep = settings.dateSep;
  const dates = { dd, 'dd-mm': `${dd}${sep}${mm}`, 'mm-dd': `${mm}${sep}${dd}` };
  const date = dates[settings.dateFormat] || dates['dd-mm'];
  const anyText = settings.showTime || settings.showDate;
  // The pinned preview shows the time on request, as it looks after a shake.
  const overlays = [
    [$('overlay'), !anyText || settings.hideUntilShake],
    [$('mini-overlay'), !anyText || !miniTime],
  ];
  for (const [overlay, hidden] of overlays) {
    const timeEl = overlay.querySelector('.ov-time');
    const dateEl = overlay.querySelector('.ov-date');
    timeEl.textContent = settings.showTime ? time : '';
    if (settings.showTime && ampm && !ampmInline) {
      const suffix = document.createElement('span');
      suffix.className = 'ov-ampm';
      suffix.textContent = ampm;
      timeEl.append(suffix);
    }
    overlay.classList.toggle('size-s', settings.timeSize === 's');
    overlay.classList.toggle('size-l', settings.timeSize === 'l');
    dateEl.textContent = settings.showDate ? date : '';
    timeEl.hidden = !settings.showTime;
    dateEl.hidden = !settings.showDate;
    overlay.classList.toggle('hidden', hidden);
    overlay.classList.toggle('boxed', settings.boxMode === 'always');
    overlay.classList.toggle('outline', settings.boxMode !== 'always');
  }
  $('fmt-d').textContent = dates.dd;
  $('fmt-dm').textContent = dates['dd-mm'];
  $('fmt-md').textContent = dates['mm-dd'];
  placeOverlay($('overlay'), scale);
  placeOverlay($('mini-overlay'), Number(miniScreen.style.getPropertyValue('--scale')) || 0);
}

// Same placement as the watch (main.c text_update), in watch pixels.
function placeOverlay(overlay, px) {
  if (!px) return;
  const round = Boolean(watch.round);
  // With a painting frame, the text sits inside it, on the painting.
  const margin = (round ? 10 : 4) + window.TreasureRender.frameBorder(settings.frame, watch.w, watch.h);
  const edge = margin + (round ? 8 : 0);
  const pad = settings.boxMode === 'always' ? 3 : 0;
  const blockW = overlay.offsetWidth / px - 2 * pad;
  const blockH = overlay.offsetHeight / px - 2 * pad;
  const top = { top: edge, center: (watch.h - blockH) / 2 }[settings.textRow] ?? watch.h - edge - blockH;
  // Round screens only offer top or bottom, always centered.
  const col = round ? 'center' : settings.textCol;
  const left = col === 'start' ? margin : col === 'end' ? watch.w - margin - blockW : (watch.w - blockW) / 2;
  overlay.style.left = `${(left - pad) * px}px`;
  overlay.style.top = `${(top - pad) * px}px`;
  overlay.style.alignItems = { start: 'flex-start', end: 'flex-end' }[col] || 'center';
}

// ---------------- wall label ----------------

const dutch = window.TreasureI18n.lang === 'nl-NL';

function showLabel(meta) {
  $('label').hidden = false;
  $('art-title').textContent = meta.title || t('art.untitled');
  $('mini-title').textContent = meta.title || '';
  $('art-artist').textContent = meta.artist || t('art.unknownArtist');
  $('art-meta').textContent = [meta.date, meta.objectNumber].filter(Boolean).join(', ');
  // Credit line: source + license, linked to the license when we know it.
  const license = $('art-license');
  license.textContent = meta.license || t('art.publicDomain');
  if (meta.licenseUrl) {
    license.href = meta.licenseUrl;
  } else {
    license.removeAttribute('href');
  }
  $('art-web').href = meta.webUrl;
  shown = meta;
  $('explore').hidden = !iiifBaseOf(meta);
}

if (art) {
  showLabel(art);
}

// ---------------- live preview ----------------
// Paintings come from the catalog and their crops straight from the
// Rijksmuseum's IIIF server. Nothing reaches the watch until Save.

let requestId = 0;

function setStatus(text) {
  $('status').textContent = text;
}

/** The painting's saved look, or null. */
function savedLook(key) {
  const look = window.TreasureLooks.decode(savedLooks[key], settings);
  if (!look) return null;
  if (look.textCol === 'auto') look.textCol = watch.round ? 'center' : 'end';
  return look;
}

/** Put the settings on the page's controls after they changed in code. */
function syncControls() {
  document.querySelectorAll('.segmented[data-key] input[type=radio]').forEach((radio) => {
    radio.checked = radio.value === String(settings[radio.name]);
  });
  document.querySelectorAll('input.range[data-key]').forEach((input) => {
    input.value = settings[input.dataset.key];
    showRange(input);
  });
  document.querySelectorAll('input.switch[data-key]').forEach((input) => {
    input.checked = Boolean(settings[input.dataset.key]);
  });
  document.querySelectorAll('input.number[data-key]').forEach((input) => {
    input.value = settings[input.dataset.key];
    input.dispatchEvent(new Event('change'));
  });
  $('readability').checked = settings.boxMode === 'always';
}

const byKey = (key) => (cat) => cat.get(key);

/**
 * Show a painting picked from the catalog.
 * @param {function} choose catalog → painting (or null)
 */
async function loadPreview(choose, { pick = false, useLook = true } = {}) {
  const id = ++requestId;
  // Picking another painting can be undone: remember the one shown now.
  const before = pick && shown ? undoEntry() : null;
  screenEl.classList.add('loading');
  setStatus(pick ? t('status.hanging') : '');
  try {
    const cat = await catalogReady;
    const painting = await choose(cat);
    if (!painting) throw new Error(t('error.notInCatalog'));
    const meta = painting;
    if (id !== requestId) return null;
    const look = useLook ? savedLook(meta.key) : null;
    // Colors, zoom and position belong to one painting (looks.FRESH): without
    // a saved look, a painting starts from the defaults.
    if (!look && useLook) {
      Object.assign(settings, meta.key === art?.key ? initialFresh : freshDefaults);
      syncControls();
    }
    if (look) {
      const otherCrop = look.fit !== settings.fit;
      Object.assign(settings, look);
      syncControls();
      update();
      // Saved with the other crop: load that one instead.
      if (otherCrop) return loadPreview(byKey(meta.key), { pick, useLook: false });
    }
    if (pick) chosen = meta;
    await showPainting(meta);
    if (id !== requestId) return null;
    if (before && before.key !== meta.key) undoStack.push(before);
    showLabel(meta);
    const hint = chosen ? t('status.chosen') : '';
    setStatus(look ? `${hint} ${t('status.usingLook')}`.trim() : hint);
    updateShuffle();
    return meta;
  } catch (err) {
    if (id !== requestId) return null;
    screenEl.classList.remove('loading');
    setStatus(t('status.previewFailed', { error: err.message }));
    hideLoader();
    return null;
  }
}

function currentKey() {
  return (chosen || art)?.key;
}

/** Reload the shown painting, e.g. for another crop. `useLook` re-applies its saved look. */
function refreshPreview({ useLook = false } = {}) {
  const key = currentKey();
  if (key) loadPreview(byKey(key), { useLook });
}

// First paint: the painting on the watch (from the phone).
if (art?.key) {
  showPainting(art).catch((err) => {
    setStatus(t('status.previewFailed', { error: err.message }));
    hideLoader();
  });
}

/** Catalog rows by key, for the phone. */
function rowsFor(keys) {
  const rows = {};
  for (const key of keys) {
    const row = key && catalog?.row(key);
    if (row) rows[key] = row;
  }
  return rows;
}

// "Hang a different painting": any painting, or one from the chosen era.
const randomPick = async (cat) => {
  const pool = cat.poolFor(settings.selection === 'random' ? settings.era : 'any');
  await loadPool(cat, pool);
  return cat.random(pool);
};

function updateShuffle() {
  $('keep').hidden = $('mini-keep').hidden = undoStack.length === 0;
}

$('shuffle').addEventListener('click', () => loadPreview(randomPick, { pick: true }));

// Undo: each tap goes back one painting (as it looked then, and pinned or
// not), until the painting on the watch.
const undoStack = [];

function undoEntry() {
  const look = {};
  for (const k of [...window.TreasureLooks.KEYS, 'pinned']) look[k] = settings[k];
  return { key: shown.key, chosen, look };
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  chosen = entry.chosen;
  Object.assign(settings, entry.look);
  if (settings.pinned) showPinned(entry.chosen?.title || shown?.title || '');
  syncControls();
  update();
  updateShuffle();
  loadPreview(byKey(entry.key), { useLook: false });
}

$('keep').addEventListener('click', undo);
$('mini-keep').addEventListener('click', undo);

// ---------------- pin a painting ----------------

function showPinned(title) {
  $('pinned-title').textContent = title || t('pinned.defaultTitle');
}

/** Find a painting by object number, key or link, preview it and pin it. */
async function pinPainting(q) {
  $('pin-status').textContent = t('pin.lookingUp');
  const cat = await catalogReady;
  // Look among what's loaded first; otherwise load every era file (rare).
  let found = cat.resolve(q);
  if (!found) {
    $('pin-status').textContent = t('pin.searchingAll');
    await Promise.all(cat.files.map((f) => loadPool(cat, f.pool)));
    found = cat.resolve(q);
  }
  if (!found) throw new Error(t('pin.notFound'));
  const meta = await loadPreview(byKey(found.key), { pick: true });
  if (!meta) throw new Error(t('pin.loadFailed'));
  settings.pinned = meta.key;
  showPinned(meta.title);
  $('pin-status').textContent = t('pin.done', { title: meta.title || t('art.untitled') });
  update();
  return meta;
}

// ---------------- search by title (pinning) ----------------
// catalog/search.json (title, artist, date, object number and file of every
// painting) is only loaded once someone types in the pin field.

let searchReady = null;
const searchBox = $('pin-input');
const searchList = $('pin-results');
let searchHits = [];
let searchActive = -1;

/** Lower case without accents, so "Hals" finds "Hals" and "Vermeer" "vermeer". */
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function loadSearch() {
  searchReady ??= Promise.all([catalogReady, fetch('catalog/search.json').then((res) => {
    if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
    return res.json();
  })]).then(([cat, data]) => {
    if (data.id !== cat.id) throw new Error('the catalog changed; reopen the settings');
    return data.entries.map(([key, title, artist, date, objectNumber, pool]) => ({
      key, title, artist, date, objectNumber, pool,
      text: fold(`${title} ${artist} ${objectNumber || ''} ${date || ''}`),
      titleText: fold(title),
    }));
  });
  searchReady.catch(() => {
    searchReady = null; // try again next time
  });
  return searchReady;
}

/** Up to 8 paintings matching every word; titles that start with it first. */
function searchEntries(entries, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hits = entries.filter((e) => words.every((w) => e.text.includes(w)));
  const rank = (e) => (e.titleText.startsWith(words[0]) ? 0 : e.titleText.includes(words[0]) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)).slice(0, 8);
}

function showResults(items, note) {
  searchList.replaceChildren();
  searchHits = items;
  searchActive = -1;
  items.forEach((e, i) => {
    const li = document.createElement('li');
    li.id = `pin-result-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    const title = document.createElement('span');
    title.className = 'pin-result-title';
    title.textContent = e.title;
    const meta = document.createElement('span');
    meta.className = 'pin-result-meta';
    meta.textContent = [e.artist, e.date, e.objectNumber].filter(Boolean).join(' · ');
    li.append(title, meta);
    // pointerdown, not click: picking must win over the field losing focus.
    li.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      pickResult(e);
    });
    searchList.append(li);
  });
  if (note) {
    const li = document.createElement('li');
    li.className = 'pin-result-note';
    li.textContent = note;
    searchList.append(li);
  }
  const open = items.length > 0 || Boolean(note);
  searchList.hidden = !open;
  searchBox.setAttribute('aria-expanded', String(open));
  searchBox.removeAttribute('aria-activedescendant');
}

function hideResults() {
  showResults([], '');
}

function highlight(i) {
  searchActive = i;
  searchList.querySelectorAll('[role=option]').forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
  if (i >= 0) {
    searchBox.setAttribute('aria-activedescendant', `pin-result-${i}`);
    $(`pin-result-${i}`).scrollIntoView({ block: 'nearest' });
  }
}

async function pickResult(entry) {
  hideResults();
  searchBox.value = entry.title;
  try {
    // Only the painting's own file is needed to pin it.
    await loadPool(await catalogReady, entry.pool);
    await pinPainting(entry.key);
  } catch (err) {
    $('pin-status').textContent = err.message;
  }
}

let searchTimer = null;
searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = searchBox.value.trim();
  if (query.length < 2) {
    hideResults();
    return;
  }
  searchTimer = setTimeout(async () => {
    if (!searchReady) showResults([], t('pin.searchLoading'));
    try {
      const entries = await loadSearch();
      if (searchBox.value.trim() !== query) return; // typed on meanwhile
      const hits = searchEntries(entries, query);
      showResults(hits, hits.length ? '' : t('pin.searchNone', { query }));
    } catch {
      showResults([], t('pin.searchFailed'));
    }
  }, 150);
});

searchBox.addEventListener('keydown', (e) => {
  if (searchList.hidden || !searchHits.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    highlight((searchActive + step + searchHits.length) % searchHits.length);
  } else if (e.key === 'Enter' && searchActive >= 0) {
    e.preventDefault();
    pickResult(searchHits[searchActive]);
  } else if (e.key === 'Escape') {
    hideResults();
  }
});
searchBox.addEventListener('blur', () => setTimeout(hideResults, 150));

$('pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchBox.value.trim();
  if (!q) return;
  // A title typed in full (or the only suggestion): pin that painting.
  if (searchHits.length && (searchActive >= 0 || searchHits.length === 1)) {
    pickResult(searchHits[Math.max(searchActive, 0)]);
    return;
  }
  hideResults();
  try {
    await pinPainting(q);
  } catch (err) {
    $('pin-status').textContent = err.message;
  }
});

if (settings.pinned) {
  showPinned(art && art.key === settings.pinned ? art.title : '');
}

// The phone couldn't fetch the pinned painting any more (removed from the
// catalog, or its image from the Rijksmuseum). It doesn't keep trying.
const gone = state.unavailable;
if (gone && gone.key === settings.pinned) {
  const vars = { hasTitle: gone.title ? 'yes' : 'no', title: gone.title || '' };
  $('pinned-gone').hidden = false;
  $('pinned-gone').textContent = t(gone.usingCopy ? 'pinned.goneCopy' : 'pinned.goneKeep', vars);
}

$('unpin').addEventListener('click', () => {
  settings.pinned = '';
  $('pin-status').textContent = '';
  setStatus(t('pinned.unpinned'));
  update();
});

// ---------------- explore (deep zoom) ----------------
// The Rijksmuseum's IIIF image server allows cross-origin requests, so
// OpenSeadragon can stream the full-resolution tiles straight from it.

// OpenSeadragon 4.1.0, self-hosted (vendor/, BSD-3-Clause; see NOTICE.md).
const OSD = 'vendor/openseadragon-4.1.0.min.js';
let osdLoading = null;
let viewer = null;

function iiifBaseOf(meta) {
  if (!meta) return null;
  if (meta.iiifBase) return meta.iiifBase;
  // Older cached paintings only have the full-image URL.
  const m = /^(https:\/\/[^?#]+?)\/full\//.exec(meta.imageUrl || '');
  return m ? m[1] : null;
}

function loadOpenSeadragon() {
  osdLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = OSD;
    script.onload = resolve;
    script.onerror = () => reject(new Error(t('viewer.loadError')));
    document.head.append(script);
  });
  return osdLoading;
}

$('explore').addEventListener('click', async () => {
  const base = iiifBaseOf(shown);
  if (!base) return;
  $('viewer-title').textContent = `${shown.title || t('art.untitled')} · ${shown.artist || ''}`;
  $('viewer-hint').textContent = t('viewer.loading');
  $('viewer').showModal();
  try {
    await loadOpenSeadragon();
    viewer?.destroy();
    viewer = window.OpenSeadragon({
      element: $('viewer-canvas'),
      tileSources: `${base}/info.json`,
      crossOriginPolicy: 'Anonymous',
      showNavigationControl: false,
      showNavigator: true,
      navigatorPosition: 'BOTTOM_RIGHT',
      navigatorAutoFade: false,
      visibilityRatio: 1,
      // Never smaller than the whole painting fitting the screen.
      minZoomImageRatio: 1,
      constrainDuringPan: true,
      maxZoomPixelRatio: 2,
      gestureSettingsTouch: { pinchRotate: false },
    });
    $('viewer-hint').textContent = t('viewer.hint');
  } catch (err) {
    $('viewer-hint').textContent = t('viewer.failed', { error: err.message });
  }
});

$('viewer-zoom-in').addEventListener('click', () => viewer?.viewport.zoomBy(1.6));
$('viewer-zoom-out').addEventListener('click', () => {
  viewer?.viewport.zoomBy(1 / 1.6);
  viewer?.viewport.applyConstraints();
});
$('zoom-home').addEventListener('click', () => viewer?.viewport.goHome());
$('viewer-close').addEventListener('click', () => $('viewer').close());
$('viewer').addEventListener('close', () => {
  viewer?.destroy();
  viewer = null;
});

// ---------------- support the museum ----------------

// Dutch visitors get the Dutch donation page.
if (dutch) {
  $('donate-link').href = 'https://www.rijksmuseum.nl/nl/steun/doneer';
}

// ---------------- controls ----------------

function conditions() {
  return {
    showTime: settings.showTime,
    showDate: settings.showDate,
    coverView: settings.fit !== 'whole' && Boolean(crop),
    ampm: settings.showTime && (settings.clockMode === '12' || (settings.clockMode === 'auto' && !clockIs24h())),
    anyText: settings.showTime || settings.showDate,
    textColumn: (settings.showTime || settings.showDate) && !watch.round,
    hideUntilShake: settings.hideUntilShake,
    revealMinutes: (settings.showTime || settings.showDate) && settings.hideUntilShake,
    dateSeparator: settings.showDate && settings.dateFormat !== 'dd',
    pinned: Boolean(settings.pinned),
    notPinned: !settings.pinned,
    randomSelection: !settings.pinned && settings.selection === 'random',
  };
}

function applyVisibility() {
  const c = conditions();
  document.querySelectorAll('[data-show-if]').forEach((el) => {
    el.hidden = !c[el.dataset.showIf];
  });
}

document.querySelectorAll('input.switch[data-key]').forEach((input) => {
  const key = input.dataset.key;
  input.checked = Boolean(settings[key]);
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    update();
  });
});

function clampMinutes(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : 1;
}

document.querySelectorAll('input.number[data-key]').forEach((input) => {
  const key = input.dataset.key;
  settings[key] = clampMinutes(settings[key]);
  const show = () => {
    input.value = settings[key];
    $('minutes-unit').textContent = t('showFor.unit', { count: settings[key] });
  };
  show();
  // Accept typing freely; tidy the value up when the field is left.
  input.addEventListener('input', () => {
    if (input.value !== '') settings[key] = clampMinutes(input.value);
    $('minutes-unit').textContent = t('showFor.unit', { count: settings[key] });
  });
  input.addEventListener('change', show);
});

document.querySelectorAll('.segmented[data-key]').forEach((group) => {
  const key = group.dataset.key;
  group.querySelectorAll('input[type=radio]').forEach((radio) => {
    radio.checked = radio.value === String(settings[key]);
    radio.addEventListener('change', () => {
      if (radio.checked) {
        settings[key] = radio.value;
        if (window.TreasureLooks.KEYS.includes(key)) lookTouched = true;
        update();
        if (CROP_KEYS.includes(key)) refreshPreview();
        if (LOCAL_KEYS.includes(key)) draw();
        // Collection, era and rotation only change the painting on the next swap.
      }
    });
  });
});

// "Improve readability" is the readability box, shown as an on/off switch.
const readability = $('readability');
readability.checked = settings.boxMode === 'always';
readability.addEventListener('change', () => {
  settings.boxMode = readability.checked ? 'always' : 'off';
  update();
});

// Brightness and contrast sliders: redraw as they move.
function showRange(input) {
  const key = input.dataset.key;
  const v = settings[key];
  $(`${key}-out`).textContent = key === 'zoom' ? `${v}%` : v > 0 ? `+${v}` : String(v);
}

document.querySelectorAll('input.range[data-key]').forEach((input) => {
  const key = input.dataset.key;
  settings[key] = Number(settings[key]) || 0;
  input.value = settings[key];
  showRange(input);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    lookTouched = true;
    showRange(input);
    draw();
  });
});

$('color-reset').addEventListener('click', () => {
  for (const key of COLOR_KEYS) settings[key] = DEFAULTS[key];
  lookTouched = true;
  document.querySelectorAll('input[name=palette], input[name=dither]').forEach((r) => {
    r.checked = r.value === settings[r.name];
  });
  document.querySelectorAll('input.range[data-key]').forEach((input) => {
    input.value = settings[input.dataset.key];
    showRange(input);
  });
  draw();
});

// ---------------- Cover zoom and position ----------------
// Cover shows part of the painting. The reader can zoom in (100-200 %) and
// move the view anywhere (drag the preview, or the arrow buttons). Saved per
// painting as zoom + focusX/focusY (view center, 0-10000, fine enough for a pixel on a panorama; null = smart crop).

/** The view now, clamped by the catalog (null outside Cover). */
function currentView() {
  return catalog && crop?.kind === 'work' ? catalog.coverView(crop.key, watch, settings) : null;
}

function updateViewControls() {
  const v = currentView();
  const freeX = Boolean(v && v.w < 0.999);
  const freeY = Boolean(v && v.h < 0.999);
  $('view-hint').textContent = freeX && freeY
    ? t('view.hint.both')
    : freeX ? t('view.hint.x')
      : freeY ? t('view.hint.y')
        : t('view.hint.none');
  document.querySelectorAll('[data-nudge]').forEach((b) => {
    const sideways = b.dataset.nudge.split(',')[0] !== '0';
    b.disabled = !(sideways ? freeX : freeY);
  });
  for (const el of [canvas, $('mini-art')]) {
    el.classList.toggle('draggable', freeX || freeY);
    // Let the page scroll along any axis the painting can't move on.
    el.style.touchAction = freeX && freeY ? 'none' : freeX ? 'pan-y' : freeY ? 'pan-x' : '';
  }
  applyVisibility();
}

/** Move the view so its center is at (cx, cy) (fractions), clamped. */
function setFocus(cx, cy) {
  if (!catalog || crop?.kind !== 'work') return;
  const v = catalog.coverView(crop.key, watch, { zoom: settings.zoom, focusX: cx * 10000, focusY: cy * 10000 });
  const focusX = Math.round(v.cx * 10000);
  const focusY = Math.round(v.cy * 10000);
  if (focusX === settings.focusX && focusY === settings.focusY) return;
  settings.focusX = focusX;
  settings.focusY = focusY;
  lookTouched = true;
  draw();
}

// Dragging moves the painting with the finger, i.e. the view the other way.
for (const el of [canvas, $('mini-art')]) {
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const v = currentView();
    if (!v || !el.classList.contains('draggable')) return;
    drag = { x: e.clientX, y: e.clientY, v, perPx: watch.w / el.clientWidth };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) * drag.perPx; // watch pixels
    const dy = (e.clientY - drag.y) * drag.perPx;
    setFocus(drag.v.cx - (dx / watch.w) * drag.v.w, drag.v.cy - (dy / watch.h) * drag.v.h);
  });
  const end = () => {
    drag = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// Arrow buttons: move by NUDGE_PX watch pixels per tap, for precise
// positioning; holding one repeats (dragging is quicker for long moves).
const NUDGE_PX = 2;
document.querySelectorAll('[data-nudge]').forEach((b) => {
  const [dx, dy] = b.dataset.nudge.split(',').map(Number);
  const nudge = () => {
    const v = currentView();
    if (!v) return;
    setFocus(v.cx + dx * v.w * (NUDGE_PX / watch.w), v.cy + dy * v.h * (NUDGE_PX / watch.h));
  };
  let repeat = null;
  const stop = () => {
    clearTimeout(repeat);
    repeat = null;
  };
  b.addEventListener('pointerdown', (e) => {
    if (b.disabled) return;
    e.preventDefault();
    nudge();
    const again = (delay) => {
      repeat = setTimeout(() => {
        nudge();
        again(60);
      }, delay);
    };
    again(400);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(type, stop);
  // Keyboard (Enter/Space) still clicks; pointer presses are handled above.
  b.addEventListener('click', (e) => {
    if (e.detail === 0) nudge();
  });
});

$('view-reset').addEventListener('click', () => {
  Object.assign(settings, { zoom: 100, focusX: null, focusY: null });
  lookTouched = true;
  syncControls();
  updateViewControls();
  draw();
});

// Zooming keeps the current center (the catalog clamps it into the painting).
$('zoom').addEventListener('input', () => {
  const v = currentView();
  if (v && settings.focusX === null) {
    settings.focusX = Math.round(v.cx * 10000);
    settings.focusY = Math.round(v.cy * 10000);
  }
  updateViewControls();
});

// ---------------- backup ----------------
// Settings and saved looks live only on the phone; a backup is that data as
// JSON text (docs/schema/backup.schema.json) that the reader keeps somewhere.

function backupText() {
  return JSON.stringify({
    backup: 1,
    settings: window.TreasureSettings.toStored(settings),
    looks: window.TreasureLooks.toStored(savedLooks),
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard API (plain http): fall back to selecting a text field.
    const field = $('backup-input');
    field.closest('details').open = true;
    field.value = text;
    field.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

$('backup-copy').addEventListener('click', async () => {
  const count = Object.keys(savedLooks).length;
  $('backup-status').textContent = (await copyText(backupText()))
    ? t('backup.copied', { count })
    : t('backup.copyFailed');
});

$('backup-restore').addEventListener('click', () => {
  const status = $('restore-status');
  let backup;
  try {
    backup = JSON.parse($('backup-input').value);
  } catch {
    status.textContent = t('restore.notJson');
    return;
  }
  if (!backup || backup.backup !== 1 || typeof backup.settings !== 'object') {
    status.textContent = t('restore.notBackup');
    return;
  }
  Object.assign(settings, window.TreasureSettings.load(backup.settings));
  if (settings.textCol === 'auto') settings.textCol = watch.round ? 'center' : 'end';
  const looks = window.TreasureLooks.fromStored(backup.looks);
  for (const key of Object.keys(savedLooks)) delete savedLooks[key];
  Object.assign(savedLooks, looks);
  restoredLooks = window.TreasureLooks.toStored(looks);
  syncControls();
  update();
  refreshPreview();
  const count = Object.keys(looks).length;
  status.textContent = t('restore.done', { count });
});

// ---------------- loader + sticky mini preview ----------------

let loaderTimer = setTimeout(hideLoader, 8000); // never block the page for long
// Nothing to load yet (first set-up, before the watch has a painting).
if (!art?.key) setTimeout(hideLoader, 0);

function hideLoader() {
  if (!loaderTimer) return;
  clearTimeout(loaderTimer);
  loaderTimer = null;
  $('loader').classList.add('done');
}

// The pinned preview can be made larger (about half the screen) for tuning;
// it also always offers a new painting.
$('mini-size').addEventListener('click', (e) => {
  const large = $('mini').classList.toggle('large');
  e.currentTarget.setAttribute('aria-pressed', String(large));
  e.currentTarget.querySelector('span').textContent = large ? t('mini.shrink') : t('mini.expand');
});
$('mini-time').addEventListener('click', () => {
  miniTime = !miniTime;
  try {
    localStorage.setItem('tt-mini-time', miniTime ? '1' : '0');
  } catch {
    // Private mode: the choice just isn't remembered.
  }
  showMiniTime();
});

function showMiniTime() {
  $('mini-time').setAttribute('aria-pressed', String(miniTime));
  renderPreview();
}

// The overlay is sized in watch pixels, so follow the pinned preview's size.
new ResizeObserver(() => {
  const height = $('mini-art').clientHeight;
  if (!height) return;
  miniScreen.style.setProperty('--scale', String(height / watch.h));
  renderPreview();
}).observe($('mini-art'));
$('mini-shuffle').addEventListener('click', () => loadPreview(randomPick, { pick: true }));

// Pin a small preview to the top once half of the big one has scrolled away.
new IntersectionObserver(
  ([entry]) => {
    const scrolledPast = entry.intersectionRatio < 0.5 && entry.boundingClientRect.top < 0;
    $('mini').classList.toggle('shown', scrolledPast && !canvas.hidden);
  },
  { threshold: [0, 0.25, 0.5, 0.75, 1] },
).observe($('frame'));

function update() {
  applyVisibility();
  renderPreview();
}

update();
showMiniTime();
setInterval(renderPreview, 30_000);
// The overlay is placed by its measured size, which changes once fonts load.
document.fonts?.ready.then(renderPreview);

// ---------------- save ----------------

function returnTo() {
  const match = /[?&]return_to=([^&]+)/.exec(location.search);
  return match ? decodeURIComponent(match[1]) : 'pebblejs://close#';
}

/** Hand the result to the phone; the page closes. */
function sendToPhone(result) {
  document.location = returnTo() + encodeURIComponent(JSON.stringify(result));
}

function saveToWatch() {
  sendToPhone({
    version: window.TreasureSettings.VERSION,
    settings,
    artKey: chosen ? chosen.key : null,
    // Catalog rows for the painting to hang and the pinned one, so the phone
    // can fetch them without loading their catalog file.
    rows: rowsFor([chosen?.key, settings.pinned]),
    saveLook: lookTouched,
    // From a restored backup: replaces every saved look ({version, looks}).
    looks: restoredLooks || undefined,
  });
}

$('save').addEventListener('click', saveToWatch);

// ---------------- debug (?debug=true) ----------------
// A dev build (DEBUG: true in the phone's config.js) opens the page with
// ?debug=true. The pane shows the phone's state and runs actions on the phone:
// the page closes with { debug: action } and the phone does it (runDebug).

if (new URLSearchParams(location.search).get('debug') === 'true') {
  const pane = $('debug');
  pane.hidden = false;
  const show = (info) => {
    $('debug-info').textContent = JSON.stringify(info, null, 2);
  };
  const info = {
    phone: state.debug || t('debug.noPhone'),
    page: { watch, settings, pinned: settings.pinned || null, painting: art?.key || null },
  };
  show(info);
  catalogReady.then((cat) => {
    info.page.catalogId = cat.id;
    info.page.catalogFiles = cat.files.map((f) => `${f.pool} ${f.count}${cat.has(f.pool) ? ' (loaded)' : ''}`);
    show(info);
  }).catch((err) => {
    info.page.catalog = String(err.message || err);
    show(info);
  });

  const status = (text) => {
    $('debug-status').textContent = text;
  };
  pane.querySelectorAll('[data-debug]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.debug;
      if (action === 'reset' && !window.confirm(t('debug.confirmReset'))) return;
      sendToPhone({ debug: action });
    });
  });
  $('debug-milkmaid').addEventListener('click', async () => {
    try {
      status(t('debug.pinning'));
      await pinPainting('SK-A-2344');
      saveToWatch();
    } catch (err) {
      status(err.message);
    }
  });
  $('debug-page-storage').addEventListener('click', () => {
    try {
      localStorage.clear();
      status(t('debug.pageStorageCleared'));
    } catch (err) {
      status(String(err.message || err));
    }
  });
  $('debug-copy').addEventListener('click', async () => {
    status((await copyText(JSON.stringify(info, null, 2))) ? t('debug.copied') : t('debug.copyFailed'));
  });
}
