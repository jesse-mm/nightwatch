/**
 * The order a painting's bytes travel to the watch in: a fixed shuffle of
 * 0..n-1, so a new painting dissolves in pixel by pixel instead of wiping down
 * from the top. Byte k of what we send is the pixel at scatter(k); the watch
 * puts it back there (scatter() in src/c/main.c: keep the two identical).
 *
 * A 4-round Feistel network on the smallest even number of bits that covers
 * n is a shuffle of 0..2^bits-1; walking it until it lands below n makes it a
 * shuffle of 0..n-1.
 */
var KEYS = [0x7f4a7c15, 0x2545f491, 0x9e3779b9, 0x6c8e9cf5];

/** 32-bit multiply, also on phones whose JavaScript lacks Math.imul. */
var imul = Math.imul || function (a, b) {
  var low = (a & 0xffff) * b;
  var high = ((a >>> 16) * b) & 0xffff;
  return (low + (high << 16)) | 0;
};

/** A function k → position, a shuffle of 0..n-1. */
function create(n) {
  var half = 1;
  while (Math.pow(2, 2 * half) < n) {
    half++;
  }
  var mask = (1 << half) - 1;
  return function (k) {
    var x = k;
    do {
      var l = x >>> half;
      var r = x & mask;
      for (var i = 0; i < 4; i++) {
        var f = imul((r + KEYS[i]) >>> 0, 0x9e3779b1) >>> (32 - half);
        var next = l ^ f;
        l = r;
        r = next;
      }
      x = (l << half) | r;
    } while (x >= n);
    return x;
  };
}

/** The bytes in the order we send them: out[k] = bytes[scatter(k)]. */
function shuffle(bytes) {
  var at = create(bytes.length);
  var out = new Uint8Array(bytes.length);
  for (var k = 0; k < bytes.length; k++) {
    out[k] = bytes[at(k)];
  }
  return out;
}

module.exports = { create: create, shuffle: shuffle };
