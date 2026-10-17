// Per-painting looks (watchface/src/pkjs/looks.js).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const looks = require('../src/pkjs/looks.js');

const DEFAULTS = {
  fit: 'fill', frame: 'none', palette: 'defined', dither: 'atkinson', brightness: 0, contrast: 0,
  textRow: 'bottom', textCol: 'auto', timeSize: 's',
};

function memoryStorage() {
  const items = new Map();
  return { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)) };
}

describe('looks', () => {
  test('round-trips a look through its compact form', () => {
    const look = { ...DEFAULTS, fit: 'whole', frame: 'gallery', dither: 'none', brightness: 25, contrast: -40, textRow: 'top', textCol: 'left', timeSize: 'l' };
    const text = looks.encode(look);
    assert.equal(text, '1,3,0,2,25,-40,1,1,2');
    assert.deepEqual(looks.decode(text, DEFAULTS), look);
  });

  test('only keeps look fields', () => {
    assert.deepEqual(Object.keys(looks.decode(looks.encode({ ...DEFAULTS, showTime: false }), DEFAULTS)), looks.KEYS);
  });

  test('fills missing or bad parts from the defaults', () => {
    assert.deepEqual(looks.decode('1,9', DEFAULTS), { ...DEFAULTS, fit: 'whole' });
    assert.deepEqual(looks.decode('', DEFAULTS), DEFAULTS);
    assert.equal(looks.decode('0,0,0,0,500', DEFAULTS).brightness, 100);
  });

  test('saves and finds looks per painting', () => {
    const storage = memoryStorage();
    assert.equal(looks.get(storage, '200108369', DEFAULTS), null);
    looks.save(storage, '200108369', { ...DEFAULTS, frame: 'gold', brightness: 10 });
    looks.save(storage, '200107756', { ...DEFAULTS, contrast: 30 });
    assert.equal(looks.get(storage, '200108369', DEFAULTS).frame, 'gold');
    assert.equal(looks.get(storage, '200107756', DEFAULTS).contrast, 30);
    assert.deepEqual(JSON.parse(storage.getItem('tt-looks')), {
      200108369: '0,1,0,0,10,0,0,0,0',
      200107756: '0,0,0,0,0,30,0,0,0',
    });
  });

  test('ignores a missing painting key and unreadable storage', () => {
    const storage = memoryStorage();
    looks.save(storage, '', DEFAULTS);
    assert.equal(storage.getItem('tt-looks'), null);
    storage.setItem('tt-looks', '{not json');
    assert.equal(looks.get(storage, 'x', DEFAULTS), null);
  });
});
