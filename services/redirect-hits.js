// services/redirect-hits.js — counting the visits a REDIRECT name answers.
//
// 🔴 Two rules shape everything here, and both are about what this must never
// cost the visitor:
//
//   1. The 301 goes out first. Counting happens after the reply has been
//      handed over, and a failure is swallowed with a warn. Nobody's link
//      breaks because a number could not be written down.
//   2. One visit is not one UPDATE. A link that gets shared somewhere busy
//      would otherwise turn every visitor into a database write on the path
//      of a request that has already been answered. Visits accumulate in a
//      Map here and are written in one batch every redirect.hitFlushMs.
//
// The price of (2) is stated plainly: **a crash loses up to one flush
// interval of counts** — ten seconds by default, and the same again for
// whatever arrived during a flush that failed. That is the right trade
// because this number is shown to a person on their dashboard, not billed
// against anybody. A count that is a few visits light is worth less than a
// redirect that was slow, and far less than one that failed.
//
// The day a visit belongs to is Seoul's, and it is worked out here rather than
// asked of MySQL. CURDATE() reads the server's `time_zone`, which is SYSTEM =
// UTC on this machine: "today" on somebody's dashboard began at nine in the
// morning, and every visit between midnight and 09:00 on the 1st was counted
// against the month before. Nine hours is not a rounding error on a number
// somebody reads to see whether their link works.
//
// kstDay() does it from a UTC instant plus a fixed offset — Korea has no
// daylight saving — so the answer depends on neither the database's timezone
// nor the process's, and one function answers "what day is it" for the write,
// for "this month" and for the nightly delete. A batch that straddles midnight
// lands on the day it was flushed, which is off by at most one interval.
//
// 🔴 Rows written before 2026-09-18 hold UTC days and are left as they are.
// A row is a total, not the visits inside it, so re-cutting one along the
// nine-hour seam would mean inventing where within the day those visits fell.
// Two days of counting (the table was created 2026-09-16) have a blurred
// boundary; everything from here on is the day it says it is.
const config = require("../configs/index");

// KST is UTC+9 the whole year round.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * The calendar day in Seoul, shaped as MySQL wants a DATE: "2026-09-18".
 *
 * Exported for the test that pins the boundary — 2026-08-31T15:30Z is already
 * September in Seoul, and that is the case the old code got wrong.
 */
function kstDay(at = new Date()) {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The 1st of the Seoul month `at` falls in. What "this month" counts from. */
function kstMonthStart(at = new Date()) {
  return `${kstDay(at).slice(0, 7)}-01`;
}

/** subdomain_id → visits counted since the last successful flush. */
const pending = new Map();

let timer = null;

/**
 * Note one visit. Synchronous and in memory — this is what runs on the
 * request path, and it does nothing that can wait on anything.
 */
function record(subdomainId) {
  if (!subdomainId) return;
  pending.set(subdomainId, (pending.get(subdomainId) || 0) + 1);
}

/** How many names are waiting to be written. For tests and for the log line. */
function pendingCount() {
  return pending.size;
}

/** Throw away what has not been written. Tests only. */
function clear() {
  pending.clear();
}

/**
 * Write everything counted so far.
 *
 * The map is emptied *before* the first query, so visits arriving during the
 * flush are counted towards the next one rather than being written twice or
 * lost to the `clear()` at the end.
 *
 * Each name is its own statement and its own try: a row whose subdomain was
 * deleted a moment ago fails its foreign key, and that must not take the other
 * 43 names' counts down with it. Failures are counted and reported in one warn
 * line — one per name would turn a database outage into a log flood.
 *
 * `last_hit_at` is a Date rather than NOW(): mysql2 converts a Date on the way
 * in and back out through the same connection timezone, so the instant that
 * comes back is the instant that went in whatever the two clocks are set to.
 * It is a moment, not a day — the dashboard renders it in the reader's own
 * timezone — so it is not shifted to Seoul the way `hit_day` is.
 *
 * @returns {Promise<{written: number, failed: number}>}
 */
async function flush(fastify) {
  if (pending.size === 0) return { written: 0, failed: 0 };

  const batch = [...pending.entries()];
  pending.clear();

  // One day and one instant for the whole batch: these visits were counted
  // within one flush interval of each other, and asking twice inside the loop
  // would let a batch that crosses midnight land on two different days.
  const day = kstDay();
  const at = new Date();

  let written = 0;
  let failed = 0;
  let lastError = null;

  for (const [subdomainId, hits] of batch) {
    try {
      await fastify.mysql.execute(
        "INSERT INTO redirect_hits (subdomain_id, hit_day, hits, last_hit_at) " +
          "VALUES (?, ?, ?, ?) " +
          "ON DUPLICATE KEY UPDATE hits = hits + VALUES(hits), last_hit_at = VALUES(last_hit_at)",
        [subdomainId, day, hits, at]
      );
      written += 1;
    } catch (err) {
      failed += 1;
      lastError = err;
    }
  }

  if (failed > 0) {
    // Dropped, not retried. Re-queueing would hold a growing map against a
    // database that is not answering, and the thing being protected is the
    // redirect, not the count.
    fastify.log.warn(
      { evt: "redirect_hits", action: "flush_failed", names: failed, err: lastError },
      `Redirect counts: ${failed} of ${batch.length} could not be written and were dropped`
    );
  }

  return { written, failed };
}

/**
 * Start the flush timer.
 *
 * `unref()` so a process with nothing else to do can still exit — the timer is
 * bookkeeping, not work anybody is waiting for.
 */
function start(fastify) {
  if (timer) return;
  timer = setInterval(() => {
    flush(fastify).catch((err) => {
      fastify.log.warn({ evt: "redirect_hits", err }, "Redirect counts: flush threw");
    });
  }, config.redirect.hitFlushMs);
  timer.unref?.();
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Delete day rows older than the retention window.
 *
 * Runs with the other nightly work (plugins/reconciler.js). 400 days rather
 * than 365: a year-on-year comparison needs slightly more than a year, and a
 * few weeks of slack means a job missed over a holiday does not cut into it.
 */
async function prune(fastify) {
  const days = config.redirect.hitRetentionDays;
  // The cutoff is a Seoul day like the rows it is compared against. Left to
  // DATE_SUB(CURDATE(), …) it would be a UTC one, and a day-wide disagreement
  // at the far end of a 400-day window is how "one clock" quietly becomes two.
  const before = kstDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  try {
    const [result] = await fastify.mysql.execute(
      "DELETE FROM redirect_hits WHERE hit_day < ?",
      [before]
    );
    const removed = result?.affectedRows ?? 0;
    if (removed > 0) {
      fastify.log.info(
        { evt: "redirect_hits", action: "prune", removed, days },
        `Redirect counts: removed ${removed} day rows older than ${days} days`
      );
    }
    return removed;
  } catch (err) {
    // Nothing downstream depends on this having happened; the table grows by
    // a few rows a day until somebody reads the warning.
    fastify.log.warn(
      { evt: "redirect_hits", action: "prune_failed", err },
      "Redirect counts: could not remove old day rows"
    );
    return 0;
  }
}

/**
 * What to show for a set of REDIRECT records.
 *
 * Every id asked for comes back, zeroed if it has never been visited: a
 * missing field would read as "we failed to load this" where the truth is
 * "nobody has clicked it", and those are different things to say to somebody
 * who just made a link.
 *
 * "This month" is the calendar month in Seoul — the same reckoning the rows
 * were written under — and it is computed in the same statement as the total
 * so the two cannot be read a millisecond apart across a month boundary.
 *
 * @returns {Promise<Map<number, {total:number, this_month:number, last_at:Date|null}>>}
 */
async function hitsFor(fastify, subdomainIds) {
  const ids = [...new Set(subdomainIds.filter(Boolean))];
  const out = new Map(ids.map((id) => [id, { total: 0, this_month: 0, last_at: null }]));
  if (ids.length === 0) return out;

  try {
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await fastify.mysql.execute(
      "SELECT subdomain_id, SUM(hits) AS total, " +
        "SUM(CASE WHEN hit_day >= ? THEN hits ELSE 0 END) AS this_month, " +
        "MAX(last_hit_at) AS last_at " +
        `FROM redirect_hits WHERE subdomain_id IN (${placeholders}) GROUP BY subdomain_id`,
      [kstMonthStart(), ...ids]
    );
    for (const row of rows) {
      // SUM over BIGINT comes back from mysql2 as a string; a JSON number is
      // what every caller of this expects.
      out.set(row.subdomain_id, {
        total: Number(row.total) || 0,
        this_month: Number(row.this_month) || 0,
        last_at: row.last_at || null,
      });
    }
  } catch (err) {
    // Zeros, and a warn. A listing that 500s because a counter table is
    // missing would take the whole dashboard down over a decoration.
    fastify.log.warn(
      { evt: "redirect_hits", action: "read_failed", err },
      "Redirect counts: could not be read; showing zero"
    );
  }

  return out;
}

module.exports = {
  kstDay,
  record,
  flush,
  start,
  stop,
  prune,
  hitsFor,
  pendingCount,
  clear,
};
