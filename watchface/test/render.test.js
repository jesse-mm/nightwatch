// Tests for the shared renderer (server/static/config/render.js), run with
// `npm test`. Golden fixtures come from the Rust generator's original
// implementation (imaging.rs `write_js_fixtures`), so the port must match it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const render = require('../src/pkjs/render.js');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/render.json', import.meta.url)));
const SCREENS = [[144, 168, false], [180, 180, true], [200, 228, false], [260, 260, true]];

describe('dither', () => {
  for (const [palette, expected] of Object.entries(fixture.dither)) {
    test(`matches the Rust generator exactly with the "${palette}" tuning`, () => {
      const idx = render.dither(new Uint8Array(fixture.rgb), fixture.width, fixture.height, palette);
      const bytes = Array.from(idx, (i) => render.GCOLOR[i]);
      assert.deepEqual(bytes, expected);
    });
  }
});

describe('frames', () => {
  for (const [name, expected] of Object.entries(fixture.frames)) {
    const [frame, size] = name.split('-');
    const [w, h] = size.split('x').map(Number);
    const round = SCREENS.find(([sw, sh]) => sw === w && sh === h)[2];

    test(`${frame} on ${size} has the Rust border width`, () => {
      assert.equal(render.frameBorder(frame, w, h), expected.border);
    });

    test(`${frame} on ${size} draws the same pixels as Rust`, () => {
      const map = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          map.set(render.framePixel(frame, x, y, w, h, round) || [255, 0, 255], (y * w + x) * 3);
        }
      }
      assert.equal(createHash('sha256').update(map).digest('hex'), expected.sha256);
    });
  }

  test('no frame has no border', () => {
    assert.equal(render.frameBorder('none', 144, 168), 0);
  });
});

describe('fitArt', () => {
  const crop = (w, h) => new Uint8Array(w * h * 3).fill(128);

  test('keeps a crop that already fits untouched', () => {
    const c = crop(144, 168);
    assert.equal(render.fitArt(c, 144, 168, 144, 168, 'fill').rgb, c);
  });

  test('fill covers the whole frame opening', () => {
    const art = render.fitArt(crop(144, 168), 144, 168, 120, 144, 'fill');
    assert.deepEqual([art.w, art.h, art.rgb.length], [120, 144, 120 * 144 * 3]);
  });

  test('whole keeps the painting inside the opening and its proportions', () => {
    const art = render.fitArt(crop(144, 96), 144, 96, 120, 144, 'whole');
    assert.deepEqual([art.w, art.h], [120, 80]);
  });
});

describe('compose', () => {
  const opts = { w: 144, h: 168, stride: 144, round: false, fit: 'fill', frame: 'none', palette: 'defined' };
  const grey = new Uint8Array(144 * 168 * 3).fill(128);

  test('returns stride × height watch bytes', () => {
    assert.equal(render.compose(grey, 144, 168, opts).length, 144 * 168);
  });

  test('pads rows to a wider stride', () => {
    assert.equal(render.compose(grey, 144, 168, { ...opts, stride: 160 }).length, 160 * 168);
  });

  test('draws the frame on the screen edge', () => {
    const out = render.compose(grey, 144, 168, { ...opts, frame: 'gallery' });
    assert.equal(out[0], render.gcolor8(render.framePixel('gallery', 0, 0, 144, 168, false)));
  });

  test('fills letterbox bars with the frame background', () => {
    const wide = new Uint8Array(144 * 80 * 3).fill(128);
    const out = render.compose(wide, 144, 80, { ...opts, fit: 'whole' });
    assert.equal(out[0], render.gcolor8([0, 0, 0]));
  });

  test('renders the largest screen quickly', () => {
    const big = new Uint8Array(260 * 260 * 3).map((_, i) => (i * 37) % 256);
    const start = performance.now();
    render.compose(big, 260, 260, { ...opts, w: 260, h: 260, stride: 260, round: true, frame: 'gold', palette: 'sun' });
    const ms = performance.now() - start;
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });
});
