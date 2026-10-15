/**
 * Minimal base64 → byte array decoder. PebbleKit JS doesn't guarantee atob() or
 * binary XHR responses on every phone, so the server sends base64 text and we
 * decode it here into a plain Array (what Pebble.sendAppMessage expects).
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

module.exports = { decode: decode };
