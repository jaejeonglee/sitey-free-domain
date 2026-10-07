// routes/user.js — Google OAuth
const crypto = require("crypto");
const { google } = require("googleapis");
const config = require("../configs/index");

function getOAuth2Client() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.callbackUrl
  );
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function userRoutes(fastify, options) {
  // GET /api/auth/google — redirect to Google consent
  fastify.get(
    "/google",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes" },
      },
    },
    async (request, reply) => {
      const oauth2Client = getOAuth2Client();
      const url = oauth2Client.generateAuthUrl({
        access_type: "online",
        scope: ["email", "profile"],
        prompt: "select_account",
      });
      return reply.redirect(url);
    }
  );

  // GET /api/auth/google/callback — handle Google callback
  fastify.get("/google/callback", async (request, reply) => {
    const { code } = request.query;

    if (!code) {
      return reply.redirect("/?error=auth_failed");
    }

    try {
      const oauth2Client = getOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      // Get user info
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const { data: profile } = await oauth2.userinfo.get();

      if (!profile.email) {
        return reply.redirect("/?error=no_email");
      }

      const connection = await fastify.mysql.getConnection();
      try {
        // Find or create user
        const [existing] = await connection.execute(
          "SELECT id, email FROM users WHERE email = ?",
          [profile.email]
        );

        let userId;

        if (existing.length > 0) {
          userId = existing[0].id;
          // Update Google profile info
          await connection.execute(
            "UPDATE users SET google_id = ?, name = ?, picture = ? WHERE id = ?",
            [profile.id, profile.name || null, profile.picture || null, userId]
          );
        } else {
          // Create new user
          const [result] = await connection.execute(
            "INSERT INTO users (email, google_id, name, picture) VALUES (?, ?, ?, ?)",
            [profile.email, profile.id, profile.name || null, profile.picture || null]
          );
          userId = result.insertId;
        }

        // Single session: delete existing sessions (lazy cleanup of expired too)
        await connection.execute(
          "DELETE FROM user_sessions WHERE user_id = ?",
          [userId]
        );

        // Create new session
        const sessionId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await connection.execute(
          "INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
          [sessionId, userId, expiresAt.toISOString().slice(0, 19).replace("T", " ")]
        );

        // Sign JWT
        const token = fastify.jwt.sign({
          id: userId,
          email: profile.email,
          sessionId,
        });

        // Set HttpOnly cookie. `__Host-` (plugins/auth.js) requires exactly
        // this: secure, path "/", and no domain — do not add one.
        reply.setCookie(fastify.COOKIE_NAME, token, {
          httpOnly: true,
          secure: true,
          sameSite: "strict",
          path: "/",
          maxAge: SESSION_TTL_MS / 1000,
        });

        return reply.redirect("/dashboard");
      } finally {
        connection.release();
      }
    } catch (error) {
      fastify.log.error(error, "Google OAuth callback failed");
      return reply.redirect("/?error=auth_failed");
    }
  });

  // GET /api/auth/me — check current session
  fastify.get(
    "/me",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const [rows] = await fastify.mysql.execute(
        "SELECT id, email, name, picture FROM users WHERE id = ?",
        [request.user.id]
      );

      if (rows.length === 0) {
        return reply.code(401).send({ error: "User not found" });
      }

      return reply.send(rows[0]);
    }
  );

  // POST /api/auth/logout — clear session + cookie
  fastify.post(
    "/logout",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.sessionId) {
        await fastify.mysql.execute(
          "DELETE FROM user_sessions WHERE id = ?",
          [request.user.sessionId]
        );
      }

      // Both names: the old one is never read any more, but a browser that
      // still carries it should not keep it after saying goodbye.
      for (const name of [fastify.COOKIE_NAME, fastify.LEGACY_COOKIE_NAME]) {
        reply.clearCookie(name, {
          httpOnly: true,
          secure: true,
          sameSite: "strict",
          path: "/",
        });
      }

      return reply.send({ success: true });
    }
  );
}

module.exports = userRoutes;
