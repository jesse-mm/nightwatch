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
  var CROP_STRIDE = 5; // x, y, w, h, window per screen

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

    /**
     * Where to get a painting's crop for a screen: the IIIF URL, the crop size
     * and, for Cover, where the planned view sits in it (render.js cuts it).
     * @param {string} key painting key
     * @param {object} screen {w, h, round}
     * @param {string} fit 'fill' (Cover) or 'whole' (Contain)
     */
    function cropRequest(key, screen, fit) {
      var row = byKey[key];
      if (!row) {
        return null;
      }
      var base = data.iiifPrefix + row[IIIF];
      var aspect = row[ASPECT];
      var sw = screen.w;
      var sh = screen.h;
      if (fit === 'whole') {
        var wide = aspect > sw / sh;
        var cw = wide ? sw : Math.max(1, Math.round(sh * aspect));
        var ch = wide ? Math.max(1, Math.round(sw / aspect)) : sh;
        return { url: base + '/full/' + cw + ',' + ch + '/0/default.png', width: cw, height: ch, windowX: 0, windowY: 0 };
      }
      var s = screenIndex(sw, sh, screen.round);
      if (s < 0) {
        return null;
      }
      var c = row[CROPS].slice(s * CROP_STRIDE, s * CROP_STRIDE + CROP_STRIDE);
      // Crop shape in image pixels relative to its height: (w * W) / (h * H).
      var ratio = (c[2] / c[3]) * aspect;
      // Wider than the screen: it slides sideways (otherwise up and down).
      var slidesX = ratio > sw / sh;
      var width = slidesX ? Math.max(sw, Math.round(sh * ratio)) : sw;
      var height = slidesX ? sh : Math.max(sh, Math.round(sw / ratio));
      return {
        url: base + '/pct:' + pct(c[0]) + ',' + pct(c[1]) + ',' + pct(c[2]) + ',' + pct(c[3]) +
          '/' + width + ',' + height + '/0/default.png',
        width: width,
        height: height,
        windowX: slidesX ? c[4] : 0,
        windowY: slidesX ? 0 : c[4]
      };
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
      cropRequest: cropRequest
    };
  }

  return { create: create };
}));
