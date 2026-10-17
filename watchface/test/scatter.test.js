// The shuffled order a painting travels to the watch in (src/pkjs/scatter.js;
// the watch has the same function in src/c/main.c).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const scatter = require('../src/pkjs/scatter.js');

// Screen bytes per platform: basalt, chalk, emery, gabbro.
const SIZES = [144 * 168, 180 * 180, 200 * 228, 260 * 260];

describe('scatter', () => {
  test('puts every byte in its own place', () => {
    for (const n of [1, 2, 3, 1000, ...SIZES]) {
      const at = scatter.create(n);
      const seen = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const p = at(k);
        assert.ok(p >= 0 && p < n && !seen[p], `n=${n}: position ${p} for byte ${k}`);
        seen[p] = 1;
      }
    }
  });

  test('matches the watch', () => {
    // Positions of bytes 0, 1, 2 and 1000 from the C scatter() in main.c,
    // compiled and run on a computer. If these change, the watch must too.
    const expected = {
      [144 * 168]: [15771, 21314, 23740, 11016],
      [180 * 180]: [15771, 21314, 23740, 11016],
      [200 * 228]: [15771, 21314, 23740, 42026],
      [260 * 260]: [20453, 49918, 28324, 22599],
    };
    for (const n of SIZES) {
      const at = scatter.create(n);
      assert.deepEqual([0, 1, 2, 1000].map(at), expected[n], `n=${n}`);
    }
  });

  test('shuffle sends byte k from scatter(k)', () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const sent = scatter.shuffle(bytes);
    const at = scatter.create(bytes.length);
    const back = new Uint8Array(bytes.length);
    for (let k = 0; k < sent.length; k++) back[at(k)] = sent[k];
    assert.deepEqual(back, bytes);
  });
});
