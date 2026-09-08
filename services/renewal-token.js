// services/renewal-token.js — the thing in the renewal mail's button.
//
// It has to work with one click and no sign-in, which means it travels through
// mail servers, spam scanners, browser history and anywhere the recipient
// forwards it. So it is built to be worth as little as possible to whoever
// ends up holding it:
//
//   * it names one subdomain id and nothing else — there is no field in it for
//     an action, a scope or a user, so there is nothing to widen
//   * it is signed with a key derived for this purpose alone, so it is not a
//     session and fastify.jwt will not accept it as one
//   * it expires
//
// The worst a stolen one can do is extend somebody's subdomain by a period.

const crypto = require("crypto");
const config = require("../configs/index");

// Purpose-separated key, the same construction as services/access-log.js and
// services/email.js. Signing with config.jwt.secret directly would make one of
// these verifiable by @fastify/jwt, and a link in an email is not a session.
const KEY = crypto
  .createHmac("sha256", config.jwt.secret)
  .update("sitey:renewal-token:v1")
  .digest();

// Long enough to survive a mail that sat unread, short enough that a link
// found in an old inbox has stopped working. The 14-day reminder is the first
// one sent, so this covers every reminder of one period.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function signature(payload) {
  return crypto.createHmac("sha256", KEY).update(payload).digest("base64url");
}

/**
 * @param {number} subdomainId
 * @param {number} [issuedAt] - ms since epoch, injectable for tests
 * @returns {string}
 */
function sign(subdomainId, issuedAt = Date.now()) {
  const payload = Buffer.from(`${Number(subdomainId)}.${issuedAt + TTL_MS}`).toString(
    "base64url"
  );
  return `${payload}.${signature(payload)}`;
}

/**
 * @returns {{valid: true, subdomainId: number} | {valid: false, reason: string}}
 *   `reason` is for the log and for choosing which page to show; it is never
 *   detailed enough to help someone guess at a valid token.
 */
function verify(token, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) {
    return { valid: false, reason: "malformed" };
  }

  const separator = token.lastIndexOf(".");
  const payload = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = signature(payload);

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return { valid: false, reason: "bad_signature" };
  }

  const [rawId, rawExpiry] = Buffer.from(payload, "base64url").toString("utf8").split(".");
  const subdomainId = Number(rawId);
  const expiresAt = Number(rawExpiry);
  if (!Number.isInteger(subdomainId) || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: "malformed" };
  }
  if (now > expiresAt) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, subdomainId };
}

module.exports = { sign, verify, TTL_MS };
