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

/** First day of the period after the one starting on `start`. */
function nextStart(rotation, start) {
  if (rotation === 'weekly') {
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  }
  if (rotation === 'monthly') {
    return new Date(start.getFullYear(), start.getMonth() + 1, 1);
  }
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
}

/**
 * The `count` periods after the one `d` falls in, for paintings sent to the
 * watch ahead of time: `{period, start, featuredDay}` with `start` the local
 * midnight the period begins. None for "off".
 */
function upcoming(rotation, d, count) {
  var out = [];
  if (rotation === 'off') {
    return out;
  }
  var start = periodStart(rotation, d);
  for (var i = 0; i < count; i++) {
    start = nextStart(rotation, start);
    out.push({ period: period(rotation, start), start: start, featuredDay: featuredDay(rotation, start) });
  }
  return out;
}

/**
 * Whether period `a` comes after period `b` of the same rotation, e.g. the
 * watch (whose clock may run a little ahead) already hung tomorrow's painting.
 */
function isAfter(a, b) {
  var pa = String(a).split(':');
  var pb = String(b).split(':');
  return pa.length === 2 && pb.length === 2 && pa[0] === pb[0] && pa[1] > pb[1];
}

module.exports = {
  period: period,
  featuredDay: featuredDay,
  upcoming: upcoming,
  isAfter: isAfter
};
