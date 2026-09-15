// routes/api-v1.js — REST API /api/v1/ (external; API key, anonymous owner
// token, or neither)
const config = require("../configs/index");
const accessLog = require("../services/access-log");
const bindService = require("../services/bind");
const { noteReachability } = require("../services/validation");
const { createSubdomain, updateSubdomain, deleteSubdomain } = require("../services/subdomain");
const { renewSubdomain, renewalNotDueMessage } = require("../services/expiry");
const { getManagedDomains } = require("../services/managedDomain");
const { isBlacklisted } = require("../services/blacklist");
const { hashKey, validateKey } = require("../services/api-key");
const anonToken = require("../services/anon-token");
const { checkSubdomainQuota } = require("../services/quota");
const credits = require("../services/credits");
const x402 = require("../services/x402");
const alertService = require("../services/alert");
const {
  isValidSubdomain,
  validateHostPrefix,
  validateRecordValue,
  validateTxtValue,
} = require("../utils/validators");

/**
 * Client IP: what an anonymous caller was before tokens, and still the fallback
 * for the records made back then.
 *
 * `request.ip` is derived by Fastify from the configured trusted proxy list
 * (see configs/index.js). Reading cf-connecting-ip / x-forwarded-for directly
 * meant any caller could pick their own identity with one header and read,
 * change or delete another anonymous user's subdomains. An address is a weak
 * identity even when it is honest — see services/anon-token.js for the NAT
 * case, which is what tokens are for.
 */
function getClientIp(request) {
  return request.ip;
}

/**
 * Resolve auth context from Authorization header
 * Returns: { mode: "apikey", userId, email, name }
 *        | { mode: "token", tokenHash, ip }
 *        | { mode: "ip", ip }
 *        | { mode: "invalid_key" }
 *
 * The two kinds of Bearer are told apart by prefix and nothing else, which is
 * why `anon_` was chosen to look nothing like `styo_`. Order matters: the
 * API key is matched first and the catch-all refusal stays last, so adding a
 * second kind cannot turn a mistyped key into an anonymous caller.
 *
 * The address is kept on the token branch as well. It is not what proves
 * ownership there — services/anon-token.js sees to that — but the quota counts
 * a token nobody has used yet against the address it came from, and a new
 * record writes the address down either way.
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
  if (authHeader && authHeader.startsWith(`Bearer ${anonToken.TOKEN_PREFIX}`)) {
    const rawToken = authHeader.slice(7);
    // A truncated or mistyped token is refused rather than read as anonymous.
    // Quietly demoting it would hand the caller a different identity under the
    // same request, and the first it would hear of that is its own records
    // having vanished.
    if (!anonToken.isWellFormed(rawToken)) {
      return { mode: "invalid_key" };
    }
    return {
      mode: "token",
      tokenHash: anonToken.hashToken(rawToken),
      ip: getClientIp(request),
    };
  }
  if (authHeader && authHeader.startsWith("Bearer ")) {
    // Has a Bearer token but neither prefix — invalid
    return { mode: "invalid_key" };
  }
  return { mode: "ip", ip: getClientIp(request) };
}

/**
 * What to say to a caller who is at their limit.
 *
 * It states both numbers, because an agent deciding whether to retry needs to
 * know whether one deletion would be enough. It no longer offers an API key as
 * the way round: a key is an account and an account has the same limit, which
 * is the whole point of counting by how many rather than by who.
 */
function limitMessage(quota) {
  if (quota.scope === "account") {
    return `You are holding ${quota.held} subdomains and the limit for this account is ${quota.limit}. Remove one before creating another.`;
  }
  if (quota.scope === "token") {
    return `This owner token is holding ${quota.held} subdomains and may hold ${quota.limit}. Remove one before creating another.`;
  }
  return `Anonymous callers may hold ${quota.limit} subdomains per address and you are holding ${quota.held}. Sign in at sitey.my to hold them under an account.`;
}

/**
 * What to answer a caller who is at their limit.
 *
 * The two switches are read separately and both have to be on. Observing
 * cannot ask for money — there is nothing to ask for while nobody is being
 * refused — so SUBDOMAIN_LIMIT_ENFORCED decides whether anyone is stopped at
 * all, and X402_ENABLED decides what they are told when they are. With the
 * payment route off, or on but unable to work, this is the plain refusal the
 * endpoint has always given: never the subdomain.
 *
 * @returns {boolean} true to carry on with the request. False means an answer
 *   has already been sent and the handler must stop.
 */
async function takePayment(fastify, request, reply, quota) {
  const state = x402.status();
  if (!state.enabled) {
    // Not silent: if the route was meant to be on, services/x402.js has
    // already said in the log which setting is missing.
    apiError(403, limitMessage(quota), "LIMIT_REACHED");
  }

  const resource = `${config.server.publicOrigin}${request.raw.url}`;
  const { size, days } = config.quota.bundle;
  const description =
    `${size} more subdomains for ${days} days, on top of the ${quota.limit} this caller may hold.`;
  const proof = request.headers["x-payment"];

  if (!proof) {
    request.outcome = "PAYMENT_REQUIRED";
    reply.code(402).send(
      x402.paymentRequiredBody({ resource, description, error: limitMessage(quota) })
    );
    return false;
  }

  const settlement = await x402.settle(proof, { resource, description });
  if (!settlement.ok) {
    // Answered 402 again rather than 403: the caller may pay properly and
    // repeat, and the body says both what was wrong and what is being asked
    // for. A 403 would read as "and do not come back".
    request.outcome = "PAYMENT_INVALID";
    reply.code(402).send(
      x402.paymentRequiredBody({ resource, description, error: settlement.reason })
    );
    return false;
  }

  const recorded = await credits.record(fastify, {
    userId: request.apiAuth.mode === "apikey" ? request.apiAuth.userId : null,
    payer: settlement.payer,
    amountMicros: settlement.amountMicros,
    channel: "x402",
    reference: settlement.reference,
  });

  if (!recorded.recorded) {
    if (recorded.code === "duplicate") {
      // The same settlement presented twice. Refusing costs the caller
      // nothing — they were not charged again — and it is the only thing
      // standing between one payment and any number of subdomains.
      request.outcome = "PAYMENT_REPLAYED";
      reply.code(402).send(
        x402.paymentRequiredBody({ resource, description, error: recorded.reason })
      );
      return false;
    }
    // The money has already moved. Refusing now would take payment and give
    // nothing, which is the worse of the two failures, so the request goes
    // through and a person is told that a payment landed with nowhere to be
    // written down.
    await alertService.critical("PAYMENT_UNRECORDED", {
      channel: "x402",
      reference: settlement.reference,
      amount_micros: settlement.amountMicros,
      reason: recorded.reason,
    });
  }

  reply.header("x-payment-response", settlement.responseHeader);
  return true;
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
        // Names both, because the header now carries either: an API key
        // (`styo_...`) or an anonymous owner token (`anon_...`). A caller
        // told only "invalid API key" while holding a token looks in the wrong
        // place.
        message: "Invalid API key or owner token.",
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
    // Every v1 failure already names itself; the access log wants the same name.
    request.outcome =
      error.apiCode || (statusCode === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR");
    return reply.code(statusCode).send({
      error: true,
      message: error.message || "Internal server error",
      code: request.outcome,
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

    // How many this caller already holds. An account is refused only once
    // SUBDOMAIN_LIMIT_ENFORCED is switched on; the anonymous ceiling is an
    // abuse guard and has always been enforced. services/quota.js.
    const quota = await checkSubdomainQuota(fastify, {
      userId: auth.mode === "apikey" ? auth.userId : null,
      tokenHash: auth.mode === "token" ? auth.tokenHash : null,
      ip: auth.mode === "apikey" ? null : auth.ip,
      subject: accessLog.subjectOf(request),
    });
    if (quota.blocked && !(await takePayment(fastify, request, reply, quota))) {
      return reply;
    }

    // Reachability, recorded rather than enforced. An agent asks for the name
    // first and deploys to it second; refusing here made that order impossible
    // and is the one thing standing in front of the API we are about to list.
    // services/validation.js carries the reasoning.
    const reach = await noteReachability(request.log, {
      recordType,
      recordValue,
      subdomain,
      domain: domainEntry.domain,
      phase: "create",
    });

    // 🔴 The one thing this endpoint must never start needing. A create with
    // no Authorization header at all still succeeds — it is minted a token
    // here and handed it back below — because "an agent can do this on its own,
    // with no signup and no key" is the entire reason anybody chooses this
    // service over the ones in the registry that ask for an API key first.
    // A token is what you are *given*, never what you must go and get.
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
        // Still written for a token owner: it is not what proves the record,
        // but it is what the quota counts births against (services/quota.js).
        ownerIp: auth.mode === "apikey" ? null : auth.ip,
        ownerTokenHash: issued ? issued.hash : (auth.mode === "token" ? auth.tokenHash : null),
      });

      reply.code(201);
      return ok({
        fqdn: newRecord.name,
        type: recordType,
        value: recordValue,
        // An agent has no mailbox to be reminded at, so the date it has to act
        // on travels in every response it reads.
        expires_at: newRecord.expiresAt,
        // Added, never substituted: a client reading fqdn/type/value/expires_at
        // sees exactly what it saw before.
        reachable: reach.ok,
        ...(reach.note ? { note: reach.note } : {}),
        // Once, and only on the create that minted it. There is nowhere to
        // look it up afterwards — only its hash is stored — so the note says
        // so rather than leaving a caller to find out.
        ...(issued
          ? { owner_token: issued.token, owner_token_note: anonToken.TOKEN_NOTE }
          : {}),
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

    // One predicate for all three kinds of caller, and the same one the
    // ownership checks use — a listing that showed a row the caller cannot
    // then touch, or hid one it can, would be its own bug.
    const owner = anonToken.ownerPredicate(auth, "s.");
    const [rows] = await fastify.mysql.execute(
      "SELECT s.subdomain, m.domain_name AS domain, s.record_type AS type, s.record_value AS value, " +
      "s.created_at, s.expires_at " +
      "FROM subdomains s JOIN managed_domains m ON s.domain_id = m.id " +
      `WHERE ${owner.sql} ORDER BY s.created_at DESC`,
      owner.params
    );

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

    // Reachability, recorded rather than enforced — as on create.
    const reach = await noteReachability(request.log, {
      recordType,
      recordValue,
      subdomain,
      domain: domainEntry.domain,
      phase: "update",
    });

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
      reachable: reach.ok,
      ...(reach.note ? { note: reach.note } : {}),
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
  // POST /subdomains/:subdomain/:domain/renew — extend the lease
  // -------------------------------------------------------
  // The agent's equivalent of the button in the renewal mail. No mailbox is
  // attached to an agent-created record, so nothing reminds it — the date
  // comes back from every read, and one call resets the clock.
  fastify.post("/subdomains/:subdomain/:domain/renew", async (request, reply) => {
    const auth = request.apiAuth;
    const subdomain = (request.params.subdomain || "").trim().toLowerCase();
    const domainEntry = await resolveDomain(fastify, request.params.domain);

    const record = await findOwnedRecord(fastify, auth, subdomain, domainEntry);
    const renewal = await renewSubdomain(fastify, record.id);
    if (!renewal.renewed) {
      if (renewal.reason === "not_found") {
        apiError(404, "Subdomain not found.", "SUBDOMAIN_NOT_FOUND");
      }
      // 409 rather than 400: the request is well formed and will work later.
      // The message names the date, because a caller told only "too early"
      // can do nothing but retry blindly (services/expiry.js).
      apiError(409, renewalNotDueMessage(renewal), "RENEWAL_NOT_DUE");
    }

    return ok({
      fqdn: `${subdomain}.${domainEntry.domain}`,
      expires_at: renewal.expiresAt,
    });
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
  const owner = anonToken.ownerPredicate(auth);
  const [rows] = await fastify.mysql.execute(
    `SELECT id, record_type FROM subdomains WHERE subdomain = ? AND domain_id = ? AND ${owner.sql}`,
    [subdomain, domainEntry.id, ...owner.params]
  );

  if (!rows[0]) {
    apiError(403, "Subdomain not found or you do not have permission.", "FORBIDDEN");
  }
  return rows[0];
}

module.exports = apiV1Routes;
