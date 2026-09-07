// app.js — builds the Fastify instance. server.js only listens on it.
const path = require("path");
const Fastify = require("fastify");
const config = require("./configs/index");
const apiRoutes = require("./routes/index");
const bindService = require("./services/bind");
const alertService = require("./services/alert");

function buildApp(options = {}) {
  const fastify = Fastify({
    disableRequestLogging: true,
    // Only the local reverse proxy may set X-Forwarded-For — see configs/index.js.
    trustProxy: config.server.trustProxy,
    logger: {
      transport: {
        target: "pino-pretty",
        options: {
          ignore: "pid,hostname",
        },
      },
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
  fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "public"),
    prefix: "/",
  });

  // --- 2. onResponse hook (logging) ---
  fastify.addHook("onResponse", (request, reply, done) => {
    const url = request.raw.url;
    if (url.startsWith("/api")) {
      fastify.log.info(` ${url} | ${request.ip}`);
    }
    done();
  });

  // 3. Set not-found handler for client-side routing
  fastify.setNotFoundHandler((request, reply) => {
    // For GET requests that are not API calls, serve index.html
    if (request.method === "GET" && !request.url.startsWith("/api")) {
      return reply.sendFile("index.html");
    }
    // For other cases, send a 404
    reply.code(404).send({ error: "Not Found" });
  });

  // 4. /api/* requests are handled by routes/index.js
  fastify.register(apiRoutes, { prefix: "/api" });

  // --- 5. Inject logger into services ---
  bindService.setLogger(fastify.log);
  alertService.setLogger(fastify.log);

  return fastify;
}

module.exports = { buildApp };
