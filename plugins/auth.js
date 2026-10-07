// plugins/auth.js
const fp = require("fastify-plugin");
const fastifyJwt = require("@fastify/jwt");
const fastifyCookie = require("@fastify/cookie");
const config = require("../configs/index");

// `__Host-` makes the browser refuse this cookie unless it is Secure, Path=/
// and carries no Domain — so a user's subdomain (x.sitey.my, whose server is
// not ours) cannot set one that the site would read as a session. Under the
// old name it could: sitey.my is not on the Public Suffix List, so a
// `Domain=sitey.my` cookie from any subdomain lands here (2026-10-07).
//
// 🔴 The old name is never read, only cleared on logout. Reading it as a
// fallback would leave exactly the hole this closes.
const COOKIE_NAME = "__Host-sitey_token";
const LEGACY_COOKIE_NAME = "sitey_token";

async function authPlugin(fastify, options) {
  fastify.register(fastifyCookie);

  fastify.register(fastifyJwt, {
    secret: config.jwt.secret,
    sign: { algorithm: "HS256", expiresIn: "24h" },
    verify: { algorithms: ["HS256"] },
    cookie: {
      cookieName: COOKIE_NAME,
      signed: false,
    },
  });

  fastify.decorate("COOKIE_NAME", COOKIE_NAME);
  fastify.decorate("LEGACY_COOKIE_NAME", LEGACY_COOKIE_NAME);

  fastify.decorate("authenticate", async (request, reply) => {
    try {
      // Try cookie first, then Authorization header
      const token =
        request.cookies[COOKIE_NAME] ||
        request.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        return reply.code(401).send({
          error: "Unauthorized",
          message: "Authentication required.",
        });
      }

      const decoded = fastify.jwt.verify(token);
      request.user = decoded;

      // Validate session exists and not expired
      if (decoded.sessionId) {
        const [rows] = await fastify.mysql.execute(
          "SELECT 1 FROM user_sessions WHERE id = ? AND user_id = ? AND expires_at > NOW()",
          [decoded.sessionId, decoded.id]
        );
        if (rows.length === 0) {
          return reply.code(401).send({
            error: "Unauthorized",
            message: "Session expired or invalidated.",
          });
        }
      }
    } catch (err) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Authentication token is invalid.",
      });
    }
  });
}

module.exports = fp(authPlugin);
