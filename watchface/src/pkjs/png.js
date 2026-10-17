/**
 * A small PNG decoder for the crops the Rijksmuseum's IIIF server sends:
 * 8-bit RGB or RGBA, not interlaced (that's what it produces). Returns RGB.
 * Inflate is vendor/tiny-inflate.js; this file undoes PNG's row filters.
 *
 * ES5 on purpose: PebbleKit JS is not a modern browser.
 */
var inflate = require('./vendor/tiny-inflate');

var SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function isPng(bytes) {
  for (var i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

function paeth(a, b, c) {
  var p = a + b - c;
  var pa = Math.abs(p - a);
  var pb = Math.abs(p - b);
  var pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

/**
 * @param {Uint8Array} bytes a PNG file
 * @returns {{width: number, height: number, data: Uint8Array}} RGB pixels
 */
function decode(bytes) {
  if (!isPng(bytes)) {
    throw new Error('not a PNG');
  }
  var width = 0;
  var height = 0;
  var channels = 0;
  var parts = [];
  var total = 0;
  for (var i = 8; i + 8 <= bytes.length;) {
    var length = u32(bytes, i);
    var type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    var body = i + 8;
    if (type === 'IHDR') {
      width = u32(bytes, body);
      height = u32(bytes, body + 4);
      var depth = bytes[body + 8];
      var color = bytes[body + 9];
      var interlace = bytes[body + 12];
      channels = color === 2 ? 3 : (color === 6 ? 4 : 0);
      if (depth !== 8 || !channels || interlace !== 0) {
        throw new Error('unsupported PNG (depth ' + depth + ', color ' + color + ', interlace ' + interlace + ')');
      }
    } else if (type === 'IDAT') {
      parts.push(bytes.subarray(body, body + length));
      total += length;
    } else if (type === 'IEND') {
      break;
    }
    i = body + length + 4; // skip the CRC
  }
  // The IDAT data is one zlib stream: drop its 2-byte header, inflate the rest.
  var zlib = new Uint8Array(total);
  for (var p = 0, at = 0; p < parts.length; p++) {
    zlib.set(parts[p], at);
    at += parts[p].length;
  }
  var stride = width * channels;
  var raw = new Uint8Array(height * (stride + 1));
  inflate(zlib.subarray(2), raw);

  var rgb = new Uint8Array(width * height * 3);
  var prev = new Uint8Array(stride);
  var line = new Uint8Array(stride);
  for (var y = 0; y < height; y++) {
    var filter = raw[y * (stride + 1)];
    var src = y * (stride + 1) + 1;
    for (var x = 0; x < stride; x++) {
      var left = x >= channels ? line[x - channels] : 0;
      var up = prev[x];
      var upLeft = x >= channels ? prev[x - channels] : 0;
      var v = raw[src + x];
      if (filter === 1) {
        v += left;
      } else if (filter === 2) {
        v += up;
      } else if (filter === 3) {
        v += (left + up) >> 1;
      } else if (filter === 4) {
        v += paeth(left, up, upLeft);
      }
      line[x] = v & 0xff;
    }
    for (x = 0; x < width; x++) {
      var o = (y * width + x) * 3;
      rgb[o] = line[x * channels];
      rgb[o + 1] = line[x * channels + 1];
      rgb[o + 2] = line[x * channels + 2];
    }
    var swap = prev;
    prev = line;
    line = swap;
  }
  return { width: width, height: height, data: rgb };
}

module.exports = { decode: decode, isPng: isPng };
