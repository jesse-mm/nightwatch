/**
 * Minimal base64 for byte arrays. PebbleKit JS doesn't guarantee atob()/btoa(),
 * and localStorage only holds text, so cached crops are stored as base64.
 * `decode` returns a plain Array (what Pebble.sendAppMessage expects).
 */
var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var LOOKUP = {};
for (var i = 0; i < ALPHABET.length; i++) {
  LOOKUP[ALPHABET.charAt(i)] = i;
}

function decode(text) {
  var clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  var out = [];
  var buffer = 0;
  var bits = 0;
  for (var j = 0; j < clean.length; j++) {
    buffer = (buffer << 6) | LOOKUP[clean.charAt(j)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** Bytes (Array or typed array) → base64 text. */
function encode(bytes) {
  var parts = [];
  for (var j = 0; j < bytes.length; j += 3) {
    var n = (bytes[j] << 16) | ((bytes[j + 1] || 0) << 8) | (bytes[j + 2] || 0);
    parts.push(
      ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63) +
      (j + 1 < bytes.length ? ALPHABET.charAt((n >> 6) & 63) : '=') +
      (j + 2 < bytes.length ? ALPHABET.charAt(n & 63) : '=')
    );
  }
  return parts.join('');
}

module.exports = { decode: decode, encode: encode };
