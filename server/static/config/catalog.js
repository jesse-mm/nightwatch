/**
 * The painting catalog (catalog.json from the generator) and how to get a
 * painting's picture straight from the Rijksmuseum: the planned crop is cut
 * by their IIIF image server (`region` + `size` in the URL), as a lossless PNG
 * (~140 KB), so no server of our own is involved. See docs/schema/catalog.schema.json for the file.
 *
 * Shared by the phone (PebbleKit JS) and the settings page, like render.js.
 * ES5 on purpose: PebbleKit JS is not a modern browser.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TreasureCatalog = factory();
  }
}(this, function () {
  'use strict';

  // Columns of a painting row in catalog.json.
  var KEY = 0;
  var IIIF = 1;
  var TITLE = 2;
  var ARTIST = 3;
  var DATE = 4;
  var OBJECT_NUMBER = 5;
  var ERA_BITS = 6;
  var LICENSE = 7;
  var ASPECT = 8;
  var CROPS = 9;
  var CROP_STRIDE = 5; // x, y, w, h, window per screen (the generator's plan)

  function pct(v) {
    return String(Math.round(v * 100000) / 1000);
  }

  /** A catalog over the parsed catalog.json. */
  function create(data) {
    var rows = data.paintings;
    var byKey = {};
    var byObjectNumber = {};
    var byEra = {};
    var i;
    for (i = 0; i < data.eras.length; i++) {
      byEra[data.eras[i]] = [];
    }
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      byKey[row[KEY]] = row;
      if (row[OBJECT_NUMBER]) {
        byObjectNumber[String(row[OBJECT_NUMBER]).toLowerCase()] = row;
      }
      for (var e = 0; e < data.eras.length; e++) {
        if (row[ERA_BITS] & (1 << e)) {
          byEra[data.eras[e]].push(row);
        }
      }
    }

    /** The painting's details, shaped like the old server's metadata. */
    function painting(row) {
      if (!row) {
        return null;
      }
      var iiifBase = data.iiifPrefix + row[IIIF];
      var license = data.licenses[row[LICENSE]] || ['', ''];
      return {
        key: row[KEY],
        title: row[TITLE],
        artist: row[ARTIST],
        date: row[DATE],
        objectNumber: row[OBJECT_NUMBER],
        webUrl: data.webPrefix + row[OBJECT_NUMBER],
        iiifBase: iiifBase,
        imageUrl: iiifBase + '/full/max/0/default.png',
        license: license[0],
        licenseUrl: license[1],
        aspect: row[ASPECT]
      };
    }

    function screenIndex(w, h, round) {
      for (var s = 0; s < data.screens.length; s++) {
        var sc = data.screens[s];
        if (sc[0] === w && sc[1] === h && Boolean(sc[2]) === Boolean(round)) {
          return s;
        }
      }
      return -1;
    }

    /** A painting's Cover plan for a screen: [x, y, w, h, window], or null. */
    function plan(row, screen) {
      var s = screenIndex(screen.w, screen.h, screen.round);
      return s < 0 ? null : row[CROPS].slice(s * CROP_STRIDE, s * CROP_STRIDE + CROP_STRIDE);
    }

    function clamp(v, lo, hi) {
      return Math.min(Math.max(v, lo), hi);
    }

    /**
     * The part of the painting a Cover screen shows, as fractions {x, y, w, h}.
     * `view.zoom` (100-200, %) zooms in; `view.focusX`/`focusY` (0-1000, or
     * null for the generator's smart crop) set the center. At 100% only the
     * free axis can move; zoomed in, both can.
     */
    function coverView(key, screen, view) {
      var row = byKey[key];
      var c = row && plan(row, screen);
      if (!c) {
        return null;
      }
      view = view || {};
      var aspect = row[ASPECT];
      var screenRatio = screen.w / screen.h;
      var zoom = clamp((view.zoom || 100) / 100, 1, 4);
      // The whole cover window at 100%: full height for wide paintings,
      // full width for tall ones.
      var w = aspect > screenRatio ? screenRatio / aspect : 1;
      var h = aspect > screenRatio ? 1 : aspect / screenRatio;
      // The planned (smart) center: where the generator put the view in its
      // crop with slack (c.window screen pixels from the crop's start).
      var ratio = (c[2] / c[3]) * aspect;
      var plannedX = 0.5;
      var plannedY = 0.5;
      if (ratio > screenRatio) {
        var cropW = Math.max(screen.w, Math.round(screen.h * ratio));
        plannedX = c[0] + (c[4] / cropW) * c[2] + w / 2;
      } else if (ratio < screenRatio) {
        var cropH = Math.max(screen.h, Math.round(screen.w / ratio));
        plannedY = c[1] + (c[4] / cropH) * c[3] + h / 2;
      }
      w /= zoom;
      h /= zoom;
      var cx = view.focusX === null || view.focusX === undefined ? plannedX : view.focusX / 1000;
      var cy = view.focusY === null || view.focusY === undefined ? plannedY : view.focusY / 1000;
      // Zooming into the planned view keeps its center where it can.
      cx = clamp(cx, w / 2, 1 - w / 2);
      cy = clamp(cy, h / 2, 1 - h / 2);
      return { x: cx - w / 2, y: cy - h / 2, w: w, h: h, cx: cx, cy: cy };
    }

    /**
     * Where to get a painting's picture for a screen: the IIIF URL and size.
     * Cover asks for exactly the visible part (see coverView) at screen size;
     * Contain asks for the whole painting fitted inside the screen.
     * @param {string} key painting key
     * @param {object} screen {w, h, round}
     * @param {string} fit 'fill' (Cover) or 'whole' (Contain)
     * @param {object} [view] {zoom, focusX, focusY} for Cover
     */
    function cropRequest(key, screen, fit, view) {
      var row = byKey[key];
      if (!row) {
        return null;
      }
      var base = data.iiifPrefix + row[IIIF];
      var sw = screen.w;
      var sh = screen.h;
      if (fit === 'whole') {
        var aspect = row[ASPECT];
        var wide = aspect > sw / sh;
        var cw = wide ? sw : Math.max(1, Math.round(sh * aspect));
        var ch = wide ? Math.max(1, Math.round(sw / aspect)) : sh;
        return { url: base + '/full/' + cw + ',' + ch + '/0/default.png', width: cw, height: ch };
      }
      var v = coverView(key, screen, view);
      if (!v) {
        return null;
      }
      return {
        url: base + '/pct:' + pct(v.x) + ',' + pct(v.y) + ',' + pct(v.w) + ',' + pct(v.h) +
          '/' + sw + ',' + sh + '/0/default.png',
        width: sw,
        height: sh
      };
    }

    // Longest side of the settings page's copy (about 720p): plenty for the
    // preview, and only very long panoramas ever reach it.
    var WORK_MAX_SIDE = 1280;

    /**
     * The whole painting, large enough to pan and zoom a Cover view up to
     * `maxZoom` (%) at full screen resolution, but at most WORK_MAX_SIDE
     * pixels long: for the settings page (the watch's own crop is exact).
     */
    function workImage(key, screen, maxZoom) {
      var row = byKey[key];
      if (!row) {
        return null;
      }
      var aspect = row[ASPECT];
      var z = (maxZoom || 200) / 100;
      var wide = aspect > screen.w / screen.h;
      var h = wide ? Math.round(screen.h * z) : Math.max(1, Math.round(screen.w * z / aspect));
      var w = wide ? Math.max(1, Math.round(h * aspect)) : Math.round(screen.w * z);
      var scale = Math.min(1, WORK_MAX_SIDE / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      return { url: data.iiifPrefix + row[IIIF] + '/full/' + w + ',' + h + '/0/default.png', width: w, height: h };
    }

    function pick(list, random) {
      return list.length ? list[Math.floor((random || Math.random)() * list.length)] : null;
    }

    return {
      version: data.version,
      size: rows.length,
      /** Painting details by key, or null. */
      get: function (key) {
        return painting(byKey[key]);
      },
      /** The Featured painting for a day of the year (0-based). */
      featured: function (day) {
        var keys = data.featured;
        return keys.length ? painting(byKey[keys[((day % keys.length) + keys.length) % keys.length]]) : null;
      },
      /** A random painting, optionally from one era ('any' or e.g. '1600s'). */
      random: function (era, random) {
        return painting(pick(era && era !== 'any' && byEra[era] ? byEra[era] : rows, random));
      },
      /** A painting from an object number (SK-C-5), a key or a link to it. */
      resolve: function (query) {
        // The last path segment of a link, without a query or "#…" fragment.
        var q = String(query || '').trim().replace(/\/+$/, '');
        var last = q.split('/').pop().split('?')[0].split('#')[0];
        return painting(byKey[last] || byObjectNumber[last.toLowerCase()]);
      },
      coverView: coverView,
      cropRequest: cropRequest,
      workImage: workImage
    };
  }

  return { create: create };
}));
