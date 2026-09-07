// routes/api-v1.js — REST API /api/v1/ (external, API key + anonymous IP auth)
const config = require("../configs/index");
const bindService = require("../services/bind");
const { validateRecord } = require("../services/validation");
const { createSubdomain, updateSubdomain, deleteSubdomain } = require("../services/subdomain");
const { getManagedDomains } = require("../services/managedDomain");
const { isBlacklisted } = require("../services/blacklist");
const { hashKey, validateKey } = require("../services/api-key");
const {
  isValidSubdomain,
  validateHostPrefix,
  validateRecordValue,
  validateTxtValue,
} = require("../utils/validators");

const IP_SUBDOMAIN_LIMIT = 3;

/**
 * Client IP used as the anonymous ownership key.
 *
 * `request.ip` is derived by Fastify from the configured trusted proxy list
 * (see configs/index.js). Reading cf-connecting-ip / x-forwarded-for directly
 * meant any caller could pick their own identity with one header and read,
 * change or delete another anonymous user's subdomains.
 */
function getClientIp(request) {
  return request.ip;
}

/**
 * Resolve auth context from Authorization header
 * Returns: { mode: "apikey", userId, email, name }
 *        | { mode: "ip", ip }
 *        | { mode: "invalid_key" }
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
  if (authHeader && authHeader.startsWith("Bearer ")) {
    // Has a Bearer token but not styo_ prefix — invalid
    return { mode: "invalid_key" };
  }
  return { mode: "ip", ip: getClientIp(request) };
}

/**
 * Build success response
 */
function ok(data) {
  return { success: true, data };
}

/**
 * Build error and throw
 */
function apiError(statusCode, message, code) {
  const err = Object.assign(new Error(message), { statusCode });
  err.apiCode = code;
  throw err;
}

/**
 * Resolve managed domain entry or throw
 */
async function resolveDomain(fastify, rawDomain) {
  const domainName = (rawDomain || "").trim().toLowerCase();
  const managedDomains = await getManagedDomains(fastify);
  const entry = managedDomains.find((d) => d.normalized === domainName);
  if (!entry) {
    apiError(400, "Domain is not managed by this service.", "INVALID_DOMAIN");
  }
  return entry;
}

async function apiV1Routes(fastify, options) {
  // --- Auth preHandler ---
  fastify.addHook("preHandler", async (request, reply) => {
    const auth = await resolveAuth(fastify, request);
    if (auth.mode === "invalid_key") {
      return reply.code(401).send({
        error: true,
        message: "Invalid API key.",
        code: "UNAUTHORIZED",
      });
    }
    request.apiAuth = auth;
  });

  // --- Error handler: format errors as { error, message, code } ---
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      fastify.log.error(error);
    }
    return reply.code(statusCode).send({
      error: true,
      message: error.message || "Internal server error",
      code: error.apiCode || (statusCode === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR"),
    });
  });

  // -------------------------------------------------------
  // GET /domains — list managed domains
  // -------------------------------------------------------
  fastify.get("/domains", async (request, reply) => {
    const managedDomains = await getManagedDomains(fastify);
    return ok({ domains: managedDomains.map((d) => d.domain) });
  });

  // -------------------------------------------------------
  // GET /check/:subdomain/:domain — check availability
  // -------------------------------------------------------
  fastify.get("/check/:subdomain/:domain", async (request, reply) => {
    const subdomain = (request.params.subdomain || "").trim().toLowerCase();
    const domainEntry = await resolveDomain(fastify, request.params.domain);

    if (!subdomain || !isValidSubdomain(subdomain)) {
      apiError(400, "Invalid subdomain format.", "INVALID_SUBDOMAIN");
    }

    const isTakenInBind = await bindService.findDnsRecord(subdomain, domainEntry.domain);
    const [rows] = await fastify.mysql.execute(
      "SELECT 1 FROM subdomains WHERE subdomain = ? AND domain_id = ? LIMIT 1",
      [subdomain, domainEntry.id]
    );
    const available = !isTakenInBind && rows.length === 0;

    return ok({
      available,
      subdomain,
      domain: domainEntry.domain,
      fqdn: `${subdomain}.${domainEntry.domain}`,
    });
  });

  // -------------------------------------------------------
  // POST /subdomains — create subdomain
  // -------------------------------------------------------
  fastify.post("/subdomains", async (request, reply) => {
    const auth = request.apiAuth;
    const { subdomain: rawSubdomain, domain: rawDomain, type: rawType = "A", value: rawValue } = request.body || {};
    const subdomain = (rawSubdomain || "").trim().toLowerCase();
    const recordType = bindService.normalizeRecordType(rawType);

    if (!subdomain || !isValidSubdomain(subdomain)) {
      apiError(400, "Invalid subdomain format.", "INVALID_SUBDOMAIN");
    }

    if (!rawValue) {
      apiError(400, "Record value is required.", "INVALID_INPUT");
    }

    const blacklistCheck = isBlacklisted(subdomain);
    if (blacklistCheck.blocked) {
      apiError(400, blacklistCheck.reason, "BLACKLISTED");
    }

    const domainEntry = await resolveDomain(fastify, rawDomain);

    const validation = validateRecordValue(recordType, rawValue, {
      subdomain,
      domain: domainEntry.domain,
    });
    if (!validation.valid) {
      apiError(400, validation.message, "INVALID_INPUT");
    }
    const recordValue = validation.value;

    // IP limit for anonymous mode
    if (auth.mode === "ip") {
      const [countRows] = await fastify.mysql.execute(
        "SELECT COUNT(*) AS cnt FROM subdomains WHERE owner_ip = ? AND owner_type = 'agent'",
        [auth.ip]
      );
      if (countRows[0].cnt >= IP_SUBDOMAIN_LIMIT) {
        apiError(403, `Anonymous limit reached (${IP_SUBDOMAIN_LIMIT} subdomains per IP). Get an API key at sitey.one for unlimited access.`, "LIMIT_REACHED");
      }
    }

    // Reachability validation
    const isReachable = await validateRecord(recordType, recordValue);
    if (!isReachable) {
      const msg = recordType === "A"
        ? `Target IP ${recordValue} is not reachable on port 80 or 443.`
        : `Target domain ${recordValue} does not resolve to any address.`;
      apiError(400, msg, "VALIDATION_UNREACHABLE");
    }

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

      reply.code(201);
      return ok({
        fqdn: newRecord.name,
        type: recordType,
        value: recordValue,
      });
    } catch (error) {
      if (error.statusCode === 409) {
        apiError(409, "This subdomain is already in use.", "SUBDOMAIN_TAKEN");
      }
      throw error;
    }
  });

  // -------------------------------------------------------
  // GET /subdomains — list user's subdomains
  // -------------------------------------------------------
  fastify.get("/subdomains", async (request, reply) => {
    const auth = request.apiAuth;

    let rows;
    if (auth.mode === "apikey") {
      [rows] = await fastify.mysql.execute(
        "SELECT s.subdomain, m.domain_name AS domain, s.record_type AS type, s.record_value AS value, s.created_at " +
        "FROM subdomains s JOIN managed_domains m ON s.domain_id = m.id " +
        "WHERE s.user_id = ? ORDER BY s.created_at DESC",
        [auth.userId]
      );
    } else {
      [rows] = await fastify.mysql.execute(
        "SELECT s.subdomain, m.domain_name AS domain, s.record_type AS type, s.record_value AS value, s.created_at " +
        "FROM subdomains s JOIN managed_domains m ON s.domain_id = m.id " +
        "WHERE s.owner_ip = ? AND s.owner_type = 'agent' ORDER BY s.created_at DESC",
        [auth.ip]
      );
    }

    return ok({ subdomains: rows });
  });

  // -------------------------------------------------------
  // PATCH /subdomains/:subdomain/:domain — update
  // -------------------------------------------------------
  fastify.patch("/subdomains/:subdomain/:domain", async (request, reply) => {
    const auth = request.apiAuth;
    const subdomain = (request.params.subdomain || "").trim().toLowerCase();
    const domainEntry = await resolveDomain(fastify, request.params.domain);
    const { value: rawValue } = request.body || {};

    if (!rawValue) {
      apiError(400, "Record value is required.", "INVALID_INPUT");
    }

    // Ownership check
    const record = await findOwnedRecord(fastify, auth, subdomain, domainEntry);

    const recordType = bindService.normalizeRecordType(record.record_type);
    const validation = validateRecordValue(recordType, rawValue, {
      subdomain,
      domain: domainEntry.domain,
    });
    if (!validation.valid) {
      apiError(400, validation.message, "INVALID_INPUT");
    }
    const recordValue = validation.value;

    // Reachability
    const isReachable = await validateRecord(recordType, recordValue);
    if (!isReachable) {
      const msg = recordType === "A"
        ? `Target IP ${recordValue} is not reachable on port 80 or 443.`
        : `Target domain ${recordValue} does not resolve to any address.`;
      apiError(400, msg, "VALIDATION_UNREACHABLE");
    }

    await updateSubdomain(fastify, {
      recordId: record.id,
      subdomain,
      domain: domainEntry.domain,
      recordValue,
      recordType,
    });

    return ok({
      fqdn: `${subdomain}.${domainEntry.domain}`,
      type: recordType,
      value: recordValue,
    });
  });

  // -------------------------------------------------------
  // DELETE /subdomains/:subdomain/:domain — delete
  // -------------------------------------------------------
  fastify.delete("/subdomains/:subdomain/:domain", async (request, reply) => {
    const auth = request.apiAuth;
    const subdomain = (request.params.subdomain || "").trim().toLowerCase();
    const domainEntry = await resolveDomain(fastify, request.params.domain);

    const record = await findOwnedRecord(fastify, auth, subdomain, domainEntry);
    const recordType = bindService.normalizeRecordType(record.record_type);

    await deleteSubdomain(fastify, {
      recordId: record.id,
      subdomain,
      domain: domainEntry.domain,
      recordType,
    });

    return ok({ fqdn: `${subdomain}.${domainEntry.domain}`, deleted: true });
  });

  // -------------------------------------------------------
  // POST /subdomains/:subdomain/:domain/txt — create/update TXT
  // -------------------------------------------------------
  fastify.post("/subdomains/:subdomain/:domain/txt", async (request, reply) => {
    const auth = request.apiAuth;
    const subdomain = (request.params.subdomain || "").trim().toLowerCase();
    const domainEntry = await resolveDomain(fastify, request.params.domain);
    const { host_prefix: rawHostPrefix, value: rawTxtValue, root_level: rootLevel } = request.body || {};

    if (!rawHostPrefix || !rawTxtValue) {
      apiError(400, "host_prefix and value are required.", "INVALID_INPUT");
    }

    // root_level used to pick between the zone apex and <prefix>.<subdomain>.
    // Every TXT record now goes to the root domain (that is the only name
    // Vercel reads for a subdomain of sitey.my), so the flag selects nothing.
    // Say so instead of accepting a flag whose meaning has changed underneath
    // the caller.
    if (rootLevel) {
      apiError(
        400,
        "root_level is no longer supported: TXT records are always written at the root domain " +
          "under host_prefix, which is where verification services look. Omit the flag.",
        "ROOT_LEVEL_FORBIDDEN"
      );
    }

    const prefixValidation = validateHostPrefix(rawHostPrefix, {
      allowed: config.txt.apexPrefixes,
    });
    if (!prefixValidation.valid) {
      apiError(400, prefixValidation.message, "INVALID_HOST_PREFIX");
    }
    const hostPrefix = prefixValidation.value;

    const txtValidation = validateTxtValue(rawTxtValue);
    if (!txtValidation.valid) {
      apiError(400, txtValidation.message, "INVALID_INPUT");
    }
    const sanitizedTxtValue = txtValidation.value;

    // Ownership of parent subdomain
    const record = await findOwnedRecord(fastify, auth, subdomain, domainEntry);

    // The caller's own previous value, so the zone write can drop it: every
    // subdomain's token lives under the same name, and the value is the only
    // thing that identifies a line.
    const [prevRows] = await fastify.mysql.execute(
      "SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
      [record.id, hostPrefix]
    );

    // DB + BIND
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

    fastify.log.info(`TXT record created/updated via API: ${txtRecord.name}`);
    return ok({
      fqdn: txtRecord.name,
      type: "TXT",
      value: sanitizedTxtValue,
    });
  });

  // -------------------------------------------------------
  // DELETE /subdomains/:subdomain/:domain/txt/:hostPrefix — delete TXT
  // -------------------------------------------------------
  fastify.delete("/subdomains/:subdomain/:domain/txt/:hostPrefix", async (request, reply) => {
    const auth = request.apiAuth;
    const subdomain = (request.params.subdomain || "").trim().toLowerCase();
    const domainEntry = await resolveDomain(fastify, request.params.domain);
    const prefixValidation = validateHostPrefix(request.params.hostPrefix);
    if (!prefixValidation.valid) {
      apiError(400, prefixValidation.message, "INVALID_HOST_PREFIX");
    }
    const hostPrefix = prefixValidation.value;

    // Ownership of parent subdomain
    const record = await findOwnedRecord(fastify, auth, subdomain, domainEntry);

    // The stored value is what identifies this caller's line in the zone —
    // the TXT name itself belongs to every subdomain of the domain.
    const [txtRows] = await fastify.mysql.execute(
      "SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
      [record.id, hostPrefix]
    );
    if (!txtRows.length) {
      apiError(404, "No TXT record with that host_prefix on this subdomain.", "TXT_NOT_FOUND");
    }

    // DB + BIND
    const removed = await bindService.deleteTxtRecord(
      subdomain,
      domainEntry.domain,
      hostPrefix,
      txtRows[0].txt_value
    );
    await fastify.mysql.execute(
      "DELETE FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
      [record.id, hostPrefix]
    );

    if (!removed.deleted) {
      // The row is gone either way, but say so rather than claim a zone change
      // that never happened.
      fastify.log.warn(
        `TXT record row deleted but no matching zone line: ${removed.name}`
      );
    }
    fastify.log.info(`TXT record deleted via API: ${removed.name}`);
    return ok({
      fqdn: removed.name,
      type: "TXT",
      deleted: true,
      zone_record_removed: removed.deleted === true,
    });
  });
}

/**
 * Find a subdomain record owned by the current auth context.
 * Throws 403 FORBIDDEN if not found.
 */
async function findOwnedRecord(fastify, auth, subdomain, domainEntry) {
  let rows;
  if (auth.mode === "apikey") {
    [rows] = await fastify.mysql.execute(
      "SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND user_id = ?",
      [subdomain, domainEntry.id, auth.userId]
    );
  } else {
    [rows] = await fastify.mysql.execute(
      "SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND owner_ip = ? AND owner_type = 'agent'",
      [subdomain, domainEntry.id, auth.ip]
    );
  }

  if (!rows[0]) {
    apiError(403, "Subdomain not found or you do not have permission.", "FORBIDDEN");
  }
  return rows[0];
}

module.exports = apiV1Routes;
