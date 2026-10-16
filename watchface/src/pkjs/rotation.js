/**
 * When to hang a new painting, and which Featured painting belongs to a date.
 *
 * Featured is a list of 365 paintings, one per day of the year (0-based). A
 * weekly or monthly rotation shows the Featured painting of the period's first
 * day, so every rotation walks through the same year in step.
 *
 * ES5 on purpose: PebbleKit JS is not a modern browser.
 */

var DAY_MS = 86400000;

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function ymd(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** Day of the year, 0 = 1 January (local time, DST-safe). */
function dayOfYear(d) {
  var start = Date.UTC(d.getFullYear(), 0, 1);
  var day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day - start) / DAY_MS);
}

/** The Monday of `d`'s week (weeks start on Monday). */
function weekStart(d) {
  var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return monday;
}

/** First day of the period `d` falls in. */
function periodStart(rotation, d) {
  if (rotation === 'weekly') {
    return weekStart(d);
  }
  if (rotation === 'monthly') {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * A key that changes exactly when a new painting is due, e.g. "daily:2026-10-16".
 * "off" never changes.
 */
function period(rotation, d) {
  if (rotation === 'off') {
    return 'off';
  }
  return rotation + ':' + ymd(periodStart(rotation, d));
}

/**
 * Index into the Featured list for this period. A week that starts in
 * December and runs into January keeps its December painting.
 */
function featuredDay(rotation, d) {
  return dayOfYear(periodStart(rotation === 'off' ? 'daily' : rotation, d));
}

module.exports = {
  period: period,
  featuredDay: featuredDay
};
