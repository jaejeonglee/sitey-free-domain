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
// Dates are MySQL's (CURDATE() / NOW()), never Node's: one clock decides what
// day a visit belongs to, so the app and the database cannot disagree about
// where a month starts. A batch that straddles midnight lands on the day it
// was flushed, which is off by at most one interval.
const config = require("../configs/index");

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
 * @returns {Promise<{written: number, failed: number}>}
 */
async function flush(fastify) {
  if (pending.size === 0) return { written: 0, failed: 0 };

  const batch = [...pending.entries()];
  pending.clear();

  let written = 0;
  let failed = 0;
  let lastError = null;

  for (const [subdomainId, hits] of batch) {
    try {
      await fastify.mysql.execute(
        "INSERT INTO redirect_hits (subdomain_id, hit_day, hits, last_hit_at) " +
          "VALUES (?, CURDATE(), ?, NOW()) " +
          "ON DUPLICATE KEY UPDATE hits = hits + VALUES(hits), last_hit_at = VALUES(last_hit_at)",
        [subdomainId, hits]
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
  try {
    const [result] = await fastify.mysql.execute(
      "DELETE FROM redirect_hits WHERE hit_day < DATE_SUB(CURDATE(), INTERVAL ? DAY)",
      [days]
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
 * "This month" is the calendar month by the database's clock, computed in the
 * same statement as the total so the two cannot be read a millisecond apart
 * across a month boundary.
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
        "SUM(CASE WHEN hit_day >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN hits ELSE 0 END) AS this_month, " +
        "MAX(last_hit_at) AS last_at " +
        `FROM redirect_hits WHERE subdomain_id IN (${placeholders}) GROUP BY subdomain_id`,
      ids
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
  record,
  flush,
  start,
  stop,
  prune,
  hitsFor,
  pendingCount,
  clear,
};
