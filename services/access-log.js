// services/access-log.js — one structured line per request.
//
// Why this exists: 38 accounts, 14 of them holding a subdomain. 24 people
// signed up and left with nothing, and we cannot tell which of three things
// happened to them — the issue attempt failed, the name they wanted was always
// taken, or they only looked around. Each one calls for completely different
// work, and the log line we had ("/api/subdomains | 1.2.3.4") separates none of
// them. It does not even carry the status code.
//
// What one line has to answer:
//   1. did an issue attempt succeed, and if not why  -> `step` + `code`
//   2. how far into the funnel the person got        -> `step`
//   3. days from signup to first attempt             -> users.created_at joined
//      against the first line carrying this `sub` — nothing extra is logged
//   4. how many attempts before giving up            -> count issue lines per `sub`
//
// No personal data in the clear. The client IP only ever appears as an HMAC;
// emails, API keys and TXT values never appear at all. The path is the route
// *pattern*, so the names people tried stay out of the log too.

const crypto = require("crypto");
const config = require("../configs/index");

// Purpose-separated key: hashes from this log cannot be compared against
// hashes made anywhere else, even though both start from the same secret.
const IP_HASH_KEY = crypto
  .createHmac("sha256", config.log.hashSecret)
  .update("sitey:access-log:ip:v1")
  .digest();

/**
 * The funnel, in order. Keyed on method + registered route pattern, so a route
 * that moves shows up as a missing step instead of quietly mislabelling one.
 * tests/access-log.test.js checks every key against the real router.
 */
const STEPS = new Map(
  Object.entries({
    "GET /": "landing",
    "POST /api/check-availability": "name_check",
    "GET /api/v1/check/:subdomain/:domain": "name_check",
    "POST /api/subdomains": "issue",
    "POST /api/v1/subdomains": "issue",
    "PUT /api/subdomains/:subdomain": "update",
    "PATCH /api/v1/subdomains/:subdomain/:domain": "update",
    "POST /api/subdomains/:subdomain/txt": "connect",
    "POST /api/v1/subdomains/:subdomain/:domain/txt": "connect",
    // Not part of the signup funnel, but it is the one page outside /api, so
    // a step is what gets it logged at all — and whether renewal links are
    // being clicked is the measure of whether renewal works.
    "GET /renew/:token": "renew",
    "POST /api/v1/subdomains/:subdomain/:domain/renew": "renew",
  })
);

function hashIp(ip) {
  if (!ip) return null;
  return crypto
    .createHmac("sha256", IP_HASH_KEY)
    .update(String(ip))
    .digest("base64url")
    .slice(0, 16);
}

/**
 * Who did this, without saying who they are.
 *
 * Anonymous callers get no subject; their hashed IP is the only handle, which
 * is also what ties a logged-in person's page views to their API calls — page
 * routes never run the auth hook, so `sub` is absent there.
 */
function subjectOf(request) {
  if (request.apiAuth?.mode === "apikey") return `k:${request.apiAuth.userId}`;
  if (request.user?.id) return `u:${request.user.id}`;
  return null;
}

function stepOf(method, routePattern) {
  return STEPS.get(`${method} ${routePattern}`) || null;
}

/**
 * The line to log, or null for requests not worth a line (static assets).
 */
function fieldsFor(request, reply) {
  const routePattern = request.routeOptions?.url || null;
  const step = routePattern ? stepOf(request.method, routePattern) : null;
  const url = request.raw.url || "";

  if (!step && !url.startsWith("/api") && !url.startsWith("/mcp")) {
    return null;
  }

  return {
    evt: "http",
    rid: request.id,
    m: request.method,
    p: routePattern,
    step,
    st: reply.statusCode,
    // Routes set request.outcome where the status code alone cannot say why:
    // a 400 is a bad name, an unreachable target and a blocked word all at once.
    code: request.outcome || (reply.statusCode < 400 ? "OK" : null),
    sub: subjectOf(request),
    iph: hashIp(request.ip),
    ms: Math.round(reply.elapsedTime),
  };
}

module.exports = { fieldsFor, hashIp, subjectOf, stepOf, STEPS };
