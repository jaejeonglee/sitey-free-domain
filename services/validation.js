const net = require("net");
const dns = require("dns/promises");
const bindService = require("./bind");
const { deleteSubdomain } = require("./subdomain");
const { sendValidationWarningEmail } = require("./email");
const config = require("../configs/index");

/**
 * TCP connect check for A record validation
 */
function checkTcpReachable(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, ip);
  });
}

/**
 * Run the reachability check and say what it did.
 *
 * The create and update paths only need yes/no, and validateRecord still
 * answers that. The nightly job needs more: on the second failure it deletes
 * the record, and the only trace it left was a sentence with no room for which
 * probe ran or what it saw. Three of the owner's own deployments were removed
 * this way and the log cannot say what the check found. The policy is
 * unchanged — this only writes down the reason.
 *
 * @returns {{ok: boolean, check: string, detail: string}}
 */
async function probeRecord(recordType, recordValue) {
  if (recordType === "A") {
    const timeout = config.validation.tcpTimeoutMs;
    if (await checkTcpReachable(recordValue, 80, timeout)) {
      return { ok: true, check: "tcp", detail: "connected on port 80" };
    }
    if (await checkTcpReachable(recordValue, 443, timeout)) {
      return { ok: true, check: "tcp", detail: "connected on port 443" };
    }
    return {
      ok: false,
      check: "tcp",
      detail: `no TCP connect on port 80 or 443 within ${timeout}ms`,
    };
  }

  if (recordType === "CNAME") {
    try {
      const addresses = await dns.resolve(recordValue);
      if (addresses.length > 0) {
        return { ok: true, check: "dns", detail: `resolved to ${addresses.length} address(es)` };
      }
      return { ok: false, check: "dns", detail: "resolved to no addresses" };
    } catch (err) {
      return { ok: false, check: "dns", detail: `resolve failed: ${err.code || err.message}` };
    }
  }

  return { ok: true, check: "none", detail: `no reachability check for ${recordType}` };
}

/**
 * Validate A record: TCP connect on port 80, fallback to 443
 */
async function validateARecord(ip) {
  return (await probeRecord("A", ip)).ok;
}

/**
 * Validate CNAME record: DNS resolve
 */
async function validateCnameRecord(hostname) {
  return (await probeRecord("CNAME", hostname)).ok;
}

/**
 * Validate a record based on its type
 */
async function validateRecord(recordType, recordValue) {
  return (await probeRecord(recordType, recordValue)).ok;
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
 * Handle validation result for a single record
 *
 * @param {{ok: boolean, check: string, detail: string}} [probe] - what the
 *   check saw, so the deletion decision below leaves its reason in the log
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
    detail: probe?.detail ?? null,
  };

  if (isValid) {
    // Reset warning if previously warned
    if (record.warning_count > 0) {
      await fastify.mysql.execute(
        "UPDATE subdomains SET warning_count = 0, last_checked_at = NOW() WHERE id = ?",
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

  // Validation failed
  if (record.warning_count === 0) {
    // First failure: set warning
    await fastify.mysql.execute(
      "UPDATE subdomains SET warning_count = 1, last_warning_at = NOW(), last_checked_at = NOW() WHERE id = ?",
      [record.id]
    );
    fastify.log.warn(
      { ...base, result: "fail", failure: 1, action: "warn" },
      `Validation warning (1st): ${record.subdomain}.${record.domain_name} → ${record.record_value}`
    );
  } else {
    // Second failure: send email + delete

    // Try to send warning email (failure doesn't block deletion)
    let email = "no_address";
    try {
      const [userRows] = await fastify.mysql.execute(
        "SELECT email FROM users WHERE id = ?",
        [record.user_id]
      );
      if (userRows[0]) {
        await sendValidationWarningEmail(userRows[0].email, {
          subdomain: record.subdomain,
          domain: record.domain_name,
          recordType: record.record_type,
          recordValue: record.record_value,
        });
        email = "sent";
      }
    } catch (emailErr) {
      email = "failed";
      fastify.log.error(
        emailErr,
        `Failed to send warning email for ${record.subdomain}.${record.domain_name}`
      );
    }

    // The whole decision on one line: which check failed, what it saw, that
    // this was the second strike, and whether the owner was told. Deletion is
    // what the policy has always done — anonymous records have no address to
    // write to, which is what `no_address` means.
    fastify.log.warn(
      { ...base, result: "fail", failure: 2, action: "delete", email },
      `Validation failed (2nd): deleting ${record.subdomain}.${record.domain_name}`
    );

    // Delete record regardless of email result
    await deleteSubdomain(fastify, {
      recordId: record.id,
      subdomain: record.subdomain,
      domain: record.domain_name,
      recordType: bindService.normalizeRecordType(record.record_type),
    });
    fastify.log.info(
      { ...base, result: "fail", failure: 2, action: "deleted", email },
      `Deleted invalid record: ${record.subdomain}.${record.domain_name}`
    );
  }
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
              s.warning_count, s.user_id, m.domain_name
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
        record.record_value
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
  validateARecord,
  validateCnameRecord,
  validateRecord,
  runPeriodicValidation,
};
