/**
 * The painting catalog (the generator's catalog files) and how to get a
 * painting's picture straight from the Rijksmuseum: the planned crop is cut
 * by their IIIF image server (`region` + `size` in the URL), as a lossless PNG
 * (~140 KB), so no server of our own is involved.
 *
 * The catalog is a folder: manifest.json (shared fields and the files, with
 * their painting counts) plus featured.json and one file per era. A reader
 * starts from the manifest and loads only the files it needs (`fileFor`,
 * `poolFor`, `add`); `addRow` takes a single painting, e.g. the one on the
 * watch. See docs/schema/catalog.schema.json.
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
  // 6: eraBits (which era file a painting is in; the files group them)
  var LICENSE = 7;
  var ASPECT = 8;
  var CROPS = 9;
  var CROP_STRIDE = 5; // x, y, w, h, window per screen (the generator's plan)

  function pct(v) {
    return String(Math.round(v * 100000) / 1000);
  }

  /**
   * A catalog over a parsed manifest.json. It starts empty: `add` the files
   * you need (featured.json, an era file) or single rows with `addRow`.
   */
  function create(data) {
    var byKey = {};
    var byObjectNumber = {};
    var pools = {}; // pool name → rows, once its file is added
    var counts = {};
    var files = {};
    var f;
    for (f = 0; f < data.files.length; f++) {
      counts[data.files[f].pool] = data.files[f].count;
      files[data.files[f].pool] = data.files[f].file;
    }

    function index(row) {
      byKey[row[KEY]] = row;
      if (row[OBJECT_NUMBER]) {
        byObjectNumber[String(row[OBJECT_NUMBER]).toLowerCase()] = row;
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
     * `view.zoom` (100-200, %) zooms in; `view.focusX`/`focusY` (0-10000, or
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
      var cx = view.focusX === null || view.focusX === undefined ? plannedX : view.focusX / 10000;
      var cy = view.focusY === null || view.focusY === undefined ? plannedY : view.focusY / 10000;
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
      return list && list.length ? list[Math.floor((random || Math.random)() * list.length)] : null;
    }

    /**
     * The pool to pick a random painting from: the era, or for 'any' an era
     * (or undated) chosen in proportion to its size, so every painting is
     * equally likely while only one file is needed.
     */
    function poolFor(era, random) {
      if (era && era !== 'any' && counts[era] !== undefined) {
        return era;
      }
      var total = 0;
      var p;
      for (p in counts) {
        if (Object.prototype.hasOwnProperty.call(counts, p) && p !== 'featured') {
          total += counts[p];
        }
      }
      var n = Math.floor((random || Math.random)() * total);
      for (p in counts) {
        if (Object.prototype.hasOwnProperty.call(counts, p) && p !== 'featured') {
          if (n < counts[p]) {
            return p;
          }
          n -= counts[p];
        }
      }
      return null;
    }

    return {
      version: data.version,
      /** Identifies this set of files; files with another id don't belong. */
      id: data.id,
      /** The manifest's file list: [{pool, file, count}]. */
      files: data.files,
      /** The file (e.g. '1600s.json') that holds a pool ('featured', an era, 'undated'). */
      fileFor: function (pool) {
        return files[pool] || null;
      },
      poolFor: poolFor,
      /** Whether a pool's file has been added. */
      has: function (pool) {
        return Boolean(pools[pool]);
      },
      /** Add a parsed catalog file. Returns false (and ignores it) if it is from another set. */
      add: function (part) {
        if (!part || part.id !== data.id || !part.pool) {
          return false;
        }
        pools[part.pool] = part.paintings;
        for (var i = 0; i < part.paintings.length; i++) {
          index(part.paintings[i]);
        }
        return true;
      },
      /** Add a single painting row (e.g. the one on the watch, from the cache). */
      addRow: function (row) {
        if (row && row[KEY]) {
          index(row);
        }
      },
      /** A painting's row, to hand over (e.g. to the phone with the settings). */
      row: function (key) {
        return byKey[key] || null;
      },
      /** Painting details by key, or null when not loaded. */
      get: function (key) {
        return painting(byKey[key]);
      },
      /** The Featured painting for a day of the year (0-based); needs featured.json. */
      featured: function (day) {
        var rows = pools.featured || [];
        return rows.length ? painting(rows[((day % rows.length) + rows.length) % rows.length]) : null;
      },
      /** A random painting from a pool (see poolFor); needs its file. */
      random: function (pool, random) {
        return painting(pick(pools[pool], random));
      },
      /** A painting from an object number (SK-C-5), a key or a link to it, among the loaded ones. */
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
