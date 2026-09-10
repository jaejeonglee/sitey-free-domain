// routes/renewal.js — the page behind the button in the renewal mail.
//
// A top-level route rather than /api/* because a person clicks it out of their
// inbox and has to land on something readable. It takes no session: requiring
// a sign-in here would mean a renewal most people never finish, which defeats
// the point of asking them to renew at all.
//
// The signed token is the whole authorisation, and it can do exactly one thing
// — extend the subdomains on its own list. See services/renewal-token.js.
//
// What the pages look like is in services/message-layout.js, the same file the
// mails are built from, so the button and the page it leads to stay in step.

const renewalToken = require("../services/renewal-token");
const { renewSubdomain } = require("../services/expiry");
const {
  renewalResultPage,
  renewalLinkPage,
  renewalNotDuePage,
} = require("../services/message-layout");

async function renewalRoutes(fastify, options) {
  fastify.get("/renew/:token", async (request, reply) => {
    const result = renewalToken.verify(request.params.token);

    if (!result.valid) {
      request.outcome = `RENEW_${result.reason.toUpperCase()}`;
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(renewalLinkPage(result.reason === "expired" ? "expired" : "invalid"));
    }

    // One record at a time, through the one function that moves an expiry
    // (services/expiry.js), so a grouped link and a single-subdomain link do
    // exactly the same thing per record and there is one place the notice
    // stage is cleared.
    //
    // 🔴 Renew what is still here rather than all-or-nothing. The realistic
    // failure is not a half-written transaction, it is a row that has gone —
    // a subdomain the owner deleted themselves after the mail went out. Making
    // that stop the other ten from being renewed would cost somebody the
    // addresses they pressed the button to keep, to protect an invariant that
    // does not exist: renewing one record says nothing about any other, and
    // each new date is measured from today rather than added to the old one.
    // A second click renews nothing now — the window shuts behind the first —
    // and gets the "not due yet" page below. If they are *all* gone, that is
    // the existing "no longer here" page.
    const renewed = [];
    const notYet = [];
    for (const subdomainId of result.subdomainIds) {
      const renewal = await renewSubdomain(fastify, subdomainId);
      if (renewal.renewed) {
        renewed.push({
          fqdn: `${renewal.subdomain}.${renewal.domain}`,
          expiresAt: renewal.expiresAt,
        });
      } else if (renewal.reason !== "not_found") {
        // Outside the window (services/expiry.js). From a link in the mail
        // that nearly always means the button has already been pressed once —
        // the first press moved the date past the window — so this is not a
        // failure and does not colour the page red. It does have to say when
        // the button works again.
        notYet.push({
          fqdn: `${renewal.subdomain}.${renewal.domain}`,
          expiresAt: renewal.expiresAt,
          opensAt: renewal.opensAt,
        });
      }
    }

    if (renewed.length === 0 && notYet.length > 0) {
      request.outcome = "RENEW_NOT_DUE";
      return reply.type("text/html; charset=utf-8").send(renewalNotDuePage(notYet));
    }

    if (renewed.length === 0) {
      // Either the rows are gone or the ids never existed. The same answer for
      // both: a valid token names its ids and nothing about them is worth
      // probing.
      request.outcome = "RENEW_NOT_FOUND";
      return reply.code(404).type("text/html; charset=utf-8").send(renewalLinkPage("gone"));
    }

    request.outcome = "OK";
    return reply
      .type("text/html; charset=utf-8")
      .send(
        renewalResultPage({
          renewed,
          missing: result.subdomainIds.length - renewed.length - notYet.length,
          notYet,
        })
      );
  });
}

module.exports = renewalRoutes;
