// A short tour of the settings page, shown once on first launch.
//
// A spotlight dims everything but one part of the page, with a card next to
// it: what that part does, and Back / Next / Skip. Seen once, it doesn't come
// back by itself (remembered in this browser's localStorage); "Show the tour"
// under Utilities starts it again. Loaded by i18n.js after app.js.

(() => {
  const t = (key, vars) => window.NightWatchI18n.t(key, vars);
  const SEEN = 'nw-tour-seen';

  // Each step lights up a part of the page (from `target` down to `until`,
  // e.g. a group's heading and its first control); the card explains it.
  // `scrollTo` scrolls somewhere else first: the mini preview only slides in
  // once the big one has scrolled away. `when` leaves a step out.
  const ALL_STEPS = [
    { target: '#frame', key: 'preview' },
    { target: '.label-links', key: 'painting' },
    { target: '#mini', scrollTo: '#g-look', key: 'mini', when: () => !document.getElementById('art')?.hidden },
    { target: '#g-look', until: '[aria-labelledby=g-look] > .row', key: 'look' },
    { target: '#g-rotation', until: '[aria-labelledby=g-rotation] > .row', key: 'rotation' },
    { target: '#g-datetime', until: '[aria-labelledby=g-datetime] > .row', key: 'datetime' },
    { target: '#save', key: 'save' },
  ];

  /** The step's area on screen: its element, down to `until` if given. */
  function area(step) {
    const el = document.querySelector(step.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const end = step.until && document.querySelector(step.until);
    const bottom = end ? Math.max(r.bottom, end.getBoundingClientRect().bottom) : r.bottom;
    return { top: r.top, bottom, left: r.left, right: r.right, height: bottom - r.top };
  }

  /** Space the sticky mini preview takes at the top once the big preview is gone. */
  function topInset() {
    const mini = document.getElementById('mini');
    return mini ? mini.offsetHeight + 16 : 16;
  }

  function seen() {
    try {
      return localStorage.getItem(SEEN) === '1';
    } catch {
      return false;
    }
  }

  function markSeen() {
    try {
      localStorage.setItem(SEEN, '1');
    } catch {
      // Private mode: the tour may show again next time.
    }
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let spot = null;
  let card = null;
  let steps = ALL_STEPS;
  let index = 0;
  let settle = 0;
  let frame = 0;
  let returnFocus = null;

  function build() {
    spot = document.createElement('div');
    spot.className = 'tour-spot';
    spot.setAttribute('aria-hidden', 'true');

    card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.setAttribute('aria-describedby', 'tour-body');
    card.innerHTML = `
      <p class="tour-count" id="tour-count"></p>
      <h2 class="tour-title" id="tour-title"></h2>
      <p class="tour-body" id="tour-body"></p>
      <div class="tour-actions">
        <button type="button" class="tour-skip" id="tour-skip"></button>
        <span class="tour-nav">
          <button type="button" class="text-button" id="tour-back"></button>
          <button type="button" class="tour-next" id="tour-next"></button>
        </span>
      </div>`;
    document.body.append(spot, card);

    card.querySelector('#tour-skip').addEventListener('click', end);
    card.querySelector('#tour-back').addEventListener('click', () => go(index - 1));
    card.querySelector('#tour-next').addEventListener('click', () => {
      if (index === steps.length - 1) end();
      else go(index + 1);
    });
    // The dimmed page isn't clickable during the tour.
    spot.addEventListener('pointerdown', (e) => e.preventDefault());
  }

  function onKey(e) {
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight' && index < steps.length - 1) go(index + 1);
    else if (e.key === 'ArrowLeft' && index > 0) go(index - 1);
    else if (e.key === 'Tab') {
      // Keep keyboard focus inside the card.
      const buttons = [...card.querySelectorAll('button:not([hidden])')];
      const i = buttons.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
      buttons[next].focus();
      e.preventDefault();
    }
  }

  /** Put the spotlight on the step's element and the card beside it. */
  function place() {
    const r = card && area(steps[index]);
    if (!r) return;
    const pad = 8;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    // Wide elements (the section headings) get a spotlight across the page.
    const left = Math.max(8, r.left - pad);
    const right = Math.min(vw - 8, r.right + pad);
    Object.assign(spot.style, {
      top: `${r.top - pad}px`,
      left: `${left}px`,
      width: `${right - left}px`,
      height: `${r.height + pad * 2}px`,
    });
    // Below the element when it fits, otherwise above it.
    const gap = 12;
    const h = card.offsetHeight;
    const below = r.bottom + pad + gap;
    const above = r.top - pad - gap - h;
    const top = below + h <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - h - 8);
    card.style.top = `${top}px`;
  }

  function follow() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  }

  function go(i) {
    index = i;
    const step = steps[index];
    card.querySelector('#tour-count').textContent = t('tour.count', { n: index + 1, total: steps.length });
    card.querySelector('#tour-title').textContent = t(`tour.${step.key}.title`);
    card.querySelector('#tour-body').textContent = t(`tour.${step.key}.body`);
    card.querySelector('#tour-back').hidden = index === 0;
    card.querySelector('#tour-skip').hidden = index === steps.length - 1;
    card.querySelector('#tour-next').textContent = t(index === steps.length - 1 ? 'tour.done' : 'tour.next');

    // The save bar is always in view. Groups scroll up to just below the
    // mini preview, leaving room for the card; the rest to the middle.
    const r = area(step.scrollTo ? { target: step.scrollTo } : step);
    if (r && step.target !== '#save') {
      const top = step.until || step.scrollTo
        ? window.scrollY + r.top - topInset()
        : window.scrollY + r.top - (window.innerHeight - r.height) / 2;
      window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? 'auto' : 'smooth' });
    }
    // Keep following for a moment: things slide in (the mini preview) after
    // the scroll, without a scroll event of their own.
    const until = performance.now() + 800;
    cancelAnimationFrame(settle);
    const track = () => {
      place();
      if (card && performance.now() < until) settle = requestAnimationFrame(track);
    };
    track();
    card.querySelector('#tour-next').focus({ preventScroll: true });
  }

  function start() {
    if (card) return;
    returnFocus = document.activeElement;
    steps = ALL_STEPS.filter((step) => !step.when || step.when());
    build();
    card.querySelector('#tour-skip').textContent = t('tour.skip');
    card.querySelector('#tour-back').textContent = t('tour.back');
    document.documentElement.classList.add('touring');
    window.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', follow);
    document.addEventListener('keydown', onKey);
    go(0);
  }

  function end() {
    markSeen();
    window.removeEventListener('scroll', follow);
    window.removeEventListener('resize', follow);
    document.removeEventListener('keydown', onKey);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(settle);
    spot?.remove();
    card?.remove();
    spot = null;
    card = null;
    document.documentElement.classList.remove('touring');
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    if (returnFocus?.focus) returnFocus.focus({ preventScroll: true });
  }

  document.getElementById('tour-start')?.addEventListener('click', start);

  // First launch: start once the loading screen is gone.
  if (seen()) return;
  const loader = document.getElementById('loader');
  const whenLoaded = () => setTimeout(start, 300);
  if (!loader || loader.classList.contains('done')) {
    whenLoaded();
  } else {
    const watch = new MutationObserver(() => {
      if (!loader.classList.contains('done')) return;
      watch.disconnect();
      whenLoaded();
    });
    watch.observe(loader, { attributes: true, attributeFilter: ['class'] });
  }
})();
