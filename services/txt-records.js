/**
 * Which rows of `subdomain_txt_records` are live.
 *
 * Production has no unique key on (subdomain_id, host_prefix) — the
 * `ON DUPLICATE KEY UPDATE` in services/subdomain.js has nothing to catch on —
 * so a subdomain that re-requested a Vercel token got another row instead of
 * an updated one. Measured 2026-09-08: `jay` has two rows, `stock` has two,
 * and only one of each is the token its owner uses today.
 *
 * The newest row wins. `id` is AUTO_INCREMENT, so a larger id is a later
 * insert; the table carries no timestamp to compare instead.
 *
 * This lives here rather than inside either caller because three tools ask the
 * question and they have to agree: the backfill decides what to restore, the
 * reconciler decides what to warn about, and --prune-orphans decides what to
 * delete. When the definitions differ the tools contradict each other — the
 * backfill skipped superseded rows while the reconciler still expected them,
 * so the first run reported two records that were correctly absent.
 *
 * @param {object[]} rows - rows carrying `id`, `subdomain_id`, `host_prefix`
 * @returns {object[]} one row per (subdomain_id, host_prefix), the newest
 */
function liveTxtRows(rows) {
  const newest = new Map();
  for (const row of rows) {
    const key = `${row.subdomain_id} ${row.host_prefix}`;
    const previous = newest.get(key);
    if (!previous || row.id > previous.id) newest.set(key, row);
  }
  return [...newest.values()];
}

/**
 * The value a record holds now, for a writer about to replace or delete it —
 * the same rule as liveTxtRows (newest `id` wins), in SQL.
 *
 * 🔴 Without the ORDER BY, InnoDB answers in index order, and the index is
 * (subdomain_id, host_prefix, txt_value) — so "the previous value" was the
 * alphabetically first, which for a timestamped value is the oldest. Each
 * rewrite then removed a line that was already gone and left the real
 * previous one in the zone (catikteam, 2026-10-05). Every writer uses this.
 */
const LIVE_TXT_VALUE_SQL =
  "SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ? " +
  "ORDER BY id DESC LIMIT 1";

module.exports = { liveTxtRows, LIVE_TXT_VALUE_SQL };
