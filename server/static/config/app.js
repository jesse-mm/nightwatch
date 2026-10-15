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
  boxMode: 'toggle',
  fit: 'fill',
  palette: 'defined',
};

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
const art = state.art || null;
const watch = state.watch || { w: 144, h: 168, color: 1, round: 0 };
let newPainting = false;

const $ = (id) => document.getElementById(id);

// ---------------- preview ----------------

const scale = Math.max(1, Math.min(2, Math.floor((window.innerWidth - 64) / watch.w)));
const screenEl = $('screen');
screenEl.style.setProperty('--sw', `${watch.w * scale}px`);
screenEl.style.setProperty('--sh', `${watch.h * scale}px`);
screenEl.style.setProperty('--scale', String(scale));
screenEl.classList.toggle('round', Boolean(watch.round));

if (art && art.previewUrl) {
  const img = $('art');
  img.src = art.previewUrl;
  img.alt = `${art.title} by ${art.artist}, as shown on the watch`;
  img.hidden = false;
  $('screen-empty').hidden = true;
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
  const use24 = settings.clockMode === '24' || (settings.clockMode === 'auto' && phoneUses24h());
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

if (art) {
  $('label').hidden = false;
  $('art-title').textContent = art.title || 'Untitled';
  $('art-artist').textContent = art.artist || 'Unknown artist';
  const meta = [art.date, art.objectNumber, art.license].filter(Boolean).join(', ');
  $('art-meta').textContent = meta;
  $('art-web').href = art.webUrl;
  if (art.imageUrl) {
    $('art-image').href = art.imageUrl;
  } else {
    $('art-image').hidden = true;
  }
}

$('shuffle').addEventListener('click', (e) => {
  newPainting = !newPainting;
  e.currentTarget.setAttribute('aria-pressed', String(newPainting));
  e.currentTarget.textContent = newPainting
    ? 'A new painting will be hung when you save'
    : 'Hang a different painting';
});

// ---------------- controls ----------------

function conditions() {
  return {
    showTime: settings.showTime,
    showDate: settings.showDate,
    ampm: settings.showTime && settings.clockMode !== '24',
    anyText: settings.showTime || settings.showDate,
    colorWatch: Boolean(watch.color),
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

document.querySelectorAll('.segmented[data-key]').forEach((group) => {
  const key = group.dataset.key;
  group.querySelectorAll('input[type=radio]').forEach((radio) => {
    radio.checked = radio.value === String(settings[key]);
    radio.addEventListener('change', () => {
      if (radio.checked) {
        settings[key] = radio.value;
        update();
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
  const result = { settings, newPainting };
  document.location = returnTo() + encodeURIComponent(JSON.stringify(result));
});
