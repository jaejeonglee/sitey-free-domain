// services/quota.js — how many subdomains one subject may hold.
//
// One number for everybody. The axis is "how many", not "person or agent":
// somebody holding eleven names for a company and an agent doing the same job
// are the same customer with the same wallet behind them, and two different
// allowances would only mean the cheaper one gets claimed. An agent-created
// record is counted and refused exactly like a person's.
//
// 🔴 Nothing is refused by default. With `SUBDOMAIN_LIMIT_ENFORCED` off — and
// it is off — a request over the limit is written to the log as the refusal it
// would have been, and then allowed through.
//
// That log line is what this file is for. There is no data at all on whether
// anyone wants more than three subdomains: the numbers we have say three
// accounts are over a limit of three and two of them are exceptions we intend
// to grant, so switching a real block on today would cost real users for a
// demand nobody has shown exists. Counting first answers the question at no
// cost to anybody; if the count stays at zero, the answer is that there is
// nothing to sell here, and that is worth knowing too.
//
// Nothing in here removes or touches a record that already exists. The limit
// is asked about the *next* subdomain and never about the last one — this
// service has taken names away from people once already by accident, and
// three accounts would be over the line the day it was switched on.

const config = require("../configs/index");
const accessLog = require("./access-log");
const credits = require("./credits");

/** ER_BAD_FIELD_ERROR — the column named in the query is not there. */
const UNKNOWN_COLUMN = 1054;

let columnWarned = false;

/**
 * The account's own number, or the configured default when it has none.
 *
 * Tolerates `users.subdomain_limit` being absent. deploy/migrations/003 is
 * applied by hand and the code may well arrive on the server first; a hard
 * failure here would stop everybody from creating anything, over a limit that
 * is not even being enforced. It says so once and carries on with the default.
 */
async function accountLimit(fastify, userId) {
  try {
    const [rows] = await fastify.mysql.execute(
      "SELECT subdomain_limit FROM users WHERE id = ?",
      [userId]
    );
    const own = rows[0]?.subdomain_limit;
    return own === null || own === undefined ? config.quota.subdomainLimit : Number(own);
  } catch (err) {
    if (err?.errno !== UNKNOWN_COLUMN) throw err;
    if (!columnWarned) {
      columnWarned = true;
      fastify.log.warn(
        { evt: "quota", action: "no_column", limit: config.quota.subdomainLimit },
        "users.subdomain_limit is missing — apply deploy/migrations/003-subdomain-limit.sql. " +
          "Every account is on the default until it is there, so no exception can be granted."
      );
    }
    return config.quota.subdomainLimit;
  }
}

/**
 * How many the subject holds now.
 *
 * Two shapes because there are two kinds of subject. An account is `user_id`,
 * whether the record was made in the browser or with an API key. An anonymous
 * caller has no account at all, so its client IP is the closest thing to one —
 * the same key the records are already owned by.
 */
async function heldBy(fastify, { userId, ip }) {
  if (userId !== null) {
    const [rows] = await fastify.mysql.execute(
      "SELECT COUNT(*) AS held FROM subdomains WHERE user_id = ?",
      [userId]
    );
    return Number(rows[0]?.held || 0);
  }
  const [rows] = await fastify.mysql.execute(
    "SELECT COUNT(*) AS held FROM subdomains WHERE owner_ip = ? AND owner_type = 'agent'",
    [ip]
  );
  return Number(rows[0]?.held || 0);
}

/**
 * May this subject create one more, and what would we have said if not.
 *
 * @param {object} subject
 * @param {number|null} subject.userId  set for a signed-in user or an API key
 * @param {string|null} subject.ip      set for an anonymous caller
 * @param {string|null} subject.subject the access log's `sub`, so a quota line
 *                                      and an http line name the caller the
 *                                      same way and can be counted together
 * @returns {{held:number, limit:number, exceeded:boolean, blocked:boolean, scope:string}}
 *   `blocked` is the only thing a caller has to act on: `exceeded` says the
 *   subject is over the line, `blocked` says we are actually refusing.
 */
async function checkSubdomainQuota(fastify, { userId = null, ip = null, subject = null } = {}) {
  const scope = userId !== null ? "account" : "ip";
  const base =
    scope === "account" ? await accountLimit(fastify, userId) : config.quota.subdomainLimit;
  const held = await heldBy(fastify, { userId, ip });

  // Only ask about money when the free allowance has run out. An account that
  // has paid for more holds more, whichever door the money came through —
  // services/credits.js — and the ledger is not read at all on the ordinary
  // path, which is every request anybody makes today.
  const paidFor = held >= base ? await credits.slotsFor(fastify, userId) : 0;
  const limit = base + paidFor;
  const exceeded = held >= limit;

  // The anonymous ceiling is older than this file and is an abuse guard rather
  // than a price: it is the only thing standing between an unauthenticated
  // write endpoint and an unbounded number of records, and there is no account
  // behind it to grant an exception to. It stays enforced. Observing instead
  // would not measure demand, it would remove a lock.
  const enforced = scope === "account" ? config.quota.enforced : true;
  const blocked = exceeded && enforced;

  if (exceeded) {
    fastify.log.warn(
      {
        evt: "quota",
        scope,
        sub: subject,
        iph: accessLog.hashIp(ip),
        held,
        limit,
        paid_for: paidFor,
        action: blocked ? "blocked" : "withheld",
      },
      blocked
        ? `Refused: ${subject || "anonymous"} holds ${held} of ${limit}`
        : `Would have refused (SUBDOMAIN_LIMIT_ENFORCED is off): ${subject || "anonymous"} holds ${held} of ${limit}`
    );
  }

  return { held, limit, exceeded, blocked, scope };
}

module.exports = { checkSubdomainQuota };
