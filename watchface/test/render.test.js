// Tests for the shared renderer (site/render.js), run with
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
  const gray = new Uint8Array(144 * 168 * 3).fill(128);

  test('returns stride × height watch bytes', () => {
    assert.equal(render.compose(gray, 144, 168, opts).length, 144 * 168);
  });

  test('pads rows to a wider stride', () => {
    assert.equal(render.compose(gray, 144, 168, { ...opts, stride: 160 }).length, 160 * 168);
  });

  test('draws the frame on the screen edge', () => {
    const out = render.compose(gray, 144, 168, { ...opts, frame: 'gallery' });
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

describe('toScreenRGBA', () => {
  const white = render.gcolor8([255, 255, 255]);
  const black = render.gcolor8([0, 0, 0]);

  test('shows exact colors for "pixels"', () => {
    const bytes = Uint8Array.of(white, black);
    assert.deepEqual(render.toScreenRGBA(bytes, 2, 1, 2, 'pixels'), render.toRGBA(bytes, 2, 1, 2));
  });

  test('keeps indoor whites below pure white, like paper', () => {
    const [r, g, b] = render.toScreenRGBA(Uint8Array.of(white), 1, 1, 1, 'room');
    assert.ok(Math.max(r, g, b) <= 232 && Math.min(r, g, b) > 150, `white looks like ${[r, g, b]}`);
  });

  test('keeps blacks above pure black', () => {
    const [r, g, b] = render.toScreenRGBA(Uint8Array.of(black), 1, 1, 1, 'room');
    assert.ok(Math.min(r, g, b) >= 18, `black looks like ${[r, g, b]}`);
  });

  test('tints the backlight blue', () => {
    const [r, , b] = render.toScreenRGBA(Uint8Array.of(white), 1, 1, 1, 'backlight');
    assert.ok(b > r, `backlit white looks like ${r}, ${b}`);
  });
});

describe('color adjustments', () => {
  const opts = { w: 8, h: 8, stride: 8, round: false, fit: 'fill', frame: 'none', palette: 'defined' };
  const gray = (v) => new Uint8Array(8 * 8 * 3).fill(v);
  const distinct = (bytes) => new Set(bytes).size;

  test('adjust leaves pixels alone at 0 brightness and contrast', () => {
    assert.deepEqual(render.adjust(Uint8Array.of(10, 128, 250), 0, 0), Uint8Array.of(10, 128, 250));
  });

  test('brightness 100 lifts mid-gray to white', () => {
    assert.equal(render.adjust(Uint8Array.of(128), 100, 0)[0], 255);
  });

  test('contrast -100 flattens everything to mid-gray', () => {
    assert.deepEqual(Array.from(render.adjust(Uint8Array.of(0, 255), 0, -100)), [128, 128]);
  });

  test('"none" dithering gives a flat color for a flat gray', () => {
    assert.equal(distinct(render.compose(gray(100), 8, 8, { ...opts, dither: 'none' })), 1);
  });

  test('"checker" mixes two colors in a chessboard for an in-between gray', () => {
    const out = render.compose(gray(128), 8, 8, { ...opts, dither: 'checker' });
    assert.equal(distinct(out), 2);
    assert.notEqual(out[0], out[1]);
    assert.equal(out[0], out[9]);
  });

  test('unknown dithering falls back to Atkinson', () => {
    assert.deepEqual(
      render.compose(gray(100), 8, 8, { ...opts, dither: 'whatever' }),
      render.compose(gray(100), 8, 8, opts)
    );
  });
});
