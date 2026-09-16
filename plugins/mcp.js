// plugins/mcp.js — the same operations as the REST API, as MCP tools.
//
// Auth arrives by two different roads here. An API key is an HTTP header on
// the POST that wraps the call; an anonymous owner token is a tool *argument*,
// because one POST may carry a batch of calls and JSON-RPC has nowhere to hang
// a per-call header. services/anon-token.js is where the token itself lives.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const config = require("../configs/index");
const bindService = require("../services/bind");
const { noteReachability } = require("../services/validation");
const { createSubdomain, updateSubdomain, deleteSubdomain } = require("../services/subdomain");
const { renewSubdomain, renewalNotDueMessage } = require("../services/expiry");
const { getManagedDomains } = require("../services/managedDomain");
const { isBlacklisted } = require("../services/blacklist");
const { hashKey, validateKey } = require("../services/api-key");
const anonToken = require("../services/anon-token");
const { checkSubdomainQuota } = require("../services/quota");
const accessLog = require("../services/access-log");
const anonCreateRate = require("../services/anon-create-rate");
const redirectHits = require("../services/redirect-hits");
const {
  validateHostPrefix,
  validateTxtValue,
  validateRecordValue,
} = require("../utils/validators");

const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Client IP: the fallback owner, for records made before owner tokens existed.
 *
 * See routes/api-v1.js — `request.ip` respects the trusted proxy list, the raw
 * headers do not. It is a weak identity even when it is honest, which is what
 * services/anon-token.js is about.
 */
function getClientIp(request) {
  return request.ip;
}

/**
 * Resolve auth context from Fastify request
 */
async function resolveAuth(fastify, request) {
  const authHeader = request.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer styo_")) {
    const rawKey = authHeader.slice(7); // "Bearer ".length
    const keyHash = hashKey(rawKey);
    const user = await validateKey(fastify, keyHash);
    if (!user) {
      return { mode: "invalid_key" };
    }
    return { mode: "apikey", userId: user.user_id, email: user.email, name: user.name };
  }
  return { mode: "ip", ip: getClientIp(request) };
}

/** The argument every tool that touches somebody's record now takes. */
const OWNER_TOKEN_ARG = z
  .string()
  .optional()
  .describe(
    "The owner token you were given when you created the record (starts with anon_). " +
      "Omit it only if you have an API key, or if the record predates tokens and was claimed " +
      "from this same IP address. Creating without one mints a new one and returns it once."
  );

/**
 * The caller, once the tool argument has had its say.
 *
 * JSON-RPC has nowhere sensible to hang a header of its own — one HTTP POST can
 * carry a batch of calls for different tools — so an anonymous caller passes
 * its token as an ordinary argument. An API key still arrives in the
 * Authorization header of the POST that wraps the call.
 *
 * Holding both is refused rather than resolved. They name two different owners,
 * and picking one silently would mean writing a record under an owner the
 * caller did not ask for; there is no reading of "here are two identities" that
 * we can be confident about.
 *
 * @returns {{auth: object}|{error: string}}
 */
function withOwnerToken(auth, rawToken) {
  const given = typeof rawToken === "string" && rawToken.length > 0;
  if (!given) return { auth };
  if (auth.mode === "apikey") {
    return {
      error:
        "An API key and an owner_token name two different owners. Send one: the key for " +
        "records under your account, the token for records created without one.",
    };
  }
  if (!anonToken.isWellFormed(rawToken)) {
    // Refused, not ignored. Falling back to the address would quietly put the
    // caller somewhere else and answer "not found" for its own records.
    return {
      error:
        "owner_token is not one of ours: it should look like anon_ followed by 32 " +
        "hex characters, exactly as it was returned by create_subdomain.",
    };
  }
  return {
    auth: { mode: "token", tokenHash: anonToken.hashToken(rawToken), ip: auth.ip },
  };
}

/** Resolve the caller for one tool call, or the error to answer with. */
function callerFor(extra, rawToken) {
  const base = extra._meta?.auth;
  if (!base) return { error: "Internal error: auth context missing." };
  if (base.mode === "invalid_key") return { error: "Invalid API key." };
  return withOwnerToken(base, rawToken);
}

/**
 * The record this caller owns under that name, or undefined.
 *
 * One lookup for all five tools that need one. They each had their own copy of
 * the SQL, which was survivable while there was a single anonymous branch to
 * get right and is not now: the address branch has to carry
 * `owner_token_hash IS NULL` or a caller behind a shared NAT still reaches a
 * stranger's records, and that condition has to be in one place to stay true.
 */
async function findOwned(fastify, auth, subdomain, domainId) {
  const owner = anonToken.ownerPredicate(auth);
  const [rows] = await fastify.mysql.execute(
    `SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND ${owner.sql}`,
    [subdomain, domainId, ...owner.params]
  );
  return rows[0];
}

/**
 * Why the caller cannot see it — as far as we are willing to say.
 *
 * Never "it exists and is somebody else's": that would turn this into a way to
 * ask who owns a name. What differs is the way *out*, and that depends on what
 * the caller presented.
 */
function notFoundMessage(auth) {
  if (auth.mode === "token") {
    return "Subdomain not found, or it does not belong to this owner_token.";
  }
  if (auth.mode === "ip") {
    return (
      "Subdomain not found, or you don't have permission. If you created it and were given " +
      "an owner_token, pass that token as owner_token — records are owned by the token, not " +
      "by the address they were created from."
    );
  }
  return "Subdomain not found or you do not own this record.";
}

/**
 * The same rules the REST API applies, from the same function. This used to be
 * a copy of utils/validators.js validateRecordValue; a third record type with
 * rules of its own (REDIRECT, services/redirect-safety.js) is not something to
 * keep in two places.
 */
function mcpValidateRecordValue(recordType, value, subdomain, domain) {
  return validateRecordValue(recordType, value, { subdomain, domain });
}

function mcpError(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function mcpErrorObj(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }], isError: true };
}

function mcpSuccess(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * Inject auth context into _meta of each JSON-RPC message's params
 */
function injectAuth(body, auth) {
  if (Array.isArray(body)) {
    for (const msg of body) {
      injectAuthSingle(msg, auth);
    }
  } else if (body && typeof body === "object") {
    injectAuthSingle(body, auth);
  }
  return body;
}

function injectAuthSingle(msg, auth) {
  if (msg && typeof msg === "object" && msg.params && typeof msg.params === "object") {
    if (!msg.params._meta) {
      msg.params._meta = {};
    }
    msg.params._meta.auth = auth;
  }
}

/**
 * Create and configure a new McpServer with all tools registered.
 * We create a fresh server per request because the SDK's connect()
 * binds exclusively to one transport.
 */
function createMcpServer(fastify) {
  const server = new McpServer({
    // 도메인이 아니라 서비스 이름이다. 예전엔 "sitey.one" 이었는데 정본이
    // sitey.my 로 옮겨간 뒤에도 이 줄만 남아 있었다 — 레지스트리에는
    // sitey.my 로 올려두고 붙으면 sitey.one 이라고 말하던 상태.
    name: "sitey",
    version: "1.0.0",
  });

  // --- Tool: list_domains ---
  server.tool(
    "list_domains",
    "List available root domains (e.g. sitey.my, sitey.one) that you can create subdomains under. Call this first to know which domains are available.",
    {},
    async () => {
      const managedDomains = await getManagedDomains(fastify);
      const domains = managedDomains.map((d) => d.domain);
      return mcpSuccess({ domains, hint: "Use one of these as the 'domain' parameter when creating subdomains." });
    }
  );

  // --- Tool: check_availability ---
  server.tool(
    "check_availability",
    "Check if a specific subdomain name is available for registration under a given domain. Returns true if the name is free to claim.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain }) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      if (!subdomain || !SUBDOMAIN_REGEX.test(subdomain)) {
        return mcpError("Invalid subdomain format.");
      }

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) {
        return mcpErrorObj({ error: "Domain is not managed by this service.", available_domains: managedDomains.map((d) => d.domain) });
      }

      const isTakenInBind = await bindService.findDnsRecord(subdomain, domainEntry.domain);
      const [rows] = await fastify.mysql.execute(
        "SELECT 1 FROM subdomains WHERE subdomain = ? AND domain_id = ? LIMIT 1",
        [subdomain, domainEntry.id]
      );
      const available = !isTakenInBind && rows.length === 0;

      return mcpSuccess({
        available,
        subdomain,
        domain: domainEntry.domain,
        fullSubdomain: `${subdomain}.${domainEntry.domain}`,
      });
    }
  );

  // --- Tool: create_subdomain ---
  server.tool(
    "create_subdomain",
    "Create a new DNS record for a subdomain. Supports A records (IP address), CNAME records (hostname) and REDIRECT records (an https:// URL — visitors to the name are sent there with a 301). Example: create demo.sitey.my pointing to 1.2.3.4. " +
      "No account, API key or signup is needed. " +
      "The target does not have to be serving yet: claim the name first and deploy to it second if that is your order. The result carries reachable:false when nothing answered, and the record is created either way. " +
      "If you send no owner_token, the result carries a new one under 'owner_token' — save it, it is shown once and is the only way to change or delete this record later.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
      type: z
        .enum(["A", "CNAME", "REDIRECT"])
        .describe("Record type. REDIRECT answers every visit with a 301 to the URL in value."),
      value: z
        .string()
        .describe(
          "Record value: an IPv4 address for A, a hostname for CNAME, an absolute https:// URL for REDIRECT " +
            "(http:// is refused, and so is a URL under one of this service's own roots)."
        ),
      owner_token: OWNER_TOKEN_ARG,
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, type, value, owner_token: ownerToken }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();
      const recordType = type;

      const caller = callerFor(extra, ownerToken);
      if (caller.error) return mcpError(caller.error);
      const auth = caller.auth;

      if (!subdomain || !SUBDOMAIN_REGEX.test(subdomain)) {
        return mcpError("Invalid subdomain format.");
      }

      const blacklistCheck = isBlacklisted(subdomain);
      if (blacklistCheck.blocked) {
        return mcpError(blacklistCheck.reason);
      }

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) {
        return mcpErrorObj({ error: "Domain is not managed by this service.", available_domains: managedDomains.map((d) => d.domain) });
      }

      const validation = mcpValidateRecordValue(recordType, value, subdomain, domainEntry.domain);
      if (!validation.valid) return mcpError(validation.message);
      const recordValue = validation.value;

      // Counted per caller, not per process — services/anon-create-rate.js.
      // The subject is whatever the access log calls this caller: `t:` and the
      // head of the token hash when it has one, otherwise the hashed IP it
      // writes as `iph`. Either way a refusal can be tied back to the request
      // that got it.
      //
      // 🔴 A token subject is weaker than an address as a flood guard, because
      // a token is free to mint and an address is not. What stops that being a
      // hole is that the pair of limits do different jobs: this one is about
      // fairness between anonymous callers — the reason it stopped being one
      // global bucket — while the ceilings that actually bound abuse are the
      // quota below (an unhatched token is counted against its address, see
      // services/quota.js) and the 100-a-minute @fastify/rate-limit in app.js,
      // which keys on the address for every request including these.
      if (auth.mode === "ip" || auth.mode === "token") {
        const subject = accessLog.subjectOf({ apiAuth: auth }) || accessLog.hashIp(auth.ip);
        const gate = anonCreateRate.check(subject);
        if (gate.reason === "capacity") {
          // Never silent: this is us refusing callers we have no room to
          // count, which is a different problem from a caller being over the
          // limit and needs to be visible while it is happening.
          fastify.log.warn(
            { evt: "anon_rate", action: "full", subjects: anonCreateRate.subjectCount() },
            "Anonymous create limiter is full — refusing callers it cannot count."
          );
        }
        if (!gate.ok) {
          return mcpError("Too many anonymous create requests. Please wait a moment.");
        }
      }

      // How many this caller already holds. An agent is counted and refused on
      // exactly the same number as a person — see services/quota.js — and an
      // account is refused only once SUBDOMAIN_LIMIT_ENFORCED is on.
      //
      // Nothing here ever asks for payment. 402 is an HTTP status and a
      // JSON-RPC tool result has nowhere to put one, so the payment path lives
      // on the REST endpoint that has a status line to carry it.
      const quota = await checkSubdomainQuota(fastify, {
        userId: auth.mode === "apikey" ? auth.userId : null,
        tokenHash: auth.mode === "token" ? auth.tokenHash : null,
        ip: auth.mode === "apikey" ? null : auth.ip,
        subject: accessLog.subjectOf({ apiAuth: auth }),
      });
      if (quota.blocked) {
        return mcpErrorObj({
          error:
            quota.scope === "account"
              ? `You are holding ${quota.held} subdomains and the limit for this account is ${quota.limit}. Delete one before creating another.`
              : quota.scope === "token"
                ? `This owner_token is holding ${quota.held} subdomains and may hold ${quota.limit}. Delete one before creating another.`
                : `Anonymous callers may hold ${quota.limit} subdomains per address and you are holding ${quota.held}. An API key holds them under an account, on the same limit.`,
          code: "LIMIT_REACHED",
          held: quota.held,
          limit: quota.limit,
        });
      }

      // Reachability, recorded rather than enforced. An agent claims the name
      // before it has anywhere to point it, which is the order this tool is
      // for; refusing here shut the door on its own use case.
      // services/validation.js carries the reasoning.
      const reach = await noteReachability(fastify.log, {
        recordType,
        recordValue,
        subdomain,
        domain: domainEntry.domain,
        phase: "create",
      });

      // 🔴 The property this whole tool exists for: a call with no API key and
      // no owner_token still succeeds, and is handed a token on the way out.
      // An agent that had to fetch something first could not use this at all —
      // fetching means a signup page, and a signup page means a person.
      const issued = auth.mode === "ip" ? anonToken.generateToken() : null;

      try {
        const newRecord = await createSubdomain(fastify, {
          userId: auth.mode === "apikey" ? auth.userId : null,
          domainId: domainEntry.id,
          subdomain,
          domain: domainEntry.domain,
          recordValue,
          recordType,
          ownerType: auth.mode === "apikey" ? "user" : "agent",
          // Written for a token owner too: not as proof, but because the quota
          // counts how many tokens an address has hatched (services/quota.js).
          ownerIp: auth.mode === "apikey" ? null : auth.ip,
          ownerTokenHash: issued ? issued.hash : (auth.mode === "token" ? auth.tokenHash : null),
        });

        return mcpSuccess({
          success: true,
          fullSubdomain: newRecord.name,
          type: newRecord.type,
          value: recordValue,
          // Nothing writes to an agent, so the date it has to act on comes
          // back with every read. renew_subdomain resets it.
          expires_at: newRecord.expiresAt,
          renew_with: "renew_subdomain",
          reachable: reach.ok,
          ...(reach.note ? { note: reach.note } : {}),
          // Once, on the create that minted it, and never again — only the
          // hash is kept. The note in the same object says so, because an
          // agent that drops this has lost the record until it expires.
          ...(issued
            ? { owner_token: issued.token, owner_token_note: anonToken.TOKEN_NOTE }
            : {}),
        });
      } catch (error) {
        if (error.statusCode === 409) {
          return mcpError("This subdomain is already in use.");
        }
        fastify.log.error(error, "MCP create_subdomain failed");
        return mcpError("Server error during subdomain creation.");
      }
    }
  );

  // --- Tool: list_subdomains ---
  server.tool(
    "list_subdomains",
    "List all subdomains you own. Returns subdomain name, domain, record type, value, and creation date. A REDIRECT record also carries hits: how many visits it has answered in total, how many this calendar month, and when the last one was. Filtered by your API key, or by the owner_token you pass, or — for records made before tokens existed — by your IP address.",
    { owner_token: OWNER_TOKEN_ARG },
    async ({ owner_token: ownerToken } = {}, extra) => {
      const caller = callerFor(extra, ownerToken);
      if (caller.error) return mcpError(caller.error);
      const auth = caller.auth;

      // The same predicate the ownership checks use: a listing that showed a
      // row the caller cannot then touch would be its own bug.
      const owner = anonToken.ownerPredicate(auth, "s.");
      const [rows] = await fastify.mysql.execute(
        "SELECT s.id, s.subdomain, m.domain_name AS domain, s.record_type AS type, s.record_value AS value, s.created_at, s.expires_at FROM subdomains s JOIN managed_domains m ON s.domain_id = m.id " +
          `WHERE ${owner.sql} ORDER BY s.created_at DESC`,
        owner.params
      );

      // Only REDIRECT rows get `hits` — the other two are visited straight
      // from DNS and we never see the request, so a zero there would read as
      // "nobody came" rather than "we cannot know". routes/api-v1.js says the
      // same in withHits(); the id is dropped for the same reason.
      const byId = await redirectHits.hitsFor(
        fastify,
        rows.filter((row) => row.type === "REDIRECT").map((row) => row.id)
      );

      return mcpSuccess({
        subdomains: rows.map(({ id, ...rest }) =>
          byId.has(id) ? { ...rest, hits: byId.get(id) } : rest
        ),
        hint: "expires_at is when each record is released. Call renew_subdomain before then to reset it.",
      });
    }
  );

  // --- Tool: renew_subdomain ---
  server.tool(
    "renew_subdomain",
    "Extend a subdomain you own before it expires. Subdomains are lent for a period, not given: agent-created records last one month and user records three. Nothing emails an agent, so read expires_at from list_subdomains and call this before that date. One call resets the clock from today. Renewal only opens in the last two weeks before expires_at — an earlier call is refused and tells you the date it opens.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
      owner_token: OWNER_TOKEN_ARG,
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, owner_token: ownerToken }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const caller = callerFor(extra, ownerToken);
      if (caller.error) return mcpError(caller.error);
      const auth = caller.auth;

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      const record = await findOwned(fastify, auth, subdomain, domainEntry.id);
      if (!record) {
        return mcpError(notFoundMessage(auth));
      }

      try {
        const renewal = await renewSubdomain(fastify, record.id);
        if (!renewal.renewed) {
          if (renewal.reason === "not_found") return mcpError("Subdomain not found.");
          // Outside the window (services/expiry.js). The date it opens is the
          // whole of the answer — an agent told only "too early" can do
          // nothing but poll.
          return mcpErrorObj({
            error: renewalNotDueMessage(renewal),
            code: "RENEWAL_NOT_DUE",
            expires_at: renewal.expiresAt,
            renew_from: renewal.opensAt,
          });
        }

        return mcpSuccess({
          success: true,
          fullSubdomain: `${subdomain}.${domainEntry.domain}`,
          expires_at: renewal.expiresAt,
        });
      } catch (error) {
        fastify.log.error(error, "MCP renew_subdomain failed");
        return mcpError("Server error during renewal.");
      }
    }
  );

  // --- Tool: update_subdomain ---
  server.tool(
    "update_subdomain",
    "Update the DNS record value of a subdomain you own. For example, change the IP address that demo.sitey.my points to. " +
      "The new target does not have to be serving yet; the result carries reachable:false when nothing answered, and the record is moved either way.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
      value: z.string().describe("New record value"),
      owner_token: OWNER_TOKEN_ARG,
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, value, owner_token: ownerToken }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const caller = callerFor(extra, ownerToken);
      if (caller.error) return mcpError(caller.error);
      const auth = caller.auth;

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      const record = await findOwned(fastify, auth, subdomain, domainEntry.id);
      if (!record) {
        // This used to end "If your IP has changed, sign up at sitey.my to
        // manage it" — advice an agent cannot take, and the clearest admission
        // that the address was the wrong thing to own a record by.
        return mcpError(notFoundMessage(auth));
      }

      const recordType = bindService.normalizeRecordType(record.record_type);
      const validation = mcpValidateRecordValue(recordType, value, subdomain, domainEntry.domain);
      if (!validation.valid) return mcpError(validation.message);
      const recordValue = validation.value;

      // Recorded rather than enforced — as on create.
      const reach = await noteReachability(fastify.log, {
        recordType,
        recordValue,
        subdomain,
        domain: domainEntry.domain,
        phase: "update",
      });

      try {
        await updateSubdomain(fastify, {
          recordId: record.id,
          subdomain,
          domain: domainEntry.domain,
          recordValue,
          recordType,
        });

        return mcpSuccess({
          success: true,
          fullSubdomain: `${subdomain}.${domainEntry.domain}`,
          value: recordValue,
          reachable: reach.ok,
          ...(reach.note ? { note: reach.note } : {}),
        });
      } catch (error) {
        fastify.log.error(error, "MCP update_subdomain failed");
        return mcpError("Server error during subdomain update.");
      }
    }
  );

  // --- Tool: delete_subdomain ---
  server.tool(
    "delete_subdomain",
    "Permanently delete a subdomain DNS record you own. The subdomain will stop resolving immediately.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
      owner_token: OWNER_TOKEN_ARG,
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, owner_token: ownerToken }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const caller = callerFor(extra, ownerToken);
      if (caller.error) return mcpError(caller.error);
      const auth = caller.auth;

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      const record = await findOwned(fastify, auth, subdomain, domainEntry.id);
      if (!record) {
        return mcpError(notFoundMessage(auth));
      }

      const recordType = bindService.normalizeRecordType(record.record_type);

      try {
        await deleteSubdomain(fastify, {
          recordId: record.id,
          subdomain,
          domain: domainEntry.domain,
          recordType,
        });

        return mcpSuccess({
          success: true,
          fullSubdomain: `${subdomain}.${domainEntry.domain}`,
        });
      } catch (error) {
        fastify.log.error(error, "MCP delete_subdomain failed");
        return mcpError("Server error during subdomain deletion.");
      }
    }
  );

  // --- Tool: create_txt_record ---
  server.tool(
    "create_txt_record",
    "Create or update a TXT record for domain verification. Used for services like Vercel (_vercel) and Netlify that require DNS-based ownership proof. The record is placed at the root domain under the prefix you give (e.g. _vercel.sitey.my), alongside the other owners' values — that is the name Vercel reads for a subdomain of sitey.my.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
      host_prefix: z.string().describe("TXT record host prefix (e.g. '_vercel' for Vercel verification)"),
      value: z.string().describe("TXT record value (the verification token)"),
      root_level: z.boolean().optional().describe("No longer supported — TXT records are always written at the root domain. Passing true returns an error."),
      owner_token: OWNER_TOKEN_ARG,
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, host_prefix: rawHostPrefix, value: txtValue, root_level: rootLevel, owner_token: ownerToken }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const caller = callerFor(extra, ownerToken);
      if (caller.error) return mcpError(caller.error);
      const auth = caller.auth;

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      // Verify ownership: the caller must own the subdomain to add TXT
      const record = await findOwned(fastify, auth, subdomain, domainEntry.id);
      if (!record) {
        return mcpError("You must own the subdomain before adding TXT records. Create the subdomain first, and pass the owner_token it returned.");
      }

      if (!rawHostPrefix || !txtValue) {
        return mcpError("host_prefix and value are required.");
      }

      // See routes/api-v1.js: every TXT record goes to the root domain now, so
      // the flag no longer selects anything.
      if (rootLevel) {
        return mcpError(
          "root_level is no longer supported: TXT records are always written at the root domain " +
            "under host_prefix, which is where verification services look. Omit the flag."
        );
      }

      const prefixValidation = validateHostPrefix(rawHostPrefix, {
        allowed: config.txt.apexPrefixes,
      });
      if (!prefixValidation.valid) {
        return mcpError(prefixValidation.message);
      }
      const hostPrefix = prefixValidation.value;

      // The value is written as `"<value>"` into the zone file; REST already
      // rejects quotes/newlines/control characters, MCP did not.
      const txtValidation = validateTxtValue(txtValue);
      if (!txtValidation.valid) {
        return mcpError(txtValidation.message);
      }
      const sanitizedTxtValue = txtValidation.value;

      try {
        // The stored value is not bookkeeping: TXT records all share one name,
        // so it is the only handle delete_txt_record has on this line. This
        // tool used to write the zone without recording anything, which left
        // its records undeletable. Mirror what REST does.
        const [prevRows] = await fastify.mysql.execute(
          "SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
          [record.id, hostPrefix]
        );

        const txtRecord = await bindService.addTxtRecord(
          subdomain,
          domainEntry.domain,
          hostPrefix,
          sanitizedTxtValue,
          prevRows[0]?.txt_value || null
        );
        await fastify.mysql.execute(
          "INSERT INTO subdomain_txt_records (subdomain_id, host_prefix, txt_value) VALUES (?, ?, ?) " +
            "ON DUPLICATE KEY UPDATE txt_value = VALUES(txt_value)",
          [record.id, hostPrefix, sanitizedTxtValue]
        );
        return mcpSuccess({
          success: true,
          record: txtRecord.name,
          type: "TXT",
          value: sanitizedTxtValue,
        });
      } catch (error) {
        fastify.log.error(error, "MCP create_txt_record failed");
        return mcpError("Server error during TXT record creation.");
      }
    }
  );

  // --- Tool: delete_txt_record ---
  server.tool(
    "delete_txt_record",
    "Delete a TXT verification record from a subdomain you own.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
      host_prefix: z.string().describe("TXT record host prefix (e.g. '_vercel')"),
      owner_token: OWNER_TOKEN_ARG,
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, host_prefix: rawHostPrefix, owner_token: ownerToken }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const caller = callerFor(extra, ownerToken);
      if (caller.error) return mcpError(caller.error);
      const auth = caller.auth;

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      // Verify ownership
      const record = await findOwned(fastify, auth, subdomain, domainEntry.id);
      if (!record) {
        return mcpError(notFoundMessage(auth));
      }

      const prefixValidation = validateHostPrefix(rawHostPrefix);
      if (!prefixValidation.valid) {
        return mcpError(prefixValidation.message);
      }
      const hostPrefix = prefixValidation.value;

      try {
        const [txtRows] = await fastify.mysql.execute(
          "SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
          [record.id, hostPrefix]
        );
        if (!txtRows.length) {
          return mcpError("No TXT record with that host_prefix on this subdomain.");
        }

        const txtRecord = await bindService.deleteTxtRecord(
          subdomain,
          domainEntry.domain,
          hostPrefix,
          txtRows[0].txt_value
        );
        await fastify.mysql.execute(
          "DELETE FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
          [record.id, hostPrefix]
        );
        return mcpSuccess({
          success: true,
          record: txtRecord.name,
          type: "TXT",
          deleted: true,
          zone_record_removed: txtRecord.deleted === true,
        });
      } catch (error) {
        fastify.log.error(error, "MCP delete_txt_record failed");
        return mcpError("Server error during TXT record deletion.");
      }
    }
  );

  return server;
}

async function mcpPlugin(fastify, options) {
  // POST /mcp — main MCP endpoint (Streamable HTTP)
  fastify.post("/mcp", async (request, reply) => {
    const auth = await resolveAuth(fastify, request);

    const server = createMcpServer(fastify);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    // Inject auth into _meta of each JSON-RPC message
    const body = injectAuth(request.body, auth);

    // Hijack: transport writes directly to the raw response
    reply.hijack();

    reply.raw.on("close", () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, body);
  });

  // GET /mcp — not supported in stateless mode
  fastify.get("/mcp", async (request, reply) => {
    reply.code(405).send({ error: "Use POST for MCP requests." });
  });

  // DELETE /mcp — session cleanup (stateless, just acknowledge)
  fastify.delete("/mcp", async (request, reply) => {
    reply.code(200).send({ message: "Session ended." });
  });

  fastify.log.info("MCP server plugin registered on /mcp");
}

module.exports = mcpPlugin;
