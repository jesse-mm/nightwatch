// The catalog bundle (site/catalog.js) and the phone's PNG
// decoder (watchface/src/pkjs/png.js).
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const Catalog = require('../src/pkjs/catalog.js');
const png = require('../src/pkjs/png.js');

const manifest = {
  version: 2,
  id: 'abc123',
  iiifPrefix: 'https://iiif.micr.io/',
  webPrefix: 'https://www.rijksmuseum.nl/en/collection/',
  eras: ['pre1600', '1600s', '1700s', '1800s', '1900s'],
  licenses: [['Public domain', 'https://creativecommons.org/publicdomain/mark/1.0/']],
  screens: [[144, 168, false], [180, 180, true], [200, 228, false], [260, 260, true]],
  slack: 20,
  files: [
    { pool: 'featured', file: 'featured.json', count: 2 },
    { pool: '1600s', file: '1600s.json', count: 1 },
    { pool: '1800s', file: '1800s.json', count: 1 },
    { pool: 'undated', file: 'undated.json', count: 0 },
  ],
};
// Wide (2:1): Cover slides sideways; planned view 20 px into the crop.
const wide = ['1', 'aaaaa', 'Wide', 'A', '1650', 'SK-A-1', 2, 0, 2,
  [0.25, 0, 0.5, 1, 20, 0.2, 0, 0.6, 1, 20, 0.25, 0, 0.5, 1, 20, 0.2, 0, 0.6, 1, 20]];
// Tall (1:2): Cover slides up and down, kept at the top.
const tall = ['2', 'bbbbb', 'Portrait of B', 'B', null, 'SK-C-5', 8, 0, 0.5,
  [0, 0, 1, 0.7, 0, 0, 0, 1, 0.6, 0, 0, 0, 1, 0.7, 0, 0, 0, 1, 0.6, 0]];
const files = {
  featured: { version: 2, id: 'abc123', pool: 'featured', paintings: [tall, wide] },
  '1600s': { version: 2, id: 'abc123', pool: '1600s', paintings: [wide] },
  '1800s': { version: 2, id: 'abc123', pool: '1800s', paintings: [tall] },
};

/** A catalog with every file loaded. */
function full() {
  const cat = Catalog.create(manifest);
  Object.values(files).forEach((f) => cat.add(f));
  return cat;
}
const catalog = full();

describe('catalog', () => {
  test('looks paintings up and builds their links', () => {
    const p = catalog.get('2');
    assert.equal(p.title, 'Portrait of B');
    assert.equal(p.webUrl, 'https://www.rijksmuseum.nl/en/collection/SK-C-5');
    assert.equal(p.iiifBase, 'https://iiif.micr.io/bbbbb');
    assert.equal(p.license, 'Public domain');
    assert.equal(catalog.get('nope'), null);
  });

  test('Featured by day, wrapping around', () => {
    assert.equal(catalog.featured(0).key, '2');
    assert.equal(catalog.featured(3).key, '1');
  });

  test('random from a pool', () => {
    assert.equal(catalog.random('1600s', () => 0.9).key, '1');
    assert.equal(catalog.random('1800s', () => 0).key, '2');
  });

  test('picks the pool for an era, or one in proportion to its size for any', () => {
    assert.equal(catalog.poolFor('1800s'), '1800s');
    assert.equal(catalog.poolFor('any', () => 0), '1600s');
    assert.equal(catalog.poolFor('any', () => 0.99), '1800s');
    assert.equal(catalog.fileFor('1600s'), '1600s.json');
  });

  test('starts empty and loads only the files it is given', () => {
    const cat = Catalog.create(manifest);
    assert.equal(cat.featured(0), null);
    assert.equal(cat.has('featured'), false);
    assert.ok(cat.add(files.featured));
    assert.equal(cat.featured(0).key, '2');
    assert.equal(cat.random('1600s'), null); // its file isn't loaded
  });

  test('ignores files from another catalog version', () => {
    const cat = Catalog.create(manifest);
    assert.equal(cat.add({ ...files['1600s'], id: 'other' }), false);
    assert.equal(cat.get('1'), null);
  });

  test('takes single rows, e.g. the painting on the watch', () => {
    const cat = Catalog.create(manifest);
    cat.addRow(full().row('2'));
    assert.equal(cat.get('2').title, 'Portrait of B');
    assert.ok(cat.cropRequest('2', { w: 200, h: 228, round: 0 }, 'fill'));
  });

  test('resolves object numbers, keys and links', () => {
    assert.equal(catalog.resolve('sk-c-5').key, '2');
    assert.equal(catalog.resolve(' 1 ').key, '1');
    assert.equal(catalog.resolve('https://www.rijksmuseum.nl/en/collection/SK-A-1?x=1#top').key, '1');
    assert.equal(catalog.resolve('SK-Z-99'), null);
  });

  test('asks IIIF for exactly the planned Cover view at screen size', () => {
    // Wide 2:1 painting on a 200x228 screen: the view is full height and
    // (200/228)/2 of the width; the plan puts it 20 px into its crop.
    const r = catalog.cropRequest('1', { w: 200, h: 228, round: 0 }, 'fill');
    assert.deepEqual([r.width, r.height], [200, 228]);
    const v = catalog.coverView('1', { w: 200, h: 228, round: 0 });
    assert.equal(v.h, 1);
    assert.ok(Math.abs(v.w - 200 / 228 / 2) < 1e-9);
    assert.ok(Math.abs(v.x - (0.25 + (20 / 228) * 0.5)) < 1e-9);
    assert.match(r.url, /^https:\/\/iiif\.micr\.io\/aaaaa\/pct:[\d.]+,0,[\d.]+,100\/200,228\/0\/default\.png$/);
  });

  test('zoom and focus move the Cover view, kept inside the painting', () => {
    const screen = { w: 260, h: 260, round: 1 };
    const zoomed = catalog.coverView('2', screen, { zoom: 200, focusX: 5000, focusY: 0 });
    // Tall 1:2 painting: at 100% the view is the full width and half the height.
    assert.deepEqual([zoomed.w, zoomed.h], [0.5, 0.25]);
    assert.deepEqual([zoomed.x, zoomed.y], [0.25, 0]); // clamped to the top
    const corner = catalog.coverView('2', screen, { zoom: 200, focusX: 10000, focusY: 10000 });
    assert.deepEqual([corner.x, corner.y], [0.5, 0.75]);
    // At 100% the full-width axis can't move.
    assert.equal(catalog.coverView('2', screen, { zoom: 100, focusX: 0 }).x, 0);
  });

  test('the work image is the whole painting at twice the cover size', () => {
    assert.deepEqual(catalog.workImage('1', { w: 200, h: 228, round: 0 }, 200),
      { url: 'https://iiif.micr.io/aaaaa/full/912,456/0/default.png', width: 912, height: 456 });
  });

  test('the work image is at most 1280 pixels long', () => {
    const big = Catalog.create(manifest);
    big.addRow(['p', 'ppppp', 'Panorama', 'A', null, 'SK-A-9', 0, 0, 10, wide[9]]);
    assert.deepEqual(big.workImage('p', { w: 260, h: 260, round: 1 }, 200),
      { url: 'https://iiif.micr.io/ppppp/full/1280,128/0/default.png', width: 1280, height: 128 });
  });

  test('asks IIIF for the whole painting for Contain', () => {
    const r = catalog.cropRequest('1', { w: 200, h: 228, round: 0 }, 'whole');
    assert.deepEqual([r.width, r.height], [200, 100]);
    assert.equal(r.url, 'https://iiif.micr.io/aaaaa/full/200,100/0/default.png');
  });
});

/** A PNG with the given filter per row, built with Node's zlib. */
function makePng(w, h, channels, pixel, filters) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) pixel(x, y).slice(0, channels).forEach((v, c) => (row[x * channels + c] = v));
    rows.push(row);
    const prev = y ? rows[y - 1] : Buffer.alloc(stride);
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f];
      raw[y * (stride + 1) + 1 + i] = (row[i] - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

describe('png', () => {
  const pixel = (x, y) => [(x * 37 + y) & 255, (y * 53) & 255, (x * y) & 255, 200];
  const expected = (w, h) => {
    const out = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(...pixel(x, y).slice(0, 3));
    return out;
  };

  test('decodes RGB with every row filter', () => {
    const img = png.decode(makePng(9, 7, 3, pixel, [0, 1, 2, 3, 4]));
    assert.deepEqual([img.width, img.height], [9, 7]);
    assert.deepEqual(Array.from(img.data), expected(9, 7));
  });

  test('decodes RGBA to RGB', () => {
    assert.deepEqual(Array.from(png.decode(makePng(5, 4, 4, pixel, [4, 2])).data), expected(5, 4));
  });

  test('rejects anything that is not a PNG', () => {
    assert.equal(png.isPng(new Uint8Array([0xff, 0xd8, 0xff])), false);
    assert.throws(() => png.decode(new Uint8Array([1, 2, 3])), /not a PNG/);
  });
});
