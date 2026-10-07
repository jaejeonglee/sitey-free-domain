// routes/abuse.js — POST /api/abuse-reports, the form on /abuse.
//
// Anyone may report, with no account: the people who see a phishing page
// first are rarely our users, and a security vendor that finds no way to
// reach us blocks the whole root instead (2026-10-07). A report is written to
// `abuse_reports` (deploy/migrations/010) and then sent to the operator's
// Telegram through services/alert.js — the row first, so a failed message
// loses nothing.
//
// Two shapes in, one rule: the page's script posts JSON and reads JSON back;
// without JavaScript the browser posts the form itself and gets a line of
// text. Nothing else differs.
const querystring = require("querystring");
const accessLog = require("../services/access-log");
const alertService = require("../services/alert");

const LIMITS = { target: 512, reason: 4000, contact: 255 };

// Per address, on top of the global 100 a minute. Generous for a person, and
// small enough that the operator's phone is not the thing being flooded.
const RATE_LIMIT = { max: 5, timeWindow: "1 hour" };

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function abuseRoutes(fastify, options) {
  // The no-JavaScript road. Scoped to this plugin, so no other route starts
  // accepting form posts.
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (request, body, done) => done(null, querystring.parse(body))
  );

  fastify.post(
    "/abuse-reports",
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const fromForm = request.headers["content-type"]?.startsWith(
        "application/x-www-form-urlencoded"
      );
      const answer = (statusCode, message) => {
        if (fromForm) {
          return reply.code(statusCode).type("text/plain; charset=utf-8").send(message);
        }
        return reply
          .code(statusCode)
          .send(statusCode < 300 ? { success: true } : { error: message });
      };

      const body = request.body || {};
      const target = clean(body.target);
      const reason = clean(body.reason);
      const contact = clean(body.contact);

      if (!target || !reason) {
        request.outcome = "INVALID_INPUT";
        return answer(400, "Both the address and what is wrong with it are required.");
      }
      for (const [field, value] of Object.entries({ target, reason, contact })) {
        if (value.length > LIMITS[field]) {
          request.outcome = "INVALID_INPUT";
          return answer(400, `${field} must be ${LIMITS[field]} characters or fewer.`);
        }
      }

      const [result] = await fastify.mysql.execute(
        "INSERT INTO abuse_reports (target, reason, contact, reporter_iph) VALUES (?, ?, ?, ?)",
        [target, reason, contact || null, accessLog.hashIp(request.ip)]
      );

      // Telegram text is plain (no parse mode), so what the reporter typed
      // cannot format or link anything. Cut long so one report is one screen.
      try {
        await alertService.warn(`ABUSE REPORT #${result.insertId}`, {
          target,
          reason: reason.length > 500 ? `${reason.slice(0, 500)}…` : reason,
          contact: contact || "-",
        });
      } catch (error) {
        // services/alert.js already swallows send failures; this is for
        // anything stranger. The report is saved either way.
        request.log.error(error, "Abuse report saved but the alert failed");
      }

      request.outcome = "ABUSE_REPORTED";
      return answer(201, "Thank you — your report has been received.");
    }
  );
}

module.exports = abuseRoutes;
