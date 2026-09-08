// app.js — builds the Fastify instance. server.js only listens on it.
const path = require("path");
const Fastify = require("fastify");
const config = require("./configs/index");
const apiRoutes = require("./routes/index");
const bindService = require("./services/bind");
const alertService = require("./services/alert");
const emailService = require("./services/email");
const accessLog = require("./services/access-log");

function buildApp(options = {}) {
  const fastify = Fastify({
    disableRequestLogging: true,
    // Only the local reverse proxy may set X-Forwarded-For — see configs/index.js.
    trustProxy: config.server.trustProxy,
    logger: {
      // Pretty output is for a terminal. Under systemd the lines go to
      // journald, where one JSON object per line is the readable form —
      // pino-pretty there would mangle the structured access log.
      transport: config.log.pretty
        ? {
            target: "pino-pretty",
            options: {
              ignore: "pid,hostname",
            },
          }
        : undefined,
    },
    ...options,
  });

  // --- 1. Register plugins ---
  fastify.register(require("./plugins/db"));
  fastify.register(require("./plugins/auth"));
  fastify.register(require("./plugins/validation-scheduler"));
  fastify.register(require("./plugins/reconciler"));
  fastify.register(require("@fastify/rate-limit"), {
    global: true,
    max: 100,
    timeWindow: "1 minute",
    // request.ip already honours the trusted proxy list; reading the headers
    // directly let a caller reset their own counter with one header.
    keyGenerator: (request) => request.ip,
  });
  // Must stay AFTER rate-limit: a global hook only applies to routes registered
  // after it, so registering /mcp first left the MCP endpoint unthrottled.
  fastify.register(require("./plugins/mcp"));
  // Page routes must win over the static wildcard so each path gets its own
  // canonical / og tags. Explicit routes outrank "/*" in the router.
  fastify.register(require("./routes/pages"));
  fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "public"),
    prefix: "/",
  });

  // --- 2. onResponse hook (logging) ---
  // One structured line per request. The line it replaced carried the URL and
  // a raw IP and nothing else — not even the status code — so there was no way
  // to tell a successful subdomain issue from a failed one, let alone say why
  // it failed. See services/access-log.js.
  fastify.addHook("onResponse", (request, reply, done) => {
    const fields = accessLog.fieldsFor(request, reply);
    if (fields) {
      request.log.info(fields);
    }
    done();
  });

  // 3. Unknown URLs are real 404s.
  // This used to answer every non-API GET with index.html and a 200, so search
  // engines saw an unlimited supply of duplicate pages (a soft 404) and a
  // missing asset came back as HTML instead of failing.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api")) {
      return fastify.sendPageNotFound(reply);
    }
    reply.code(404).send({ error: "Not Found" });
  });

  // 4. /api/* requests are handled by routes/index.js
  fastify.register(apiRoutes, { prefix: "/api" });

  // --- 5. Inject logger into services ---
  bindService.setLogger(fastify.log);
  alertService.setLogger(fastify.log);
  // Whether these mails arrive has never been recorded anywhere; every send
  // now leaves a line. See services/email.js.
  emailService.setLogger(fastify.log);

  return fastify;
}

module.exports = { buildApp };
