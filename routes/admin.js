// routes/admin.js — /admin and the numbers it reads. Read-only.
//
// 🔴 Anyone who is not on config.admin.emails gets exactly what an unknown URL
// gets (fastify.sendPageNotFound) — signed out, signed in, bad token, expired
// session alike. A 401 or 403 here would tell a stranger the page exists.
const fs = require("fs").promises;
const path = require("path");
const config = require("../configs/index");
const { renderPage } = require("./pages");
const adminStats = require("../services/admin-stats");

const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");

/**
 * Whether this request comes from an admin. Never throws: every way of not
 * being one — no cookie, a forged token, a session logged out elsewhere, an
 * address not on the list — is the same false.
 *
 * The address is read from `users`, not from the token, so taking somebody
 * off the list or deleting the account takes effect on the next request.
 */
async function isAdmin(fastify, request) {
  try {
    const token =
      request.cookies?.[fastify.COOKIE_NAME] ||
      request.headers.authorization?.replace("Bearer ", "");
    if (!token) return false;

    const decoded = fastify.jwt.verify(token);
    if (!decoded?.id || !decoded.sessionId) return false;

    const [sessions] = await fastify.mysql.execute(
      "SELECT 1 FROM user_sessions WHERE id = ? AND user_id = ? AND expires_at > NOW()",
      [decoded.sessionId, decoded.id]
    );
    if (sessions.length === 0) return false;

    const [users] = await fastify.mysql.execute("SELECT id, email FROM users WHERE id = ?", [
      decoded.id,
    ]);
    const email = String(users[0]?.email || "").trim().toLowerCase();
    return Boolean(email) && config.admin.emails.includes(email);
  } catch {
    return false;
  }
}

async function adminRoutes(fastify) {
  const template = await fs.readFile(INDEX_PATH, "utf8");

  const guard = async (request, reply) => {
    if (!(await isAdmin(fastify, request))) {
      request.outcome = "NOT_FOUND";
      return fastify.sendPageNotFound(reply);
    }
  };

  // The shell only — the client router draws the page and reads the API.
  fastify.get("/admin", { preHandler: guard }, async (request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(
        renderPage(template, {
          canonicalPath: "/admin",
          title: "Admin — Sitey",
          description: "Sitey admin",
          noindex: true,
          body: "",
        })
      )
  );

  fastify.get("/admin/api/stats", { preHandler: guard }, async (request, reply) =>
    reply.header("Cache-Control", "no-store").send(await adminStats.collectStats(fastify))
  );
}

module.exports = adminRoutes;
module.exports.isAdmin = isAdmin;
