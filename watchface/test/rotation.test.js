// Rotation periods (src/pkjs/rotation.js), including the upcoming periods
// the phone sends to the watch ahead of time.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const rotation = require('../src/pkjs/rotation.js');

describe('upcoming', () => {
  test('daily: the next days, at local midnight', () => {
    const next = rotation.upcoming('daily', new Date(2026, 11, 30, 15, 0), 3);
    assert.deepEqual(next.map((p) => p.period), ['daily:2026-12-31', 'daily:2027-01-01', 'daily:2027-01-02']);
    assert.deepEqual(next.map((p) => p.featuredDay), [364, 0, 1]);
    assert.equal(next[0].start.getTime(), new Date(2026, 11, 31).getTime());
  });

  test('weekly: the following Mondays', () => {
    // Friday 6 November 2026.
    const next = rotation.upcoming('weekly', new Date(2026, 10, 6, 9, 30), 2);
    assert.deepEqual(next.map((p) => p.period), ['weekly:2026-11-09', 'weekly:2026-11-16']);
    assert.equal(next[0].featuredDay, rotation.featuredDay('weekly', new Date(2026, 10, 9)));
  });

  test('monthly: the following firsts, across the year', () => {
    const next = rotation.upcoming('monthly', new Date(2026, 10, 30), 3);
    assert.deepEqual(next.map((p) => p.period), ['monthly:2026-12-01', 'monthly:2027-01-01', 'monthly:2027-02-01']);
  });

  test('each upcoming period is the period of its own start', () => {
    for (const r of ['daily', 'weekly', 'monthly']) {
      for (const p of rotation.upcoming(r, new Date(2026, 2, 28), 4)) {
        assert.equal(rotation.period(r, p.start), p.period);
      }
    }
  });

  test('isAfter compares periods of one rotation', () => {
    assert.equal(rotation.isAfter('daily:2026-11-07', 'daily:2026-11-06'), true);
    assert.equal(rotation.isAfter('daily:2026-11-06', 'daily:2026-11-06'), false);
    assert.equal(rotation.isAfter('daily:2026-11-05', 'daily:2026-11-06'), false);
    assert.equal(rotation.isAfter('monthly:2026-12-01', 'monthly:2026-11-01'), true);
    assert.equal(rotation.isAfter('weekly:2026-11-09', 'daily:2026-11-06'), false);
    assert.equal(rotation.isAfter('off', 'daily:2026-11-06'), false);
    assert.equal(rotation.isAfter(undefined, 'daily:2026-11-06'), false);
  });

  test('off has nothing to send ahead', () => {
    assert.deepEqual(rotation.upcoming('off', new Date(), 3), []);
  });
});
