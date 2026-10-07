// services/blocklist.js — names, owner tokens and addresses we have turned away.
//
// The `blocklist` table (deploy/migrations/010). Managed by hand in SQL for
// now; an admin screen comes later. Asked on every create, every value change
// and every TXT write — REST, MCP and the dashboard alike.
//
//   name   — matched anywhere in the subdomain, so `catikteam` also stops
//            `catikteam2`. A row here is somebody's calling card, and the
//            first thing they do when refused is add a digit.
//   token  — sha256 of an anonymous owner token (subdomains.owner_token_hash),
//            exact. Stops that token's holder from writing again from any
//            address.
//   ip     — `request.ip`, exact. The weakest of the three — the 2026-10-07
//            caller came back from a new address within a day — and kept
//            because it costs nothing and buys a day.
//
// 🔴 Fail-close: no table, no answer. A query error reaches the caller as a 500
// rather than letting the request through, so the migration has to be applied
// before the application is restarted on this commit.

/**
 * @param {object} fastify
 * @param {{ name?: string|null, tokenHash?: string|null, ip?: string|null }} subject
 * @returns {Promise<{ blocked: false } | { blocked: true, kind: "name"|"token"|"ip" }>}
 */
async function checkBlocklist(fastify, { name = null, tokenHash = null, ip = null }) {
  const [rows] = await fastify.mysql.execute(
    "SELECT kind FROM blocklist WHERE " +
      "(kind = 'name' AND LOCATE(value, ?) > 0) OR " +
      "(kind = 'token' AND value = ?) OR " +
      "(kind = 'ip' AND value = ?) LIMIT 1",
    // A part not given becomes '', which matches nothing: no stored value is
    // empty (the table has a CHECK for it — an empty `name` row would be found
    // in every name).
    [name || "", tokenHash || "", ip || ""]
  );
  if (!rows.length) return { blocked: false };
  return { blocked: true, kind: rows[0].kind };
}

/**
 * What the caller is told. It does not say which of the three matched —
 * that would tell somebody being turned away which thing to change.
 */
function blockedMessage(origin) {
  return `This request was refused. If you think that is a mistake, tell us at ${origin}/abuse.`;
}

module.exports = { checkBlocklist, blockedMessage };
