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
 * What happens to a record whose target stays dark, from the switch that
 * decides it. The nightly check has never removed anything; whether it writes
 * to the owner is UNREACHABLE_NOTICE_ENABLED, and that has been off since the
 * mails were written because none has ever been watched arriving.
 */
function darkNote() {
  const days = config.validation.unreachableNoticeDays;
  return config.validation.unreachableNoticeEnabled
    ? `A record owned by an account whose target is still dark after ${days} days earns its ` +
        "owner an email; one created without an account has nobody to write to, and is left alone."
    : "A record whose target stays dark is counted every night and otherwise left alone.";
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
    openapi: `${origin}/openapi.json`,
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

/**
 * Where the REST API lives. The routes are registered under this prefix in
 * app.js, and `paths` below spells it out in full rather than hiding it in
 * `servers`, so the document can be read straight against the route table.
 */
const API_PREFIX = "/api/v1";

/** A response body, which is always `{ success: true, data: … }`. */
function ok(description, properties, required) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean", const: true },
            data: { type: "object", properties, required: required || Object.keys(properties) },
          },
          required: ["success", "data"],
        },
      },
    },
  };
}

/**
 * A failure, which is always `{ error: true, message, code }`.
 *
 * The codes go in the description because that is the part an agent has to act
 * on: which of them it got decides whether to change the request, wait, or
 * stop. `message` is for a person reading a log and is not stable enough to
 * branch on.
 */
function fail(description) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function pathParams(...names) {
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description:
      name === "domain"
        ? "One of the roots from GET /api/v1/domains."
        : name === "hostPrefix"
          ? "The prefix the TXT record was created under."
          : "The subdomain label on its own, without the root.",
  }));
}

function body(properties, required) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { type: "object", properties, required },
      },
    },
  };
}

const RECORD_TYPE = {
  type: "string",
  enum: ["A", "CNAME"],
  description: "A for an IP address, CNAME for a hostname. Nothing else is written.",
};

/**
 * The nine operations, keyed by the route they document.
 *
 * The key is the method and the full path exactly as Fastify has it, because
 * tests/discovery.test.js boots the app, reads the route table and compares
 * the two sets. A route added without an entry here fails the suite; so does
 * an entry here for a route that no longer exists.
 */
function operations(origin) {
  const host = hostOf(origin);
  const fqdn = `demo.${host}`;
  const prefixes = config.txt.apexPrefixes;

  return {
    "GET /api/v1/domains": {
      summary: "The roots you may create a subdomain under",
      description:
        "Call this first. Which roots are on offer is a row in a table, not a constant, and " +
        "the first one in the list is the one the site itself uses.",
      responses: {
        200: ok("The active roots, canonical first.", {
          domains: { type: "array", items: { type: "string" }, example: [host] },
        }),
      },
    },

    "GET /api/v1/check/{subdomain}/{domain}": {
      summary: "Is this name free",
      description:
        "Checks the zone and the database. A name can be taken in either and available in " +
        "neither, so both are asked before the answer is yes.",
      parameters: pathParams("subdomain", "domain"),
      responses: {
        200: ok("Whether the name can be claimed.", {
          available: { type: "boolean" },
          subdomain: { type: "string", example: "demo" },
          domain: { type: "string", example: host },
          fqdn: { type: "string", example: fqdn },
        }),
        400: fail(
          "INVALID_SUBDOMAIN — the label is not one DNS accepts. " +
            "INVALID_DOMAIN — that root is not managed here; GET /api/v1/domains lists the ones that are."
        ),
      },
    },

    "POST /api/v1/subdomains": {
      summary: "Claim a name and point it somewhere",
      description:
        "Creates the DNS record and the row behind it together. Claim the name first and " +
        "deploy to it second if that is the order you need: the target is asked for an HTTP " +
        "response, but the answer is reported in `reachable` rather than refused, because " +
        "most hosts want the DNS record in place before they will serve anything at the name. " +
        `Nothing is removed for being unreachable. ${darkNote()}`,
      requestBody: body(
        {
          subdomain: { type: "string", example: "demo", description: "The label on its own." },
          domain: { type: "string", example: host, description: "One of the roots from GET /api/v1/domains." },
          type: { ...RECORD_TYPE, default: "A" },
          value: {
            type: "string",
            example: "203.0.113.10",
            description: "An IPv4 address for A, a hostname for CNAME. A CNAME may not point at itself.",
          },
        },
        ["subdomain", "domain", "value"]
      ),
      responses: {
        201: ok(
          "The record, the date it falls due, and whether anything is answering at it yet.",
          {
            fqdn: { type: "string", example: fqdn },
            type: RECORD_TYPE,
            value: { type: "string", example: "203.0.113.10" },
            expires_at: {
              type: "string",
              format: "date-time",
              description:
                "When the lease ends. It travels in the response because a caller with no " +
                "account has no mailbox to be reminded at.",
            },
            reachable: {
              type: "boolean",
              description:
                "Whether the target answered an HTTP request at the moment the record was " +
                "written. False is not a failure and nothing was rolled back; it means the " +
                "name resolves and there is not yet anything at the other end.",
            },
            note: {
              type: "string",
              description:
                "Present only when `reachable` is false: which check ran, and what it means.",
            },
          },
          ["fqdn", "type", "value", "expires_at", "reachable"]
        ),
        400: fail(
          "INVALID_SUBDOMAIN — the label is not one DNS accepts. " +
            "INVALID_INPUT — the value is not an address of the type given. " +
            "INVALID_DOMAIN — that root is not managed here. " +
            "BLACKLISTED — the name is reserved."
        ),
        402: {
          description:
            "Only when the payment route is switched on, and only for a caller over the " +
            "limit. The body is an x402 payment requirement — what to pay, in what, and to " +
            "whom — and the same request repeated with an `x-payment` header goes through. " +
            "With the route off this is a 403 instead.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  x402Version: { type: "integer" },
                  error: { type: "string" },
                  accepts: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        403: fail("LIMIT_REACHED — the caller is holding as many as they may. The message says both numbers."),
        409: fail("SUBDOMAIN_TAKEN — somebody else has it."),
      },
    },

    "GET /api/v1/subdomains": {
      summary: "What this caller holds",
      description:
        "An API key lists the account's records. Without one, the records created from this " +
        "IP address — which is the only identity an anonymous caller has.",
      responses: {
        200: ok("Newest first.", {
          subdomains: { type: "array", items: { $ref: "#/components/schemas/Subdomain" } },
        }),
      },
    },

    "PATCH /api/v1/subdomains/{subdomain}/{domain}": {
      summary: "Point an existing name somewhere else",
      description:
        "The record type cannot be changed, only the value it points at. The new target is " +
        "asked for an HTTP response and the answer comes back in `reachable`, exactly as on " +
        "create: the record is moved either way, so a name can be pointed at somewhere that " +
        "is not serving yet.",
      parameters: pathParams("subdomain", "domain"),
      requestBody: body({ value: { type: "string", example: "203.0.113.11" } }, ["value"]),
      responses: {
        200: ok(
          "The record as it now stands.",
          {
            fqdn: { type: "string", example: fqdn },
            type: RECORD_TYPE,
            value: { type: "string", example: "203.0.113.11" },
            reachable: {
              type: "boolean",
              description: "Whether the new target answered. False did not stop the move.",
            },
            note: {
              type: "string",
              description: "Present only when `reachable` is false.",
            },
          },
          ["fqdn", "type", "value", "reachable"]
        ),
        400: fail(
          "INVALID_INPUT — the value is not an address of this record's type. " +
            "INVALID_DOMAIN — that root is not managed here."
        ),
        403: fail("FORBIDDEN — no such record under this caller. Deliberately the same answer as one that exists and belongs to somebody else."),
      },
    },

    "DELETE /api/v1/subdomains/{subdomain}/{domain}": {
      summary: "Give a name back",
      description: "Removes the zone record and the row together. The name is free immediately.",
      parameters: pathParams("subdomain", "domain"),
      responses: {
        200: ok("Gone.", {
          fqdn: { type: "string", example: fqdn },
          deleted: { type: "boolean", const: true },
        }),
        400: fail("INVALID_DOMAIN — that root is not managed here."),
        403: fail("FORBIDDEN — no such record under this caller."),
      },
    },

    "POST /api/v1/subdomains/{subdomain}/{domain}/renew": {
      summary: "Keep a name for another period",
      description:
        `The clock is reset from today rather than added to the old date, so calling this in ` +
        `a loop cannot stack up years. It opens ${expiry.RENEWAL_WINDOW_DAYS} days before ` +
        "expiry — asking earlier is refused with the date it becomes possible.",
      parameters: pathParams("subdomain", "domain"),
      responses: {
        200: ok("The new date.", {
          fqdn: { type: "string", example: fqdn },
          expires_at: { type: "string", format: "date-time" },
        }),
        400: fail("INVALID_DOMAIN — that root is not managed here."),
        403: fail("FORBIDDEN — no such record under this caller."),
        404: fail("SUBDOMAIN_NOT_FOUND — it was there a moment ago and is not now."),
        409: fail(
          "RENEWAL_NOT_DUE — too early, or the record has no expiry at all. The message " +
            "names the date to come back on, so the call does not have to be retried blindly."
        ),
      },
    },

    "POST /api/v1/subdomains/{subdomain}/{domain}/txt": {
      summary: "Add the TXT record a host asks for",
      description:
        `Only ${prefixes.map((p) => `\`${p}\``).join(", ")} may be used as a prefix, and the ` +
        "record is written at the root domain, which is where verification services look for " +
        "it. Calling this twice with different values replaces this subdomain's own line and " +
        "leaves everybody else's alone.",
      parameters: pathParams("subdomain", "domain"),
      requestBody: body(
        {
          host_prefix: { type: "string", enum: prefixes, example: prefixes[0] },
          value: {
            type: "string",
            maxLength: 512,
            description: "No line breaks, control characters, quotes or backslashes.",
          },
        },
        ["host_prefix", "value"]
      ),
      responses: {
        200: ok("The TXT record as written.", {
          fqdn: { type: "string", example: `${prefixes[0]}.${host}` },
          type: { type: "string", const: "TXT" },
          value: { type: "string" },
        }),
        400: fail(
          "INVALID_INPUT — the value is empty, too long, or carries a character a zone file " +
            "cannot hold. " +
            "INVALID_HOST_PREFIX — not one of the prefixes above. " +
            "INVALID_DOMAIN — that root is not managed here. " +
            "ROOT_LEVEL_FORBIDDEN — the `root_level` flag is gone; every TXT record is written " +
            "at the root now, so the flag selects nothing. Omit it."
        ),
        403: fail("FORBIDDEN — no such subdomain under this caller to hang a TXT record on."),
      },
    },

    "DELETE /api/v1/subdomains/{subdomain}/{domain}/txt/{hostPrefix}": {
      summary: "Take that TXT record away",
      description:
        "Removes this subdomain's own line. The name is shared with every other subdomain of " +
        "the root, so the stored value is what identifies which line is yours.",
      parameters: pathParams("subdomain", "domain", "hostPrefix"),
      responses: {
        200: ok(
          "Gone. `zone_record_removed` is false when the row was there and the zone line was " +
            "not — the row is removed either way, and saying so beats claiming a change that " +
            "did not happen.",
          {
            fqdn: { type: "string", example: `${prefixes[0]}.${host}` },
            type: { type: "string", const: "TXT" },
            deleted: { type: "boolean", const: true },
            zone_record_removed: { type: "boolean" },
          }
        ),
        400: fail("INVALID_HOST_PREFIX — not a prefix this service writes. INVALID_DOMAIN — that root is not managed here."),
        403: fail("FORBIDDEN — no such subdomain under this caller."),
        404: fail("TXT_NOT_FOUND — that subdomain has no TXT record under this prefix."),
      },
    },
  };
}

/**
 * The OpenAPI document served at /openapi.json.
 *
 * Every operation carries the three answers any of them can give — an invalid
 * key, the rate limiter, and a fault of ours — so a client generated from this
 * handles them without having to be told separately.
 */
function openApi({ origin }) {
  const paths = {};
  for (const [key, operation] of Object.entries(operations(origin))) {
    const [method, path] = key.split(" ");
    paths[path] = paths[path] || {};
    paths[path][method.toLowerCase()] = {
      ...operation,
      responses: {
        ...operation.responses,
        401: { $ref: "#/components/responses/Unauthorized" },
        429: { $ref: "#/components/responses/RateLimited" },
        500: { $ref: "#/components/responses/ServerError" },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Sitey",
      version: "1.0.0",
      summary: SUMMARY,
      description: [
        SUMMARY,
        "",
        "Limits:",
        ...limitNotes().map((note) => `- ${note}`),
        "",
        `The same operations are available to an agent runtime over MCP at ${origin}/mcp ` +
          `(Streamable HTTP, one POST per message); ${origin}/.well-known/mcp.json describes it.`,
      ].join("\n"),
    },
    servers: [{ url: origin }],
    externalDocs: { description: "Docs", url: `${origin}/docs` },
    // Both, in this order: no credential at all is a supported way to call
    // every one of these, and it is how most callers arrive.
    security: [{}, { apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "An API key from the dashboard, sent as `Authorization: Bearer styo_…`. It makes " +
            "the records belong to an account rather than to an address. Anything else after " +
            "`Bearer ` is refused rather than treated as anonymous.",
        },
      },
      responses: {
        Unauthorized: fail("UNAUTHORIZED — the Authorization header carried something that is not a key of ours."),
        RateLimited: fail("RATE_LIMITED — more than 100 requests in a minute from one address. Wait and repeat."),
        ServerError: fail("INTERNAL_ERROR — ours, not yours. Nothing partial is left behind: a write that cannot finish is rolled back in full."),
      },
      schemas: {
        Error: {
          type: "object",
          description: "Every failure has this shape. Branch on `code`, log `message`.",
          properties: {
            error: { type: "boolean", const: true },
            message: { type: "string" },
            code: { type: "string" },
          },
          required: ["error", "message", "code"],
        },
        Subdomain: {
          type: "object",
          properties: {
            subdomain: { type: "string", example: "demo" },
            domain: { type: "string", example: hostOf(origin) },
            type: RECORD_TYPE,
            value: { type: "string", example: "203.0.113.10" },
            created_at: { type: "string", format: "date-time" },
            expires_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
  };
}

/**
 * The plain-text introduction at /llms.txt.
 *
 * Markdown, per llmstxt.org, and short on purpose: it is read by something
 * that has a question and a budget, so it answers "what is this, how do I call
 * it, what will stop me" and points at the two documents that hold the detail.
 * Nothing here is stated that the OpenAPI document does not also state — one
 * of them being newer than the other is how the file in public/ went wrong.
 */
function llmsTxt({ origin, domains }) {
  const host = hostOf(origin);
  const root = domains[0] || host;

  return [
    `# ${host}`,
    "",
    `> ${SUMMARY}`,
    "",
    "No account is needed to create one. A caller with no API key is identified by its",
    "IP address and owns what that address created; an API key from the dashboard puts the",
    "records under an account instead.",
    "",
    "The name comes first: a record whose target is not serving yet is created all the same,",
    "with `reachable: false` in the response saying so. Claim the address, then deploy to it.",
    "",
    "## Calling it",
    "",
    `- [OpenAPI 3.1 spec](${origin}/openapi.json): every REST operation, every error code.`,
    `- [MCP endpoint](${origin}/mcp): Streamable HTTP, stateless — one POST per JSON-RPC`,
    "  message. Nine tools, the same nine operations as the REST API.",
    `- [MCP manifest](${origin}/.well-known/mcp.json): what to hand an agent runtime.`,
    "",
    "Claiming a name is one request:",
    "",
    "```",
    `curl -X POST ${origin}/api/v1/subdomains \\`,
    "  -H 'content-type: application/json' \\",
    `  -d '{"subdomain":"demo","domain":"${root}","type":"A","value":"203.0.113.10"}'`,
    "```",
    "",
    `The roots you may create under are ${domains.join(", ")}. Ask ${origin}/api/v1/domains`,
    "rather than copying that list: which roots are on offer is a table, not a constant.",
    "",
    "## Limits",
    "",
    ...limitNotes().map((note) => `- ${note}`),
    "",
    "## Pages",
    "",
    `- [Docs](${origin}/docs): the same ground for a person, with the Vercel setup written out.`,
    `- [Blog](${origin}/blog): notes on running the service.`,
    "",
  ].join("\n");
}

module.exports = { SUMMARY, API_PREFIX, hostOf, limitNotes, mcpManifest, openApi, llmsTxt };
