// Treasure Trove settings page.
// Opened by the phone app with the current state in the URL hash, and closed by
// navigating to `return_to` (emulator) or `pebblejs://close#` with the result.

const DEFAULTS = window.TreasureSettings.DEFAULTS;

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
const initialShift = settings.shift; // the reader changed the look: the phone saves it with the painting
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
// What the Cover crop on screen lets the reader shift (see coverWindow in render.js).
let shiftRange = { axis: null, min: 0, max: 0 };

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
  const bytes = window.TreasureRender.compose(crop.rgb, crop.w, crop.h, {
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
    windowX: crop.windowX,
    windowY: crop.windowY,
    shift: settings.shift,
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
    img.onerror = () => reject(new Error('could not load the painting'));
    img.src = url;
  });
}

/** Show a painting: fetch its crop, then draw it with the current settings. */
async function showPainting(meta) {
  crop = await loadCrop(meta.cropUrl);
  // Where the planned window sits in a Cover crop with slack (from the server,
  // or from the phone's cache for the painting on the watch).
  crop.windowX = meta.render?.windowX ?? meta.windowX ?? 0;
  crop.windowY = meta.render?.windowY ?? meta.windowY ?? 0;
  updateShiftRange();
  canvas.setAttribute('aria-label', `${meta.title} by ${meta.artist}, as shown on the watch`);
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

const dutch = (navigator.language || '').toLowerCase().startsWith('nl');

function showLabel(meta) {
  $('label').hidden = false;
  $('art-title').textContent = meta.title || 'Untitled';
  $('mini-title').textContent = meta.title || '';
  $('art-artist').textContent = meta.artist || 'Unknown artist';
  $('art-meta').textContent = [meta.date, meta.objectNumber].filter(Boolean).join(', ');
  // Credit line: source + license, linked to the license when we know it.
  const license = $('art-license');
  license.textContent = meta.license || 'Public domain';
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

// ---------------- live preview from the server ----------------
// This page is served by the Treasure Trove server, so it can ask for renders
// directly. Nothing reaches the watch until Save.

function screenQuery() {
  return new URLSearchParams({
    w: watch.w,
    h: watch.h,
    round: watch.round ? 1 : 0,
    fit: settings.fit,
    era: settings.era,
  }).toString();
}

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

async function loadPreview(path, { pick = false, extra = '', useLook = true } = {}) {
  const id = ++requestId;
  screenEl.classList.add('loading');
  setStatus(pick ? 'Hanging a new painting…' : '');
  try {
    const res = await fetch(`${path}?${screenQuery()}${extra}`);
    const meta = await res.json();
    if (!res.ok) throw new Error(meta.error || `HTTP ${res.status}`);
    if (id !== requestId) return null;
    const look = useLook ? savedLook(meta.key) : null;
    // The shift belongs to one painting: others start at their planned view.
    if (!look && useLook) settings.shift = meta.key === art?.key ? initialShift : 0;
    if (look) {
      const otherCrop = look.fit !== settings.fit;
      Object.assign(settings, look);
      syncControls();
      update();
      // Saved with the other crop: load that one instead.
      if (otherCrop) return loadPreview(`/api/art/${encodeURIComponent(meta.key)}`, { pick, useLook: false });
    }
    if (pick) chosen = meta;
    await showPainting(meta);
    if (id !== requestId) return null;
    showLabel(meta);
    const hint = chosen ? 'Preview: this painting is hung when you save.' : '';
    setStatus(look ? `${hint} Using the look you saved for it.`.trim() : hint);
    updateShuffle();
    return meta;
  } catch (err) {
    if (id !== requestId) return null;
    screenEl.classList.remove('loading');
    setStatus(`Couldn’t load a preview (${err.message}).`);
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
  if (key) loadPreview(`/api/art/${encodeURIComponent(key)}`, { useLook });
}

// First paint: the phone passes the cached painting's crop URL. Older phone
// code only had a preview image, so ask the server for the crop instead.
if (art?.cropUrl) {
  showPainting(art).catch((err) => {
    setStatus(`Couldn’t load a preview (${err.message}).`);
    hideLoader();
  });
} else if (art?.key) {
  refreshPreview();
}

function updateShuffle() {
  $('keep').hidden = $('mini-keep').hidden = !(chosen && art);
}

$('shuffle').addEventListener('click', () => loadPreview('/api/art/random', { pick: true }));

// Back to the painting the watch shows now, after swapping a few times.
function restoreOriginal() {
  chosen = null;
  updateShuffle();
  refreshPreview({ useLook: true });
}

$('keep').addEventListener('click', restoreOriginal);
$('mini-keep').addEventListener('click', restoreOriginal);

// ---------------- pin a painting ----------------

function showPinned(title) {
  $('pinned-title').textContent = title || 'this painting';
}

$('pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('pin-input').value.trim();
  if (!q) return;
  $('pin-status').textContent = 'Looking it up…';
  try {
    const res = await fetch(`/api/art/resolve?q=${encodeURIComponent(q)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const meta = await loadPreview(`/api/art/${encodeURIComponent(body.key)}`, { pick: true });
    if (!meta) throw new Error('could not load it');
    settings.pinned = meta.key;
    showPinned(meta.title);
    $('pin-status').textContent = `Pinned “${meta.title}”. Save to hang it.`;
    update();
  } catch (err) {
    $('pin-status').textContent = err.message;
  }
});

if (settings.pinned) {
  showPinned(art && art.key === settings.pinned ? art.title : '');
}

$('unpin').addEventListener('click', () => {
  settings.pinned = '';
  $('pin-status').textContent = '';
  setStatus('Unpinned: rotation continues after you save.');
  update();
});

// ---------------- explore (deep zoom) ----------------
// The Rijksmuseum's IIIF image server allows cross-origin requests, so
// OpenSeadragon can stream the full-resolution tiles straight from it.

const OSD = 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/';
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
    script.src = `${OSD}openseadragon.min.js`;
    script.onload = resolve;
    script.onerror = () => reject(new Error('could not load the viewer'));
    document.head.append(script);
  });
  return osdLoading;
}

$('explore').addEventListener('click', async () => {
  const base = iiifBaseOf(shown);
  if (!base) return;
  $('viewer-title').textContent = `${shown.title || 'Untitled'} · ${shown.artist || ''}`;
  $('viewer-hint').textContent = 'Loading…';
  $('viewer').showModal();
  try {
    await loadOpenSeadragon();
    viewer?.destroy();
    viewer = window.OpenSeadragon({
      element: $('viewer-canvas'),
      prefixUrl: `${OSD}images/`,
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
    $('viewer-hint').textContent = 'Pinch or scroll to zoom, drag to move. The map in the corner shows where you are.';
  } catch (err) {
    $('viewer-hint').textContent = `Couldn’t open the viewer (${err.message}).`;
  }
});

$('zoom-in').addEventListener('click', () => viewer?.viewport.zoomBy(1.6));
$('zoom-out').addEventListener('click', () => {
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
  $('donate-link').textContent = 'Doneer';
}

// ---------------- controls ----------------

function conditions() {
  return {
    showTime: settings.showTime,
    showDate: settings.showDate,
    coverShift: Boolean(shiftRange.axis),
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
    $('minutes-unit').textContent = settings[key] === 1 ? 'minute' : 'minutes';
  };
  show();
  // Accept typing freely; tidy the value up when the field is left.
  input.addEventListener('input', () => {
    if (input.value !== '') settings[key] = clampMinutes(input.value);
    $('minutes-unit').textContent = settings[key] === 1 ? 'minute' : 'minutes';
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
  $(`${input.dataset.key}-out`).textContent = settings[input.dataset.key] > 0
    ? `+${settings[input.dataset.key]}` : String(settings[input.dataset.key]);
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

// ---------------- Cover position (shift) ----------------
// Cover crops keep up to 20 watch pixels of extra painting on one axis; the
// reader can slide the window there (slider, or drag the preview).


function updateShiftRange() {
  if (!crop || settings.fit !== 'fill') {
    shiftRange = { axis: null, min: 0, max: 0 };
  } else {
    shiftRange = window.TreasureRender.coverWindow(crop.w, crop.h, watch.w, watch.h,
      crop.windowX, crop.windowY, 0);
  }
  const input = $('shift');
  input.min = shiftRange.min;
  input.max = shiftRange.max;
  if (shiftRange.axis) settings.shift = Math.min(Math.max(settings.shift, shiftRange.min), shiftRange.max);
  input.value = settings.shift;
  showRange(input);
  $('shift-hint').textContent = shiftRange.axis === 'y'
    ? 'Drag the preview up or down, or slide, to move the painting a little.'
    : 'Drag the preview sideways, or slide, to move the painting a little.';
  for (const el of [canvas, $('mini-art')]) {
    el.classList.toggle('draggable', Boolean(shiftRange.axis));
    el.style.touchAction = shiftRange.axis === 'x' ? 'pan-y' : shiftRange.axis === 'y' ? 'pan-x' : '';
  }
  applyVisibility();
}

function setShift(value) {
  const next = Math.round(Math.min(Math.max(value, shiftRange.min), shiftRange.max));
  if (next === settings.shift) return;
  settings.shift = next;
  lookTouched = true;
  $('shift').value = next;
  showRange($('shift'));
  draw();
}

// Dragging moves the painting with the finger, i.e. the window the other way.
for (const el of [canvas, $('mini-art')]) {
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (!shiftRange.axis) return;
    drag = { x: e.clientX, y: e.clientY, shift: settings.shift, perPx: watch.w / el.clientWidth };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const moved = shiftRange.axis === 'x' ? e.clientX - drag.x : e.clientY - drag.y;
    setShift(drag.shift - moved * drag.perPx);
  });
  const end = () => {
    drag = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

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
  const what = `Your settings and ${count} saved ${count === 1 ? 'look' : 'looks'}`;
  $('backup-status').textContent = (await copyText(backupText()))
    ? `${what} are copied. Paste them into a note or an email to yourself.`
    : 'Couldn’t copy automatically: the backup is in the box below. Select it all and copy it.';
});

$('backup-restore').addEventListener('click', () => {
  const status = $('restore-status');
  let backup;
  try {
    backup = JSON.parse($('backup-input').value);
  } catch {
    status.textContent = 'That isn’t a backup: paste the whole text you copied.';
    return;
  }
  if (!backup || backup.backup !== 1 || typeof backup.settings !== 'object') {
    status.textContent = 'That isn’t a Treasure Trove backup.';
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
  status.textContent = `Restored your settings and ${count} saved ${count === 1 ? 'look' : 'looks'}. Save to your watch to keep them.`;
});

// ---------------- loader + sticky mini preview ----------------

let loaderTimer = setTimeout(hideLoader, 8000); // never block the page for long
// Nothing to load yet (first set-up, before the watch has a painting).
if (!art?.cropUrl && !art?.key) setTimeout(hideLoader, 0);

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
  e.currentTarget.querySelector('span').textContent = large ? 'Shrink' : 'Expand';
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
$('mini-shuffle').addEventListener('click', () => loadPreview('/api/art/random', { pick: true }));

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

$('save').addEventListener('click', () => {
  const result = {
    version: window.TreasureSettings.VERSION,
    settings,
    artKey: chosen ? chosen.key : null,
    saveLook: lookTouched,
    // From a restored backup: replaces every saved look ({version, looks}).
    looks: restoredLooks || undefined,
  };
  document.location = returnTo() + encodeURIComponent(JSON.stringify(result));
});
