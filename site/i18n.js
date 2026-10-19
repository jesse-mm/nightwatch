// Translations for the settings page (en-US, nl-NL).
// Messages live in translations/<lang>.json as ICU MessageFormat, formatted by
// intl-messageformat (loaded before this file from vendor/). This script loads the
// translation files first, fills the static page (data-i18n, data-i18n-attr)
// and only then loads app.js, which uses window.NightWatchI18n.t() right away.
//
// vendor/intl-messageformat-11.2.0.iife.js: FormatJS intl-messageformat 11.2.0
// (BSD-3-Clause), unmodified, from
// https://cdn.jsdelivr.net/npm/intl-messageformat@11.2.0/intl-messageformat.iife.js
// (the last release whose .iife.js is a real browser build: it sets the global
// `IntlMessageFormat`; later "iife" files are ES modules). If it's missing,
// t() falls back to plain {name} substitution and simple plural/select.

(() => {
  const FALLBACK = 'en-US';

  /** A language tag → a language we have: Dutch, or English for everything else. */
  function supported(tag) {
    return String(tag || '').toLowerCase().startsWith('nl') ? 'nl-NL' : FALLBACK;
  }

  /** ?lang= wins; otherwise the browser's (phone's) first preferred language. */
  function detect() {
    const param = new URLSearchParams(location.search).get('lang');
    if (param) return supported(param);
    const preferred = navigator.languages?.length ? navigator.languages[0] : navigator.language;
    return supported(preferred);
  }

  const lang = detect();
  document.documentElement.lang = lang;

  // Looked up in this order: the reader's language, then English.
  const tables = []; // [{ lang, messages }]
  const compiled = new Map(); // `${lang}\u0000${key}` → IntlMessageFormat (or null if it didn't parse)
  const lib = window.IntlMessageFormat;
  const MessageFormat = lib && (lib.IntlMessageFormat || lib.default);

  function find(key) {
    for (const table of tables) {
      if (Object.hasOwn(table.messages, key)) return { lang: table.lang, message: table.messages[key] };
    }
    return null;
  }

  // ---- fallback without the library: {name}, and simple plural/select ----

  /** Split "a {x} b {y, plural, one {..} other {..}}" at its top-level {…} blocks. */
  function blocks(message) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < message.length; i++) {
      const ch = message[i];
      if (ch === '{') {
        if (depth === 0) {
          parts.push(message.slice(start, i));
          start = i + 1;
        }
        depth++;
      } else if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0) {
          parts.push({ block: message.slice(start, i) });
          start = i + 1;
        }
      }
    }
    parts.push(message.slice(start));
    return parts;
  }

  function simpleFormat(message, vars, hash) {
    return blocks(message).map((part) => {
      if (typeof part === 'string') return hash === undefined ? part : part.replaceAll('#', String(hash));
      const [name, type] = part.block.split(',').map((s) => s.trim());
      const value = vars[name];
      if (type !== 'plural' && type !== 'select') return value === undefined ? `{${part.block}}` : String(value);
      // "name, plural, one {…} other {…}": pick a branch.
      const body = part.block.slice(part.block.indexOf(',', part.block.indexOf(',') + 1) + 1);
      const options = {};
      let selector = null;
      for (const p of blocks(body)) {
        if (typeof p === 'string') selector = p.trim();
        else if (selector) options[selector] = p.block;
      }
      const n = Number(value);
      const pick = type === 'plural'
        ? options[`=${n}`] ?? (n === 1 ? options.one : undefined) ?? options.other
        : options[String(value)] ?? options.other;
      return pick === undefined ? '' : simpleFormat(pick, vars, type === 'plural' ? n : hash);
    }).join('');
  }

  // ---- the API ----

  /** The text for `key` with its {placeholders} filled in; the key itself if unknown. */
  function t(key, vars = {}) {
    const found = find(key);
    if (!found) return key;
    if (MessageFormat) {
      const id = `${found.lang}\u0000${key}`;
      if (!compiled.has(id)) {
        try {
          compiled.set(id, new MessageFormat(found.message, found.lang));
        } catch (err) {
          console.warn(`i18n: can't parse ${found.lang} "${key}"`, err);
          compiled.set(id, null);
        }
      }
      const format = compiled.get(id);
      if (format) {
        try {
          return String(format.format(vars));
        } catch (err) {
          console.warn(`i18n: can't format "${key}"`, err);
        }
      }
    }
    return simpleFormat(found.message, vars);
  }

  /** Fill data-i18n (text) and data-i18n-attr ("attr:key;attr:key") under `root`. */
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (find(key)) el.textContent = t(key);
    });
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      for (const pair of el.dataset.i18nAttr.split(';')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key && find(key)) el.setAttribute(attr, t(key));
      }
    });
  }

  window.NightWatchI18n = { lang, t, apply };

  function load(code) {
    return fetch(`translations/${code}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((messages) => ({ lang: code, messages }))
      .catch((err) => {
        console.warn(`i18n: couldn't load ${code}`, err);
        return null;
      });
  }

  const codes = lang === FALLBACK ? [FALLBACK] : [lang, FALLBACK];
  Promise.all(codes.map(load)).then((loaded) => {
    for (const table of loaded) if (table) tables.push(table);
    try {
      apply();
    } catch (err) {
      console.warn('i18n: apply failed', err);
    }
    // Now the page logic, which needs the texts from the start.
    const script = document.createElement('script');
    script.src = 'app.js';
    // The first-launch tour points at the page app.js has set up.
    script.addEventListener('load', () => {
      const tour = document.createElement('script');
      tour.src = 'tour.js';
      document.body.append(tour);
    });
    document.body.append(script);
  });
})();
