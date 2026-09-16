// plugins/redirect.js — the request a REDIRECT record answers.
//
// A REDIRECT name resolves to this server (services/bind.js writes it as an A
// record for config.redirect.targetIp), Caddy terminates TLS for *.sitey.my
// and hands the request here, and this hook answers it with a 301 before any
// route sees it. The site itself — the canonical hosts — falls straight
// through; nothing below this line changes for it.
//
// The hook is the first thing app.js adds, so it runs ahead of the rate
// limiter too. That is deliberate: these are visitors to somebody's link, not
// callers of our API, and a busy link should not start failing at 100 a
// minute behind one NAT.
const fp = require("fastify-plugin");
const config = require("../configs/index");
const { getManagedDomains } = require("../services/managedDomain");
const redirectHits = require("../services/redirect-hits");
const { SUBDOMAIN_REGEX } = require("../utils/validators");

/** The host a request arrived at, without port and case. */
function hostOf(request) {
  const raw = String(request.headers.host || "").trim().toLowerCase();
  if (!raw) return "";
  // "[::1]:3000" keeps its brackets; anything else drops a trailing :port.
  return raw.startsWith("[") ? raw.replace(/\]:\d+$/, "]") : raw.replace(/:\d+$/, "");
}

/**
 * Split a host into (subdomain, managed domain), or null.
 *
 * Exactly one label under a root we manage: `myapp.sitey.my`, not
 * `a.b.sitey.my` and not the root itself.
 */
function splitHost(host, managedDomains) {
  for (const entry of managedDomains) {
    const suffix = `.${entry.normalized}`;
    if (!host.endsWith(suffix)) continue;
    const subdomain = host.slice(0, -suffix.length);
    if (SUBDOMAIN_REGEX.test(subdomain)) return { subdomain, entry };
  }
  return null;
}

/**
 * The URL a REDIRECT record under this name points at, or null.
 *
 * Read on every visit, with no cache and `Cache-Control: no-store` on the
 * answer, so a changed value is live on the next request. The row's type is
 * part of the WHERE: an A or CNAME name that somehow arrived here is not a
 * redirect and must not become one.
 */
async function targetFor(fastify, host) {
  const managedDomains = await getManagedDomains(fastify);
  const split = splitHost(host, managedDomains);
  if (!split) return null;

  // `id` comes back too: it is what a visit is counted against
  // (services/redirect-hits.js), and this is the only query on the path.
  const [rows] = await fastify.mysql.execute(
    "SELECT id, record_value FROM subdomains WHERE subdomain = ? AND domain_id = ? AND record_type = 'REDIRECT' LIMIT 1",
    [split.subdomain, split.entry.id]
  );
  if (!rows[0]?.record_value) return null;
  return { id: rows[0].id, subdomain: split.subdomain, url: rows[0].record_value };
}

async function redirectPlugin(fastify) {
  const canonical = new Set(config.redirect.canonicalHosts);

  fastify.addHook("onRequest", async (request, reply) => {
    const host = hostOf(request);
    if (!host || canonical.has(host)) return;

    const target = await targetFor(fastify, host);
    if (!target) {
      reply
        .code(404)
        .header("cache-control", "no-store")
        .type("text/plain; charset=utf-8")
        .send("No site is configured at this name.\n");
      return reply;
    }

    // The destination host only — the full URL is the user's, and a path can
    // carry a token or an email address that has no place in our log.
    const to = new URL(target.url).hostname;
    request.log.info(
      { evt: "redirect", sub: target.subdomain, host, to },
      `Redirect: ${host} → ${to}`
    );

    reply
      .code(301)
      .header("location", target.url)
      .header("cache-control", "no-store")
      .send();

    // 🔴 After the answer, and inside a try. Counting is the least important
    // thing this hook does — a visitor whose link stopped working because a
    // number could not be incremented would be the worst bug this file could
    // have. The call itself only touches a Map; the database write happens on
    // a timer (services/redirect-hits.js).
    try {
      redirectHits.record(target.id);
    } catch (err) {
      request.log.warn(
        { evt: "redirect_hits", sub: target.subdomain, err },
        "Redirect counted nothing; the redirect itself went out"
      );
    }
    return reply;
  });

  // The batch writer. onReady rather than here so tests that build the plugin
  // and never call ready() do not leave a timer behind; onClose flushes what
  // is left, so a clean restart loses nothing.
  fastify.addHook("onReady", async () => {
    redirectHits.start(fastify);
  });

  fastify.addHook("onClose", async () => {
    redirectHits.stop();
    await redirectHits.flush(fastify);
  });
}

module.exports = fp(redirectPlugin, { name: "redirect" });
module.exports.hostOf = hostOf;
module.exports.splitHost = splitHost;
