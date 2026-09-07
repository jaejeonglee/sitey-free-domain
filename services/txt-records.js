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

module.exports = { liveTxtRows };
