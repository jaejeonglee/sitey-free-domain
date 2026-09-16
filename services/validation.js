const bindService = require("./bind");
const { probeHost, probeUrl } = require("./reachability");
const { sendUnreachableNoticeEmail } = require("./email");
const config = require("../configs/index");

/**
 * Run the reachability check and say what it did.
 *
 * Nobody is refused on the strength of this any more. Create and update hand
 * the verdict back to the caller (noteReachability, below); the nightly job
 * uses the detail to justify a notice to the owner, and removes nothing.
 *
 * Both record types are probed the same way now — an HTTP(S) request, because
 * "does this open" is the only question worth asking. See
 * services/reachability.js for why the old per-type checks answered a
 * different one.
 *
 * @param {string} recordType
 * @param {string} recordValue - what to dial: an IP for A, a hostname for CNAME
 * @param {object} [options]
 * @param {string} [options.fqdn] - the subdomain's own name, presented in Host
 *   and SNI. The nightly job knows it; create and update do not need to, since
 *   at that point nothing is attached to the name yet.
 * @returns {{ok: boolean, check: string, status: number|null, detail: string}}
 */
async function probeRecord(recordType, recordValue, options = {}) {
  if (recordType === "A" || recordType === "CNAME") {
    const probe = await probeHost({
      host: recordValue,
      hostname: options.fqdn || recordValue,
      timeoutMs: config.validation.httpTimeoutMs,
    });
    return {
      ok: probe.ok,
      check: probe.check,
      status: probe.status,
      detail: probe.detail,
    };
  }

  // A REDIRECT's zone value is this server, which always answers, so the only
  // question worth asking is whether the *destination* does. The URL itself is
  // requested, redirects not followed, 2xx/3xx alive (services/reachability.js).
  if (recordType === "REDIRECT") {
    return probeUrl({ url: recordValue, timeoutMs: config.validation.httpTimeoutMs });
  }

  return {
    ok: true,
    check: "none",
    status: null,
    detail: `no reachability check for ${recordType}`,
  };
}

/**
 * The check a write runs, whose verdict is written down rather than acted on.
 *
 * Create and update used to refuse a record whose target did not answer. That
 * made "claim the address, then deploy to it" impossible, and that is the
 * order both an agent and a person work in — a host generally wants the DNS
 * record in place before it will serve anything at the name. Between
 * 2026-09-07 and 2026-09-14 the funnel logged 65 name searches and 2 issue
 * attempts; the door, not the feature, is what is shut.
 *
 * So the probe still runs, exactly as before, and this returns what to tell
 * the caller. An abandoned name is already covered three times over: the
 * nightly check mails its owner (handleValidationResult, below — it deletes
 * nothing), the lease expires, and the limit counts what is held.
 *
 * `fqdn` is deliberately not passed on to probeRecord. The nightly job knows
 * the name and presents it in Host and SNI; here nothing is attached to it
 * yet, and dialling the target under a name it has never been configured for
 * would answer a different question than the one asked before. It is only used
 * on the log line.
 *
 * @param {{info: Function, warn: Function}} log - request.log or fastify.log
 * @param {object} params
 * @param {string} params.phase - "create" or "update", for the log line
 * @returns {{ok: boolean, check: string, status: number|null, detail: string,
 *            note: string|null}} `note` is the sentence for the caller, and is
 *   null when the target answered.
 */
async function noteReachability(log, { recordType, recordValue, subdomain, domain, phase }) {
  const probe = await probeRecord(recordType, recordValue);

  // Same shape as the nightly line handleValidationResult writes, so both ends
  // of a record's life read out of one query. `phase` is what tells them apart.
  log[probe.ok ? "info" : "warn"](
    {
      evt: "validate",
      phase,
      subdomain,
      domain,
      type: recordType,
      value: recordValue,
      check: probe.check,
      status: probe.status,
      detail: probe.detail,
      result: probe.ok ? "ok" : "unreachable",
    },
    probe.ok
      ? `Target answered on ${phase}: ${subdomain}.${domain} → ${recordValue}`
      : `Target did not answer on ${phase}, writing the record anyway: ${subdomain}.${domain} → ${recordValue}`
  );

  return { ...probe, note: probe.ok ? null : unreachableNote(recordType, recordValue) };
}

/** What a caller is told about a target that did not answer. */
function unreachableNote(recordType, recordValue) {
  const what =
    recordType === "A"
      ? `Nothing answered an HTTP request at ${recordValue} on port 80 or 443.`
      : recordType === "REDIRECT"
        ? `The redirect target ${recordValue} did not answer with a page (2xx or 3xx).`
        : `Nothing answered an HTTP request at ${recordValue}.`;
  return (
    `${what} The record was written anyway, so the name is yours and resolves now — ` +
    "point something at it and it will start working. Nothing is removed for being " +
    "unreachable; a record is only lost by not renewing it."
  );
}

/**
 * Run concurrency-limited async tasks
 */
async function processWithConcurrency(items, concurrency, fn) {
  const results = [];
  let failCount = 0;
  let index = 0;

  async function next() {
    const i = index++;
    if (i >= items.length) return;
    try {
      await fn(items[i]);
    } catch {
      failCount++;
    }
    await next();
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(next());
  }
  await Promise.all(workers);

  return { total: items.length, failCount };
}

/**
 * Tell the owner their address has been dark for a while.
 *
 * Nothing here removes anything. An anonymous record has no address to write
 * to, which is what `no_address` means; it simply keeps failing quietly until
 * its renewal comes due.
 *
 * @returns {string} what happened, for the log: sent | failed | no_address
 */
async function sendUnreachableNotice(fastify, record, failedDays) {
  if (!record.user_id) return "no_address";

  const [userRows] = await fastify.mysql.execute(
    "SELECT email FROM users WHERE id = ?",
    [record.user_id]
  );
  if (!userRows[0]) return "no_address";

  const result = await sendUnreachableNoticeEmail(userRows[0].email, {
    subdomain: record.subdomain,
    domain: record.domain_name,
    recordType: record.record_type,
    recordValue: record.record_value,
    days: failedDays,
  });
  return result.ok ? "sent" : "failed";
}

/**
 * Handle validation result for a single record
 *
 * Reachability does not delete. It used to: two consecutive failed checks, one
 * check a day, and the record was gone — so 48 hours of downtime cost somebody
 * their address, and three of the owner's own subdomains disappeared that way
 * on 2026-09-08. Deletion now has exactly one cause, a renewal that was not
 * done, because:
 *   1. one way to lose a record means an incident has one place to look
 *   2. renewal already sweeps up what nobody is using
 *   3. removing something that is alive costs far more than removing it late
 *
 * `warning_count` is the run of consecutive failed checks — one a day, so it
 * reads as days. `last_warning_at` is when that run started, i.e. dark since.
 * `unreachable_notified_at` is set once when the owner is told and cleared the
 * moment the site answers again, so nobody gets the same mail every night.
 *
 * @param {{ok: boolean, check: string, status: number|null, detail: string}} [probe]
 */
async function handleValidationResult(fastify, record, isValid, probe = null) {
  // One JSON object per line, same shape as the access log
  // (services/access-log.js): `evt` says what kind of line this is.
  const base = {
    evt: "validate",
    subdomain: record.subdomain,
    domain: record.domain_name,
    type: record.record_type,
    value: record.record_value,
    check: probe?.check ?? null,
    status: probe?.status ?? null,
    detail: probe?.detail ?? null,
  };

  if (isValid) {
    if (record.warning_count > 0 || record.unreachable_notified_at) {
      await fastify.mysql.execute(
        "UPDATE subdomains SET warning_count = 0, last_warning_at = NULL, " +
          "unreachable_notified_at = NULL, last_checked_at = NOW() WHERE id = ?",
        [record.id]
      );
      fastify.log.info(
        { ...base, result: "recovered" },
        `Validation recovered: ${record.subdomain}.${record.domain_name}`
      );
    } else {
      await fastify.mysql.execute(
        "UPDATE subdomains SET last_checked_at = NOW() WHERE id = ?",
        [record.id]
      );
    }
    return;
  }

  const failedDays = (record.warning_count || 0) + 1;
  // Only the first failure moves last_warning_at, so it keeps pointing at the
  // day the outage started rather than at today.
  await fastify.mysql.execute(
    failedDays === 1
      ? "UPDATE subdomains SET warning_count = ?, last_warning_at = NOW(), last_checked_at = NOW() WHERE id = ?"
      : "UPDATE subdomains SET warning_count = ?, last_checked_at = NOW() WHERE id = ?",
    [failedDays, record.id]
  );

  const threshold = config.validation.unreachableNoticeDays;
  // An agent-created record has nobody behind it to write to. Saying so once a
  // night for months is noise, so it stops here with the reason on the line;
  // its renewal is what eventually settles it.
  const nobodyToTell = !record.user_id;
  if (failedDays < threshold || record.unreachable_notified_at || nobodyToTell) {
    fastify.log.warn(
      {
        ...base,
        result: "fail",
        failure: failedDays,
        action: nobodyToTell && failedDays >= threshold ? "no_address" : "none",
      },
      `Validation failed (day ${failedDays}): ${record.subdomain}.${record.domain_name} → ${record.record_value}`
    );
    return;
  }

  if (!config.validation.unreachableNoticeEnabled) {
    // Off until a test message has been watched arriving — we have never had
    // any record of whether these mails are delivered. deploy/README.md, §4.
    fastify.log.warn(
      { ...base, result: "fail", failure: failedDays, action: "notice_withheld" },
      `Unreachable for ${failedDays} days, notice not sent (UNREACHABLE_NOTICE_ENABLED is off): ${record.subdomain}.${record.domain_name}`
    );
    return;
  }

  let email = "no_address";
  try {
    email = await sendUnreachableNotice(fastify, record, failedDays);
  } catch (emailErr) {
    email = "failed";
    fastify.log.error(
      emailErr,
      `Failed to send unreachable notice for ${record.subdomain}.${record.domain_name}`
    );
  }

  if (email === "sent") {
    await fastify.mysql.execute(
      "UPDATE subdomains SET unreachable_notified_at = NOW() WHERE id = ?",
      [record.id]
    );
  }

  fastify.log.warn(
    { ...base, result: "fail", failure: failedDays, action: "notice", email },
    `Unreachable for ${failedDays} days, owner notified (${email}): ${record.subdomain}.${record.domain_name}`
  );
}

/**
 * Main periodic validation job
 */
async function runPeriodicValidation(fastify) {
  if (config.bind.devMode) {
    fastify.log.info("Skipping periodic validation in dev mode");
    return;
  }

  const { batchSize, concurrency } = config.validation;
  let offset = 0;
  let totalChecked = 0;
  let totalFailed = 0;

  fastify.log.info("Starting periodic DNS validation...");

  while (true) {
    const [rows] = await fastify.mysql.query(
      `SELECT s.id, s.subdomain, s.record_value, s.record_type,
              s.warning_count, s.unreachable_notified_at, s.user_id, m.domain_name
       FROM subdomains s
       JOIN managed_domains m ON s.domain_id = m.id
       ORDER BY s.id
       LIMIT ${Number(batchSize)} OFFSET ${Number(offset)}`
    );

    if (rows.length === 0) break;

    let batchFailCount = 0;

    await processWithConcurrency(rows, concurrency, async (record) => {
      const probe = await probeRecord(
        bindService.normalizeRecordType(record.record_type),
        record.record_value,
        { fqdn: `${record.subdomain}.${record.domain_name}` }
      );
      const isValid = probe.ok;

      if (!isValid) batchFailCount++;

      try {
        await handleValidationResult(fastify, record, isValid, probe);
      } catch (err) {
        fastify.log.error(
          err,
          `Validation handling failed for ${record.subdomain}.${record.domain_name}`
        );
      }
    });

    totalChecked += rows.length;
    totalFailed += batchFailCount;

    // Circuit breaker: if >80% of batch failed, likely network issue
    const failRate = batchFailCount / rows.length;
    if (failRate > 0.8) {
      fastify.log.error(
        `Circuit breaker triggered: ${batchFailCount}/${rows.length} failed in batch. Stopping validation.`
      );
      break;
    }

    offset += batchSize;

    // Delay between batches to reduce load
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  fastify.log.info(
    `Periodic validation complete: ${totalChecked} checked, ${totalFailed} failed`
  );
}

module.exports = {
  probeRecord,
  noteReachability,
  handleValidationResult,
  runPeriodicValidation,
};
