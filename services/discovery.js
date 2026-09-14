// services/discovery.js — the documents a machine reads before it calls us.
//
// Three of them, one shape: built on the way out rather than filed in public/.
// The file that used to sit in public/.well-known said the service was called
// sitey.one, that anonymous callers got three subdomains and that an API key
// meant unlimited. All three were true once. Nothing made them follow the code
// when it moved, and nothing said out loud that they had stopped being true —
// which is the worst kind of documentation, because it is confident.
//
// So every number here is read from the thing that enforces it: the limit from
// configs/index.js, the lease from services/expiry.js, the price and whether
// anyone can pay it from services/x402.js, and the canonical origin from
// `config.server.publicOrigin`, which is the one place the canonical domain
// has lived since 2026-09-07. Change PUBLIC_ORIGIN and these documents move
// with it; switch SUBDOMAIN_LIMIT_ENFORCED on and they stop describing a limit
// that is only being counted.
//
// The one thing that is written by hand is prose: what an endpoint is for, and
// what a caller should do about an error. There is nothing in the route table
// to generate that from. tests/discovery.test.js is what keeps the prose
// honest — it boots the real app, reads the real route table and the real
// error codes out of routes/api-v1.js, and fails when this file has drifted.
const config = require("../configs/index");
const expiry = require("./expiry");
const x402 = require("./x402");

const SUMMARY =
  "Free subdomains with the DNS behind them: claim a name, point it at an address " +
  "with an A or CNAME record, and add the TXT record a host asks for. " +
  "Over REST or MCP, with or without an account.";

/** The host inside an origin, for the places that want a name rather than a URL. */
function hostOf(origin) {
  return new URL(origin).hostname;
}

/**
 * What a caller is allowed, in sentences, from the settings that allow it.
 *
 * Each branch describes the state the server is actually in. Saying "you will
 * be refused at five" while SUBDOMAIN_LIMIT_ENFORCED is off would be the same
 * mistake as the old file: a sentence that was true when it was written.
 */
function limitNotes() {
  const limit = config.quota.subdomainLimit;
  const notes = [];

  notes.push(
    config.quota.enforced
      ? `An account may hold ${limit} subdomains and is refused the next one.`
      : `An account may hold ${limit} subdomains. Going over is recorded rather than refused ` +
        "today, while we find out whether anybody wants more."
  );
  notes.push(
    `A caller with no API key is identified by its IP address and owns what that address ` +
      `created; there the ${limit} is enforced.`
  );
  notes.push(
    `A name is lent, not given: ${expiry.USER_MONTHS} months for a record owned by an ` +
      `account, ${expiry.AGENT_MONTHS} month for one created without one. Every response ` +
      `carries expires_at, and renewal opens ${expiry.RENEWAL_WINDOW_DAYS} days before it.`
  );
  notes.push(
    config.expiry.deletionEnabled
      ? "A record nobody renews is removed on that date."
      : "Nothing is removed on that date yet — deletion is switched off — but the date is real " +
        "and renewing already works."
  );

  const payment = x402.status();
  if (payment.enabled) {
    const { size, days, priceMicros } = config.quota.bundle;
    notes.push(
      `A caller at the limit is answered 402 with what to pay: ${(priceMicros / 1e6).toFixed(2)} ` +
        `for ${size} more subdomains for ${days} days, settled with an x-payment header.`
    );
  } else {
    notes.push(
      "Nothing can be bought while the payment route is off: a caller who is refused is " +
        "refused, not offered a price."
    );
  }

  return notes;
}

/**
 * The manifest an agent finds at /.well-known/mcp.json.
 *
 * `domains` is passed in rather than read here because it is a table —
 * managed_domains — and this file is meant to stay callable without a database
 * so the documents can be tested and previewed without one.
 */
function mcpManifest({ origin, domains }) {
  return {
    name: hostOf(origin),
    description: SUMMARY,
    url: `${origin}/mcp`,
    // Streamable HTTP, stateless: one POST carries one JSON-RPC message.
    // GET /mcp answers 405 rather than opening a stream (plugins/mcp.js).
    transport: "streamable-http",
    documentation: `${origin}/docs`,
    // Every root a subdomain can be created under. Four of them, and which
    // four is a row in managed_domains, not a constant.
    domains,
    authentication: {
      type: "optional",
      description:
        "Optional. With no header the caller is identified by its IP address and owns what " +
        "that address created. `Authorization: Bearer styo_…` — an API key from the " +
        "dashboard — puts the records under the account instead. A key is an account, not " +
        "a larger allowance: both hold the same number.",
    },
    limits: limitNotes().join(" "),
  };
}

module.exports = { SUMMARY, hostOf, limitNotes, mcpManifest };
