// routes/renewal.js — the page behind the button in the renewal mail.
//
// A top-level route rather than /api/* because a person clicks it out of their
// inbox and has to land on something readable. It takes no session: requiring
// a sign-in here would mean a renewal most people never finish, which defeats
// the point of asking them to renew at all.
//
// The signed token is the whole authorisation, and it can do exactly one thing
// — see services/renewal-token.js.

const renewalToken = require("../services/renewal-token");
const { renewSubdomain } = require("../services/expiry");

function page({ heading, body, ok }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} — sitey.my</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
         background: #f6f7f9; color: #1d2330; display: flex; min-height: 100vh;
         align-items: center; justify-content: center; margin: 0; padding: 24px; }
  main { background: #fff; border-radius: 12px; padding: 40px; max-width: 480px;
         box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.35rem; margin: 0 0 12px; color: ${ok ? "#1c2d4a" : "#8a2b2b"}; }
  p { margin: 0 0 12px; line-height: 1.6; }
  a { color: #1c2d4a; }
</style>
</head>
<body><main><h1>${heading}</h1>${body}
<p><a href="https://sitey.my/dashboard">Go to your dashboard</a></p>
</main></body>
</html>`;
}

async function renewalRoutes(fastify, options) {
  fastify.get("/renew/:token", async (request, reply) => {
    const result = renewalToken.verify(request.params.token);

    if (!result.valid) {
      request.outcome = `RENEW_${result.reason.toUpperCase()}`;
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          page({
            ok: false,
            heading:
              result.reason === "expired" ? "This link has expired" : "This link is not valid",
            body:
              result.reason === "expired"
                ? `<p>Renewal links stop working after 30 days. If your subdomain is still
                     listed on your dashboard you can renew it there; if it has already been
                     released, the name is free to claim again.</p>`
                : `<p>Check that the whole link was copied — some mail clients break long
                     ones across lines. You can also renew from your dashboard.</p>`,
          })
        );
    }

    const renewal = await renewSubdomain(fastify, result.subdomainId);

    if (!renewal.renewed) {
      // Either the row is gone or the id never existed. The same answer for
      // both: a valid token names one id and nothing about it is worth probing.
      request.outcome = "RENEW_NOT_FOUND";
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          page({
            ok: false,
            heading: "That subdomain is no longer here",
            body: `<p>It may have already been released. You can claim it again from your
                     dashboard if the name is still free.</p>`,
          })
        );
    }

    request.outcome = "OK";
    const fqdn = `${renewal.subdomain}.${renewal.domain}`;
    return reply
      .type("text/html; charset=utf-8")
      .send(
        page({
          ok: true,
          heading: `${fqdn} is yours for another while`,
          body: `<p>Renewed until <strong>${renewal.expiresAt.toUTCString()}</strong>.
                   Nothing else to do — we will write again before it next comes due.</p>`,
        })
      );
  });
}

module.exports = renewalRoutes;
