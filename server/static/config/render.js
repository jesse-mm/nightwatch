/**
 * Treasure Trove rendering: turn a full-colour crop into the exact bytes a
 * colour Pebble shows, with the chosen colour tuning and frame.
 *
 * Shared by the phone (PebbleKit JS, required as './render') and the settings
 * page (window.TreasureRender), so the preview is the same code as the watch.
 * ES5 on purpose: PebbleKit JS on iOS is a bare JavaScriptCore.
 *
 * Ported from the Rust generator (palette.rs, frame.rs) and checked against
 * its output (watchface/test/fixtures/render.json). Arithmetic follows Rust's
 * 32-bit floats via Math.fround so dithering matches it exactly.
 *
 * Colour approach from czmanix/pebble-color-optimizer (MIT): match each pixel
 * against how Pebble colours *look* on the screen in some light, then write the
 * real colour with the same index; Atkinson error diffusion.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TreasureRender = factory();
  }
}(this, function () {
  'use strict';

  var f = Math.fround;

  /** How the 64 Pebble colours look in each light (same order as `defined`). */
  var PALETTES = {
  defined: [
    [0, 0, 0], [0, 0, 85], [0, 0, 170], [85, 0, 0],
    [0, 0, 255], [85, 0, 85], [85, 0, 170], [0, 85, 0],
    [170, 0, 85], [0, 85, 170], [170, 0, 170], [85, 85, 0],
    [255, 0, 0], [0, 85, 255], [170, 0, 255], [85, 85, 85],
    [0, 170, 0], [170, 85, 0], [85, 85, 255], [255, 0, 255],
    [0, 170, 85], [170, 85, 85], [0, 170, 170], [170, 85, 170],
    [170, 85, 255], [85, 170, 85], [255, 85, 85], [85, 170, 170],
    [255, 85, 170], [0, 255, 0], [170, 170, 0], [85, 170, 255],
    [0, 255, 170], [170, 170, 170], [85, 255, 0], [255, 170, 0],
    [0, 255, 255], [170, 170, 255], [85, 255, 85], [255, 170, 85],
    [85, 255, 255], [255, 170, 255], [170, 255, 85], [170, 255, 170],
    [255, 255, 0], [170, 255, 255], [255, 255, 85], [255, 255, 170],
    [170, 255, 0], [170, 170, 85], [255, 255, 255], [85, 255, 170],
    [255, 85, 255], [85, 170, 0], [255, 0, 85], [170, 0, 0],
    [0, 170, 255], [255, 0, 170], [0, 85, 85], [255, 170, 170],
    [0, 255, 85], [255, 85, 0], [85, 85, 170], [85, 0, 255]
  ],
  sun: [
    [39, 32, 32], [38, 52, 74], [27, 65, 104], [91, 36, 35],
    [3, 72, 122], [88, 52, 71], [86, 69, 99], [63, 73, 50],
    [136, 63, 81], [62, 108, 128], [136, 80, 112], [108, 82, 62],
    [158, 45, 50], [45, 112, 141], [131, 89, 128], [103, 91, 90],
    [87, 109, 69], [155, 95, 79], [108, 117, 140], [163, 95, 132],
    [82, 123, 105], [146, 99, 97], [83, 132, 134], [141, 107, 118],
    [149, 123, 142], [128, 130, 113], [169, 104, 103], [122, 138, 138],
    [174, 111, 124], [97, 134, 91], [157, 121, 92], [114, 136, 148],
    [95, 154, 143], [151, 141, 136], [139, 144, 107], [186, 130, 100],
    [101, 163, 162], [151, 141, 136], [131, 141, 122], [181, 135, 117],
    [137, 163, 158], [184, 157, 148], [162, 139, 119], [167, 164, 155],
    [194, 151, 116], [167, 164, 155], [185, 154, 131], [184, 157, 148],
    [175, 145, 107], [162, 139, 119], [188, 169, 166], [133, 155, 141],
    [170, 124, 145], [126, 117, 84], [158, 66, 83], [128, 40, 44],
    [79, 142, 155], [164, 86, 117], [65, 93, 96], [182, 145, 141],
    [98, 145, 120], [174, 91, 75], [107, 107, 120], [85, 83, 125]
  ],
  room: [
    [20, 19, 24], [23, 28, 40], [23, 33, 54], [39, 25, 30],
    [19, 40, 64], [47, 30, 39], [40, 38, 57], [30, 37, 40],
    [60, 42, 56], [35, 52, 64], [60, 42, 56], [51, 45, 40],
    [74, 37, 40], [33, 56, 73], [59, 48, 68], [48, 48, 48],
    [43, 56, 46], [69, 50, 47], [55, 62, 77], [74, 53, 74],
    [43, 58, 56], [66, 52, 57], [44, 64, 67], [65, 56, 64],
    [68, 63, 78], [62, 64, 61], [82, 58, 61], [62, 67, 71],
    [79, 60, 71], [52, 67, 52], [73, 62, 54], [58, 69, 78],
    [54, 79, 77], [74, 72, 75], [68, 72, 56], [88, 64, 58],
    [48, 80, 84], [74, 72, 78], [66, 72, 64], [84, 66, 64],
    [68, 82, 87], [86, 77, 85], [81, 77, 70], [80, 79, 77],
    [91, 76, 68], [79, 84, 88], [91, 76, 68], [90, 80, 78],
    [79, 74, 61], [72, 66, 63], [91, 86, 87], [67, 78, 73],
    [75, 63, 75], [57, 54, 47], [68, 41, 57], [47, 30, 39],
    [42, 66, 76], [68, 41, 57], [30, 37, 40], [82, 69, 73],
    [49, 69, 61], [74, 49, 46], [50, 50, 59], [40, 38, 57]
  ],
  backlight: [
    [52, 68, 116], [46, 103, 163], [43, 125, 189], [115, 88, 139],
    [37, 137, 200], [112, 123, 182], [104, 136, 196], [80, 117, 152],
    [140, 129, 188], [75, 156, 209], [138, 150, 216], [140, 135, 175],
    [164, 111, 159], [75, 168, 221], [138, 159, 222], [133, 157, 208],
    [100, 143, 177], [150, 134, 181], [130, 176, 234], [160, 165, 231],
    [105, 164, 202], [151, 160, 210], [94, 179, 222], [144, 170, 224],
    [143, 180, 238], [133, 171, 218], [173, 168, 222], [140, 184, 232],
    [175, 176, 229], [110, 156, 181], [174, 163, 197], [133, 190, 234],
    [101, 186, 227], [160, 195, 243], [152, 170, 201], [195, 165, 205],
    [116, 196, 238], [168, 198, 243], [147, 183, 218], [179, 179, 219],
    [138, 201, 245], [168, 202, 248], [170, 186, 227], [179, 200, 247],
    [206, 177, 209], [172, 206, 246], [182, 189, 232], [185, 202, 239],
    [168, 171, 205], [155, 172, 219], [179, 210, 250], [152, 189, 232],
    [173, 180, 234], [136, 145, 177], [150, 134, 181], [128, 95, 139],
    [83, 175, 228], [140, 146, 209], [66, 133, 181], [182, 189, 232],
    [105, 164, 202], [171, 140, 174], [118, 153, 200], [104, 136, 196]
  ]
  };

  // ------------------------------------------------------------ palettes

  /** Pebble's 8-bit colour byte: 0b11RRGGBB. */
  function gcolor8(rgb) {
    return 0xC0 | ((rgb[0] / 85) << 4) | ((rgb[1] / 85) << 2) | (rgb[2] / 85);
  }

  var GCOLOR = PALETTES.defined.map(gcolor8);
  var cache = {};

  /**
   * The colours to match against, stretched to the full 0-255 range (the
   * simulated palettes are much darker than the image otherwise).
   */
  function matchPalette(name) {
    if (cache[name]) {
      return cache[name];
    }
    var table = PALETTES[name] || PALETTES.defined;
    var lo = 255;
    var hi = 0;
    for (var i = 0; i < 64; i++) {
      for (var ch = 0; ch < 3; ch++) {
        lo = Math.min(lo, table[i][ch]);
        hi = Math.max(hi, table[i][ch]);
      }
    }
    var span = f(Math.max(hi - lo, 1));
    var colors = new Float32Array(64 * 3);
    for (var k = 0; k < 64; k++) {
      for (var c = 0; c < 3; c++) {
        colors[k * 3 + c] = f(f(Math.max(table[k][c] - lo, 0) * 255) / span);
      }
    }
    cache[name] = colors;
    return colors;
  }

  var ATKINSON = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];

  /**
   * Atkinson-dither an RGB image (Uint8Array, w*h*3) to palette indices.
   * Each of 6 neighbours gets 1/8 of the error; the rest is dropped, which
   * keeps highlights and shadows crisp on a tiny screen.
   */
  function dither(rgb, w, h, paletteName) {
    var colors = matchPalette(paletteName);
    var buf = new Float32Array(rgb.length);
    for (var i = 0; i < rgb.length; i++) {
      buf[i] = rgb[i];
    }
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = (y * w + x) * 3;
        var r = Math.min(Math.max(buf[p], 0), 255);
        var g = Math.min(Math.max(buf[p + 1], 0), 255);
        var b = Math.min(Math.max(buf[p + 2], 0), 255);
        // Nearest colour, weighted towards green (the eye is most sensitive to it).
        var best = 0;
        var bestD = Infinity;
        for (var k = 0; k < 64; k++) {
          var dr = f(r - colors[k * 3]);
          var dg = f(g - colors[k * 3 + 1]);
          var db = f(b - colors[k * 3 + 2]);
          var d = f(f(f(f(2 * dr) * dr) + f(f(4 * dg) * dg)) + f(f(3 * db) * db));
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        out[y * w + x] = best;
        var er = f(f(r - colors[best * 3]) / 8);
        var eg = f(f(g - colors[best * 3 + 1]) / 8);
        var eb = f(f(b - colors[best * 3 + 2]) / 8);
        for (var n = 0; n < 6; n++) {
          var nx = x + ATKINSON[n][0];
          var ny = y + ATKINSON[n][1];
          if (nx >= 0 && nx < w && ny < h) {
            var q = (ny * w + nx) * 3;
            buf[q] += er;
            buf[q + 1] += eg;
            buf[q + 2] += eb;
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ frames

  var BLACK = [0, 0, 0];
  var ROSE = [85, 0, 0];
  var OLIVE = [85, 85, 0];
  var TAN = [170, 85, 0];
  var GOLD = [255, 170, 0];
  var YELLOW = [255, 255, 85];
  var PALE = [255, 255, 170];
  var GREY = [85, 85, 85];
  var LIGHT_GREY = [170, 170, 170];
  var WHITE = [255, 255, 255];

  function solid(c) {
    return [c, c];
  }

  /**
   * A frame is a band along the screen edge (a ring on round watches), drawn
   * in exact Pebble colours without dithering. Each profile lists bands from
   * the outer edge in: [ends at fraction of the border, lit, mid, shade];
   * each tone is two colours mixed in a fine checker (Pebble has no dark brown).
   */
  var FRAMES = {
    gold: {
      share: 0.08,
      background: BLACK,
      bands: [
        [0.10, solid(OLIVE), [OLIVE, ROSE], solid(BLACK)],
        [0.25, solid(PALE), solid(GOLD), [GOLD, TAN]],
        [0.45, solid(YELLOW), solid(GOLD), [GOLD, TAN]],
        [0.55, solid(TAN), solid(TAN), [TAN, OLIVE]],
        [0.82, solid(GOLD), solid(GOLD), [GOLD, TAN]],
        [0.92, solid(PALE), solid(YELLOW), solid(GOLD)],
        [1.00, solid(OLIVE), solid(OLIVE), solid(BLACK)]
      ]
    },
    wood: {
      share: 0.065,
      background: BLACK,
      bands: [
        [0.12, solid(BLACK), solid(BLACK), solid(BLACK)],
        [0.32, [TAN, ROSE], [ROSE, OLIVE], [ROSE, BLACK]],
        [0.78, [ROSE, OLIVE], [ROSE, OLIVE], [ROSE, BLACK]],
        [0.90, solid(GOLD), solid(GOLD), solid(TAN)],
        [1.00, solid(BLACK), solid(BLACK), solid(BLACK)]
      ]
    },
    gallery: {
      share: 0.10,
      background: WHITE,
      bands: [
        [0.08, solid(GREY), solid(BLACK), solid(BLACK)],
        [0.30, solid(BLACK), solid(BLACK), solid(BLACK)],
        [0.92, solid(WHITE), solid(WHITE), solid(WHITE)],
        [1.00, solid(WHITE), solid(LIGHT_GREY), solid(LIGHT_GREY)]
      ]
    }
  };

  /** Frame width in pixels for a screen (0 = no frame). */
  function frameBorder(frame, w, h) {
    var spec = FRAMES[frame];
    return spec ? Math.round(f(f(Math.min(w, h)) * f(spec.share))) : 0;
  }

  /** What shows around a letterboxed painting inside the frame. */
  function frameBackground(frame) {
    return FRAMES[frame] ? FRAMES[frame].background : BLACK;
  }

  var SQRT_2 = f(Math.SQRT2);

  /** Colour of screen pixel (x, y), or null where the painting shows. */
  function framePixel(frame, x, y, w, h, round) {
    var border = frameBorder(frame, w, h);
    if (!border) {
      return null;
    }
    var depth;
    var light;
    if (round) {
      var cx = f(w / 2);
      var cy = f(h / 2);
      var dx = f(f(x + 0.5) - cx);
      var dy = f(f(y + 0.5) - cy);
      var r = Math.max(f(Math.sqrt(f(f(dx * dx) + f(dy * dy)))), f(1e-3));
      depth = f(Math.min(cx, cy) - r);
      // Facing the top left (dx, dy negative) is lit.
      light = f(f(-f(dx + dy)) / f(r * SQRT_2));
    } else {
      var left = x;
      var top = y;
      depth = Math.min(left, top, w - 1 - x, h - 1 - y);
      // Corners are mitred: whichever edge is nearest decides the lighting.
      light = depth === top || depth === left ? 1 : -1;
    }
    if (depth >= border) {
      return null;
    }
    var u = f(f(Math.max(depth, 0) + 0.5) / border);
    var bands = FRAMES[frame].bands;
    var band = bands[bands.length - 1];
    for (var i = 0; i < bands.length; i++) {
      if (u <= f(bands[i][0])) {
        band = bands[i];
        break;
      }
    }
    var tone = light > f(0.35) ? band[1] : (light < f(-0.35) ? band[3] : band[2]);
    return tone[(x + y) % 2];
  }

  // ------------------------------------------------------------ fitting

  /** Bilinear resize of an RGB image. */
  function resize(rgb, sw, sh, dw, dh) {
    var out = new Uint8Array(dw * dh * 3);
    for (var y = 0; y < dh; y++) {
      var fy = Math.min(Math.max((y + 0.5) * sh / dh - 0.5, 0), sh - 1);
      var y0 = Math.floor(fy);
      var y1 = Math.min(y0 + 1, sh - 1);
      var ty = fy - y0;
      for (var x = 0; x < dw; x++) {
        var fx = Math.min(Math.max((x + 0.5) * sw / dw - 0.5, 0), sw - 1);
        var x0 = Math.floor(fx);
        var x1 = Math.min(x0 + 1, sw - 1);
        var tx = fx - x0;
        for (var c = 0; c < 3; c++) {
          var top = rgb[(y0 * sw + x0) * 3 + c] * (1 - tx) + rgb[(y0 * sw + x1) * 3 + c] * tx;
          var bottom = rgb[(y1 * sw + x0) * 3 + c] * (1 - tx) + rgb[(y1 * sw + x1) * 3 + c] * tx;
          out[(y * dw + x) * 3 + c] = Math.round(top * (1 - ty) + bottom * ty);
        }
      }
    }
    return out;
  }

  /** Cut a w×h window out of an RGB image, starting at (x0, y0). */
  function cut(rgb, sw, x0, y0, w, h) {
    var out = new Uint8Array(w * h * 3);
    for (var y = 0; y < h; y++) {
      var from = ((y0 + y) * sw + x0) * 3;
      out.set(rgb.subarray(from, from + w * 3), y * w * 3);
    }
    return out;
  }

  /**
   * Fit the crop into the frame's opening. "fill" crops are screen-sized:
   * scale to cover the opening and trim evenly. "whole" crops are the whole
   * painting: scale down to fit inside it.
   */
  function fitArt(rgb, cw, ch, ow, oh, fit) {
    if (cw === ow && ch === oh) {
      return { rgb: rgb, w: cw, h: ch };
    }
    if (fit === 'whole') {
      var s = Math.min(ow / cw, oh / ch, 1);
      var w = Math.max(1, Math.round(cw * s));
      var h = Math.max(1, Math.round(ch * s));
      return { rgb: w === cw && h === ch ? rgb : resize(rgb, cw, ch, w, h), w: w, h: h };
    }
    var cover = Math.max(ow / cw, oh / ch);
    var rw = Math.max(ow, Math.round(cw * cover));
    var rh = Math.max(oh, Math.round(ch * cover));
    var scaled = rw === cw && rh === ch ? rgb : resize(rgb, cw, ch, rw, rh);
    return {
      rgb: cut(scaled, rw, (rw - ow) >> 1, (rh - oh) >> 1, ow, oh),
      w: ow,
      h: oh
    };
  }

  // ------------------------------------------------------------ compose

  /**
   * The watch's bytes for a crop: fit it into the frame's opening, dither it
   * with the colour tuning, centre it, and draw the frame around it.
   * @param {Uint8Array|Array} crop full-colour RGB, cw*ch*3
   * @param {object} o {w, h, stride, round, fit, frame, palette}
   * @returns {Uint8Array} stride*h GColor8 bytes
   */
  function compose(crop, cw, ch, o) {
    var w = o.w;
    var h = o.h;
    var stride = o.stride || w;
    var border = frameBorder(o.frame, w, h);
    var art = fitArt(crop instanceof Uint8Array ? crop : new Uint8Array(crop), cw, ch,
      w - 2 * border, h - 2 * border, o.fit);
    var idx = dither(art.rgb, art.w, art.h, o.palette);
    var out = new Uint8Array(stride * h);
    var bg = gcolor8(frameBackground(o.frame));
    for (var i = 0; i < out.length; i++) {
      out[i] = bg;
    }
    var ox = (w - art.w) >> 1;
    var oy = (h - art.h) >> 1;
    for (var y = 0; y < art.h; y++) {
      for (var x = 0; x < art.w; x++) {
        out[(y + oy) * stride + x + ox] = GCOLOR[idx[y * art.w + x]];
      }
    }
    if (border) {
      for (var fy = 0; fy < h; fy++) {
        for (var fx = 0; fx < w; fx++) {
          var c = framePixel(o.frame, fx, fy, w, h, o.round);
          if (c) {
            out[fy * stride + fx] = gcolor8(c);
          }
        }
      }
    }
    return out;
  }

  /** RGBA pixels (for a canvas) from watch bytes. */
  function toRGBA(bytes, w, h, stride) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var b = bytes[y * (stride || w) + x];
        var o = (y * w + x) * 4;
        out[o] = ((b >> 4) & 3) * 85;
        out[o + 1] = ((b >> 2) & 3) * 85;
        out[o + 2] = (b & 3) * 85;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  return {
    compose: compose,
    dither: dither,
    framePixel: framePixel,
    frameBorder: frameBorder,
    fitArt: fitArt,
    gcolor8: gcolor8,
    toRGBA: toRGBA,
    GCOLOR: GCOLOR
  };
}));
