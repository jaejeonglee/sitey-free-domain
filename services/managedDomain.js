const config = require("../configs/index");

function normalizeDomainName(name = "") {
  return String(name).trim().toLowerCase();
}

/**
 * The host inside publicOrigin — the domain decided canonical on 2026-09-07.
 *
 * Read rather than written down here on purpose: the canonical domain is one
 * decision and it already has a home in config. Spelling "sitey.my" a second
 * time in this file would mean a future change has two places to land, and the
 * one nobody remembers is this one.
 */
function canonicalHost() {
  try {
    return normalizeDomainName(new URL(config.server.publicOrigin).hostname);
  } catch {
    return null;
  }
}

/**
 * Active domains, canonical first.
 *
 * Order matters because the home page builds its picker from this list and the
 * first entry becomes the default selection — which is why `sitey.one` sat on
 * the top row until now (Jay, 2026-09-11). Nothing chose it; it was simply the
 * oldest row, and the query had no ORDER BY at all, so even the rest of the
 * list was whatever the table felt like returning.
 *
 * The remainder is alphabetical so the list stops changing under people.
 */
async function getManagedDomains(fastify) {
  const [rows] = await fastify.mysql.execute(
    "SELECT id, domain_name FROM managed_domains WHERE is_active = 1 ORDER BY domain_name"
  );

  const domains = rows.map((row) => ({
    id: row.id,
    domain: row.domain_name,
    normalized: normalizeDomainName(row.domain_name),
  }));

  const canonical = canonicalHost();
  if (!canonical) return domains;

  return [
    ...domains.filter((d) => d.normalized === canonical),
    ...domains.filter((d) => d.normalized !== canonical),
  ];
}

module.exports = { getManagedDomains, canonicalHost };
