// Per-painting looks (server/static/config/looks.js, shared with the phone).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const looks = require('../src/pkjs/looks.js');

const DEFAULTS = {
  fit: 'fill', frame: 'none', palette: 'defined', dither: 'atkinson', brightness: 0, contrast: 0, shift: 0,
  textRow: 'bottom', textCol: 'auto', timeSize: 's',
};

function memoryStorage() {
  const items = new Map();
  return { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)) };
}

describe('looks', () => {
  test('keeps only the look fields, readable', () => {
    const look = looks.encode({ ...DEFAULTS, showTime: false, frame: 'gallery', brightness: 25.4, textCol: 'start' });
    assert.deepEqual(look, { ...DEFAULTS, frame: 'gallery', brightness: 25, textCol: 'start' });
    assert.deepEqual(Object.keys(look), looks.KEYS);
  });

  test('round-trips through storage', () => {
    const look = { ...DEFAULTS, fit: 'whole', dither: 'none', contrast: -40, textRow: 'top', textCol: 'end', timeSize: 'l' };
    assert.deepEqual(looks.decode(JSON.parse(JSON.stringify(looks.encode(look))), DEFAULTS), look);
  });

  test('fills missing, unknown or bad values from the defaults', () => {
    assert.deepEqual(looks.decode({ fit: 'whole' }, DEFAULTS), { ...DEFAULTS, fit: 'whole' });
    assert.deepEqual(
      looks.decode({ frame: 'velvet', contrast: 'high', brightness: 500, sparkle: true }, DEFAULTS),
      { ...DEFAULTS, brightness: 100 },
    );
    assert.equal(looks.decode(undefined, DEFAULTS), null);
    assert.equal(looks.decode('c,w,f,g', DEFAULTS), null);
  });

  test('saves and finds looks per painting', () => {
    const storage = memoryStorage();
    assert.equal(looks.get(storage, '200108369', DEFAULTS), null);
    looks.save(storage, '200108369', { ...DEFAULTS, frame: 'gold', brightness: 10 });
    looks.save(storage, '200107756', { ...DEFAULTS, contrast: 30 });
    assert.equal(looks.get(storage, '200108369', DEFAULTS).frame, 'gold');
    assert.equal(looks.get(storage, '200107756', DEFAULTS).contrast, 30);
    const stored = JSON.parse(storage.getItem('tt-looks'));
    assert.equal(stored.version, looks.VERSION);
    assert.deepEqual(stored.looks['200108369'], { ...DEFAULTS, frame: 'gold', brightness: 10 });
  });

  test('ignores storage without a version', () => {
    const storage = memoryStorage();
    storage.setItem('tt-looks', JSON.stringify({ 200108369: DEFAULTS }));
    assert.equal(looks.get(storage, '200108369', DEFAULTS), null);
  });

  test('ignores a missing painting key and unreadable storage', () => {
    const storage = memoryStorage();
    looks.save(storage, '', DEFAULTS);
    assert.equal(storage.getItem('tt-looks'), null);
    storage.setItem('tt-looks', '{not json');
    assert.equal(looks.get(storage, 'x', DEFAULTS), null);
  });

  test('restores looks from a backup, dropping anything unusable', () => {
    const storage = memoryStorage();
    looks.save(storage, 'old', DEFAULTS);
    looks.replaceAll(storage, {
      version: 1,
      looks: { 200108369: { ...DEFAULTS, frame: 'gold' }, broken: 'nope' },
    });
    assert.deepEqual(Object.keys(looks.all(storage)), ['200108369']);
    assert.equal(looks.get(storage, '200108369', DEFAULTS).frame, 'gold');
    // A newer format than this code knows is ignored rather than misread.
    assert.deepEqual(looks.fromStored({ version: 99, looks: { a: DEFAULTS } }), {});
  });
});
