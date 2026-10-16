// Treasure Trove settings page.
// Opened by the phone app with the current state in the URL hash, and closed by
// navigating to `return_to` (emulator) or `pebblejs://close#` with the result.

const DEFAULTS = {
  showTime: true,
  clockMode: 'auto',
  hideAmPm: false,
  showDate: true,
  dateFormat: 'dd-mm',
  hideUntilShake: false,
  revealMinutes: 1,
  boxMode: 'off',
  fit: 'fill',
  palette: 'defined',
  frame: 'none',
  selection: 'featured',
  era: 'any',
  rotation: 'daily',
  pinned: '',
};

// Settings that change the rendered pixels, so the preview is re-rendered live.
const RENDER_KEYS = ['fit', 'palette', 'frame'];

function readState() {
  try {
    const raw = decodeURIComponent(location.hash.slice(1));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const state = readState();
const settings = { ...DEFAULTS, ...(state.settings || {}) };
// The double-flick box toggle was removed; treat older saved values as off.
if (settings.boxMode !== 'always') settings.boxMode = 'off';
const art = state.art || null;
const watch = state.watch || { w: 144, h: 168, round: 0 };
// A painting picked on this page; only hung on the watch when saved.
let chosen = null;
// The painting the label currently describes (for the viewer).
let shown = art;

// Featured day per rotation, computed by the phone (rotation.js). Older phone
// code doesn't send it: fall back to today's day of the year.
function dayOfYear(d) {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86400000);
}
const featuredDay = state.featuredDay || { daily: dayOfYear(new Date()), off: dayOfYear(new Date()) };

const $ = (id) => document.getElementById(id);

// ---------------- preview ----------------

const scale = Math.max(1, Math.min(2, Math.floor((window.innerWidth - 64) / watch.w)));
const screenEl = $('screen');
screenEl.style.setProperty('--sw', `${watch.w * scale}px`);
screenEl.style.setProperty('--sh', `${watch.h * scale}px`);
screenEl.style.setProperty('--scale', String(scale));
screenEl.classList.toggle('round', Boolean(watch.round));

const img = $('art');

function showImage(src, meta) {
  img.src = src;
  img.alt = `${meta.title} by ${meta.artist}, as shown on the watch`;
  img.hidden = false;
  $('screen-empty').hidden = true;
}

img.addEventListener('load', () => screenEl.classList.remove('loading'));
img.addEventListener('error', () => screenEl.classList.remove('loading'));

if (art && art.previewUrl) {
  showImage(art.previewUrl, art);
}

// "Like my phone" follows the watch's clock setting, which the watch reports.
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
  if (use24) {
    time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  } else {
    const h = now.getHours() % 12 || 12;
    time = `${h}:${pad(now.getMinutes())}${settings.hideAmPm ? '' : now.getHours() < 12 ? ' AM' : ' PM'}`;
  }
  const dd = pad(now.getDate());
  const mm = pad(now.getMonth() + 1);
  $('ov-time').textContent = settings.showTime ? time : '';
  $('ov-date').textContent = settings.showDate ? (settings.dateFormat === 'mm-dd' ? `${mm}-${dd}` : `${dd}-${mm}`) : '';
  $('ov-time').hidden = !settings.showTime;
  $('ov-date').hidden = !settings.showDate;
  $('fmt-dm').textContent = `${dd}-${mm}`;
  $('fmt-md').textContent = `${mm}-${dd}`;

  const overlay = $('overlay');
  const anyText = settings.showTime || settings.showDate;
  overlay.classList.toggle('hidden', !anyText || settings.hideUntilShake);
  overlay.classList.toggle('boxed', settings.boxMode === 'always');
  overlay.classList.toggle('outline', settings.boxMode !== 'always');
}

// ---------------- wall label ----------------

const dutch = (navigator.language || '').toLowerCase().startsWith('nl');

// Wikipedia in the reader's language when it exists, else the other one, else
// the Wikidata item (every painting Wikidata knows has one).
function showWikiLink(wiki) {
  const link = $('art-wiki');
  const article = wiki && (dutch ? wiki.wikipediaNl || wiki.wikipediaEn : wiki.wikipediaEn || wiki.wikipediaNl);
  link.hidden = !wiki;
  if (!wiki) return;
  link.href = article || wiki.wikidata;
  link.textContent = article ? 'Read on Wikipedia' : 'Wikidata';
}

function showLabel(meta) {
  $('label').hidden = false;
  $('art-title').textContent = meta.title || 'Untitled';
  $('art-artist').textContent = meta.artist || 'Unknown artist';
  $('art-meta').textContent = [meta.date, meta.objectNumber].filter(Boolean).join(', ');
  // Credit line: source + licence, linked to the licence when we know it.
  const license = $('art-license');
  license.textContent = meta.license || 'Public domain';
  if (meta.licenseUrl) {
    license.href = meta.licenseUrl;
  } else {
    license.removeAttribute('href');
  }
  $('art-web').href = meta.webUrl;
  showWikiLink(meta.wiki);
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
  const stride = watch.stride || watch.w;
  return new URLSearchParams({
    w: watch.w,
    h: watch.h,
    color: 1,
    stride,
    round: watch.round ? 1 : 0,
    fit: settings.fit,
    palette: settings.palette,
    frame: settings.frame,
    era: settings.era,
  }).toString();
}

let requestId = 0;

function setStatus(text) {
  $('status').textContent = text;
}

async function loadPreview(path, { pick = false, extra = '' } = {}) {
  const id = ++requestId;
  screenEl.classList.add('loading');
  setStatus(pick ? 'Hanging a new painting…' : '');
  try {
    const res = await fetch(`${path}?${screenQuery()}${extra}`);
    const meta = await res.json();
    if (!res.ok) throw new Error(meta.error || `HTTP ${res.status}`);
    if (id !== requestId) return;
    if (pick) chosen = meta;
    showImage(meta.previewUrl, meta);
    showLabel(meta);
    setStatus(chosen ? 'Preview: this painting is hung when you save.' : '');
    updateShuffle();
    return meta;
  } catch (err) {
    if (id !== requestId) return null;
    screenEl.classList.remove('loading');
    setStatus(`Couldn’t load a preview (${err.message}).`);
    return null;
  }
}

/** Preview what the chosen selection + rotation would hang right now. */
function previewSelection() {
  if (settings.selection === 'featured') {
    const day = featuredDay[settings.rotation] ?? featuredDay.daily;
    loadPreview('/api/art/featured', { pick: true, extra: `&day=${day}` });
  } else {
    loadPreview('/api/art/random', { pick: true });
  }
}

function currentKey() {
  return (chosen || art)?.key;
}

function refreshPreview() {
  const key = currentKey();
  if (key) loadPreview(`/api/art/${encodeURIComponent(key)}`);
}

function updateShuffle() {
  $('keep').hidden = !(chosen && art);
}

$('shuffle').addEventListener('click', () => loadPreview('/api/art/random', { pick: true }));

$('keep').addEventListener('click', () => {
  chosen = null;
  updateShuffle();
  refreshPreview();
});

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
$('zoom-out').addEventListener('click', () => viewer?.viewport.zoomBy(1 / 1.6));
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
    ampm: settings.showTime && (settings.clockMode === '12' || (settings.clockMode === 'auto' && !clockIs24h())),
    anyText: settings.showTime || settings.showDate,
    hideUntilShake: settings.hideUntilShake,
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
        update();
        if (RENDER_KEYS.includes(key)) refreshPreview();
        // Choosing an era hangs a painting from it straight away (as a preview).
        if (key === 'era') loadPreview('/api/art/random', { pick: true });
        // Show what the new selection/rotation would hang today.
        if (key === 'selection' || (key === 'rotation' && settings.selection === 'featured')) {
          previewSelection();
        }
      }
    });
  });
});

function update() {
  applyVisibility();
  renderPreview();
}

update();
setInterval(renderPreview, 30_000);

// ---------------- save ----------------

function returnTo() {
  const match = /[?&]return_to=([^&]+)/.exec(location.search);
  return match ? decodeURIComponent(match[1]) : 'pebblejs://close#';
}

$('save').addEventListener('click', () => {
  const result = { settings, artKey: chosen ? chosen.key : null };
  document.location = returnTo() + encodeURIComponent(JSON.stringify(result));
});
