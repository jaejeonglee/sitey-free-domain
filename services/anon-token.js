// services/anon-token.js — the handle a caller with no account keeps.
//
// Until now an anonymous caller was its IP address: `subdomains.owner_ip` was
// the proof of ownership, and the quota and the create limiter both counted by
// it. Three things were wrong with that at once, and the middle one is why
// this file exists.
//
//   1. An address that changes takes the records with it. The service knew —
//      plugins/mcp.js used to answer "If your IP has changed, sign up at
//      sitey.my to manage it", which is advice an agent cannot follow.
//   2. 🔴 An address that is shared hands the records to strangers. Two
//      callers behind one NAT — a company, a school, a mobile carrier — have
//      the same `request.ip`, so each could list, repoint and delete the
//      other's records without ever knowing the other existed.
//   3. The allowance was per address, so one caller behind a shared exit spent
//      everybody else's.
//
// So an anonymous caller now has a credential of its own. It is not something
// to go and get: there is no signup, no key page and no prerequisite — the
// first create that arrives without one mints it and hands it back in the
// response, once. That is the whole product. Every other MCP server in the
// registry wants an API key first, a key wants an account, and an account
// wants a person; the moment we ask for one of those, an agent working on its
// own stops at the door.
//
// Hashed the same way as services/api-key.js — sha256 of the whole token, hex,
// 64 characters, and the original is never written down. Different prefix
// though: `styo_` is an account's API key and `anon_` is not an account
// at all, and a glance at a log line or a support mail has to be enough to
// tell which one somebody is holding.
const crypto = require("crypto");

/** Deliberately nothing like `styo_`, so the two cannot be misread. */
const TOKEN_PREFIX = "anon_";

/** 16 random bytes as hex — the same 128 bits an API key carries. */
const TOKEN_REGEX = /^anon_[0-9a-f]{32}$/;

/**
 * What we say when we hand one over.
 *
 * It states the loss plainly because the loss is real: a record owned by a
 * token is *not* reachable from the address that created it. That is not an
 * oversight, it is the fix — the address is exactly what a stranger behind the
 * same NAT also has, so leaving it as a way in would leave the hole open.
 */
const TOKEN_NOTE =
  "Save this now. It is shown once and cannot be looked up again, and without it this " +
  "record cannot be changed or deleted from any address — which is what stops another " +
  "caller behind the same network from reaching it. Send it back as " +
  "'Authorization: Bearer <token>' over REST, or as the 'owner_token' argument over MCP.";

/**
 * A new token and the hash to store against the row.
 * @returns {{ token: string, hash: string }}
 */
function generateToken() {
  const random = crypto.randomBytes(16).toString("hex"); // 32 hex chars
  const token = `${TOKEN_PREFIX}${random}`;
  return { token, hash: hashToken(token) };
}

/**
 * @param {string} rawToken
 * @returns {string} sha256 hex, the shape of subdomains.owner_token_hash
 */
function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Is this something we could have issued?
 *
 * Shape only — there is no table of live tokens to look it up in, and there
 * does not need to be: holding the token *is* the claim, and the rows it owns
 * are the record of it. What this rejects is a truncated or mistyped one,
 * which would otherwise quietly become a second identity holding nothing. See
 * services/quota.js for why a token nobody has used yet is counted against its
 * address instead.
 */
function isWellFormed(rawToken) {
  return typeof rawToken === "string" && TOKEN_REGEX.test(rawToken);
}

/**
 * The WHERE fragment that says "this row belongs to this caller", and its
 * parameters, for whichever of the three kinds of caller this is.
 *
 * 🔴 The address branch carries `owner_token_hash IS NULL`, and that single
 * condition is the NAT fix. Without it a caller that simply sends no token
 * still matches somebody else's row on the shared address alone, and every
 * other part of this change is decoration.
 *
 * It is also what keeps the 41 records that predate tokens working: they have
 * no hash, so the address still proves them, exactly as it did yesterday.
 * Nobody is locked out of something they already hold.
 *
 * @param {object} auth  request.apiAuth — mode apikey | token | ip
 * @param {string} alias table alias including its dot, e.g. "s."
 */
function ownerPredicate(auth, alias = "") {
  if (auth.mode === "apikey") {
    return { sql: `${alias}user_id = ?`, params: [auth.userId] };
  }
  if (auth.mode === "token") {
    return {
      sql: `${alias}owner_token_hash = ? AND ${alias}owner_type = 'agent'`,
      params: [auth.tokenHash],
    };
  }
  return {
    sql:
      `${alias}owner_ip = ? AND ${alias}owner_type = 'agent' ` +
      `AND ${alias}owner_token_hash IS NULL`,
    params: [auth.ip],
  };
}

module.exports = {
  TOKEN_PREFIX,
  TOKEN_NOTE,
  generateToken,
  hashToken,
  isWellFormed,
  ownerPredicate,
};
