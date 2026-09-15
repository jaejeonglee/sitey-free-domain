// plugins/mcp.js
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
const { checkSubdomainQuota } = require("../services/quota");
const accessLog = require("../services/access-log");
const anonCreateRate = require("../services/anon-create-rate");
const { validateHostPrefix, validateTxtValue } = require("../utils/validators");

const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const HOSTNAME_REGEX = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}\.?$/i;

/**
 * Client IP used as the anonymous ownership key.
 *
 * See routes/api-v1.js — `request.ip` respects the trusted proxy list, the raw
 * headers do not.
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

function mcpValidateRecordValue(recordType, value, subdomain, domain) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return { valid: false, message: "Record value is required." };
  }
  if (recordType === "A") {
    if (!IPV4_REGEX.test(trimmed)) {
      return { valid: false, message: "Provide a valid IPv4 address (e.g. 203.0.113.10)." };
    }
    return { valid: true, value: trimmed };
  }
  const candidate = trimmed.toLowerCase();
  if (!HOSTNAME_REGEX.test(candidate)) {
    return { valid: false, message: "Provide a valid hostname (e.g. app.example.com)." };
  }
  const fullDomain = `${subdomain}.${domain}`.toLowerCase();
  if (candidate.replace(/\.$/, "") === fullDomain.replace(/\.$/, "")) {
    return { valid: false, message: "CNAME target cannot point to itself." };
  }
  return { valid: true, value: candidate.replace(/\.$/, "") };
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
    "Create a new DNS record for a subdomain. Supports A records (IP address) and CNAME records (hostname). Example: create demo.sitey.my pointing to 1.2.3.4. " +
      "The target does not have to be serving yet: claim the name first and deploy to it second if that is your order. The result carries reachable:false when nothing answered, and the record is created either way.",
    {
      subdomain: z.string().describe("Subdomain name (e.g. 'demo')"),
      domain: z.string().describe("Root domain (e.g. 'sitey.my')"),
      type: z.enum(["A", "CNAME"]).describe("Record type"),
      value: z.string().describe("Record value (IP for A, hostname for CNAME)"),
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, type, value }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();
      const recordType = type;

      const auth = extra._meta?.auth;
      if (!auth) return mcpError("Internal error: auth context missing.");
      if (auth.mode === "invalid_key") return mcpError("Invalid API key.");

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
      // The subject is the hashed client IP, the same one the access log puts
      // in `iph`, so a refusal can be tied back to the request that got it.
      if (auth.mode === "ip") {
        const gate = anonCreateRate.check(accessLog.hashIp(auth.ip));
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
        ip: auth.mode === "ip" ? auth.ip : null,
        subject: accessLog.subjectOf({ apiAuth: auth }),
      });
      if (quota.blocked) {
        return mcpErrorObj({
          error:
            quota.scope === "account"
              ? `You are holding ${quota.held} subdomains and the limit for this account is ${quota.limit}. Delete one before creating another.`
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

      try {
        const newRecord = await createSubdomain(fastify, {
          userId: auth.mode === "apikey" ? auth.userId : null,
          domainId: domainEntry.id,
          subdomain,
          domain: domainEntry.domain,
          recordValue,
          recordType,
          ownerType: auth.mode === "apikey" ? "user" : "agent",
          ownerIp: auth.mode === "ip" ? auth.ip : null,
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
    "List all subdomains you own. Returns subdomain name, domain, record type, value, and creation date. Filtered by your API key or IP address.",
    {},
    async (_, extra) => {
      const auth = extra._meta?.auth;
      if (!auth) return mcpError("Internal error: auth context missing.");
      if (auth.mode === "invalid_key") return mcpError("Invalid API key.");

      let rows;
      if (auth.mode === "apikey") {
        [rows] = await fastify.mysql.execute(
          "SELECT s.subdomain, m.domain_name AS domain, s.record_type AS type, s.record_value AS value, s.created_at, s.expires_at FROM subdomains s JOIN managed_domains m ON s.domain_id = m.id WHERE s.user_id = ? ORDER BY s.created_at DESC",
          [auth.userId]
        );
      } else {
        [rows] = await fastify.mysql.execute(
          "SELECT s.subdomain, m.domain_name AS domain, s.record_type AS type, s.record_value AS value, s.created_at, s.expires_at FROM subdomains s JOIN managed_domains m ON s.domain_id = m.id WHERE s.owner_ip = ? AND s.owner_type = 'agent' ORDER BY s.created_at DESC",
          [auth.ip]
        );
      }

      return mcpSuccess({
        subdomains: rows,
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
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const auth = extra._meta?.auth;
      if (!auth) return mcpError("Internal error: auth context missing.");
      if (auth.mode === "invalid_key") return mcpError("Invalid API key.");

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      let record;
      if (auth.mode === "apikey") {
        const [rows] = await fastify.mysql.execute(
          "SELECT id FROM subdomains WHERE subdomain = ? AND domain_id = ? AND user_id = ?",
          [subdomain, domainEntry.id, auth.userId]
        );
        record = rows[0];
      } else {
        const [rows] = await fastify.mysql.execute(
          "SELECT id FROM subdomains WHERE subdomain = ? AND domain_id = ? AND owner_ip = ? AND owner_type = 'agent'",
          [subdomain, domainEntry.id, auth.ip]
        );
        record = rows[0];
      }

      if (!record) {
        return mcpError("Subdomain not found or you don't have permission.");
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
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, value }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const auth = extra._meta?.auth;
      if (!auth) return mcpError("Internal error: auth context missing.");
      if (auth.mode === "invalid_key") return mcpError("Invalid API key.");

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      let record;
      if (auth.mode === "apikey") {
        const [rows] = await fastify.mysql.execute(
          "SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND user_id = ?",
          [subdomain, domainEntry.id, auth.userId]
        );
        record = rows[0];
      } else {
        const [rows] = await fastify.mysql.execute(
          "SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND owner_ip = ? AND owner_type = 'agent'",
          [subdomain, domainEntry.id, auth.ip]
        );
        record = rows[0];
      }

      if (!record) {
        const msg = auth.mode === "ip"
          ? "Subdomain not found or you don't have permission. If your IP has changed, sign up at sitey.my to manage it."
          : "Subdomain not found or you do not own this record.";
        return mcpError(msg);
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
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const auth = extra._meta?.auth;
      if (!auth) return mcpError("Internal error: auth context missing.");
      if (auth.mode === "invalid_key") return mcpError("Invalid API key.");

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      let record;
      if (auth.mode === "apikey") {
        const [rows] = await fastify.mysql.execute(
          "SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND user_id = ?",
          [subdomain, domainEntry.id, auth.userId]
        );
        record = rows[0];
      } else {
        const [rows] = await fastify.mysql.execute(
          "SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND owner_ip = ? AND owner_type = 'agent'",
          [subdomain, domainEntry.id, auth.ip]
        );
        record = rows[0];
      }

      if (!record) {
        const msg = auth.mode === "ip"
          ? "Subdomain not found or you don't have permission. If your IP has changed, sign up at sitey.my to manage it."
          : "Subdomain not found or you do not own this record.";
        return mcpError(msg);
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
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, host_prefix: rawHostPrefix, value: txtValue, root_level: rootLevel }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const auth = extra._meta?.auth;
      if (!auth) return mcpError("Internal error: auth context missing.");
      if (auth.mode === "invalid_key") return mcpError("Invalid API key.");

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      // Verify ownership: user must own the subdomain to add TXT
      let record;
      if (auth.mode === "apikey") {
        const [rows] = await fastify.mysql.execute(
          "SELECT id FROM subdomains WHERE subdomain = ? AND domain_id = ? AND user_id = ?",
          [subdomain, domainEntry.id, auth.userId]
        );
        record = rows[0];
      } else {
        const [rows] = await fastify.mysql.execute(
          "SELECT id FROM subdomains WHERE subdomain = ? AND domain_id = ? AND owner_ip = ? AND owner_type = 'agent'",
          [subdomain, domainEntry.id, auth.ip]
        );
        record = rows[0];
      }

      if (!record) {
        return mcpError("You must own the subdomain before adding TXT records. Create the subdomain first.");
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
    },
    async ({ subdomain: rawSubdomain, domain: rawDomain, host_prefix: rawHostPrefix }, extra) => {
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (rawDomain || "").trim().toLowerCase();

      const auth = extra._meta?.auth;
      if (!auth) return mcpError("Internal error: auth context missing.");
      if (auth.mode === "invalid_key") return mcpError("Invalid API key.");

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find((d) => d.normalized === domainName);
      if (!domainEntry) return mcpError("Domain is not managed by this service.");

      // Verify ownership
      let record;
      if (auth.mode === "apikey") {
        const [rows] = await fastify.mysql.execute(
          "SELECT id FROM subdomains WHERE subdomain = ? AND domain_id = ? AND user_id = ?",
          [subdomain, domainEntry.id, auth.userId]
        );
        record = rows[0];
      } else {
        const [rows] = await fastify.mysql.execute(
          "SELECT id FROM subdomains WHERE subdomain = ? AND domain_id = ? AND owner_ip = ? AND owner_type = 'agent'",
          [subdomain, domainEntry.id, auth.ip]
        );
        record = rows[0];
      }

      if (!record) {
        return mcpError("Subdomain not found or you don't have permission.");
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
