const fp = require("fastify-plugin");
const crypto = require("crypto");
const bindService = require("../services/bind");
const alertService = require("../services/alert");
const { getManagedDomains } = require("../services/managedDomain");
const config = require("../configs/index");

const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEBOUNCE_MS = 10_000; // 10 seconds
const MAX_DETAILS_LEN = 3000;

let lastAlertFingerprint = null;

function msUntilMidnightKST() {
  const now = new Date();
  // KST = UTC+9
  const kstOffset = 9 * 60 * 60 * 1000;
  const nowKST = new Date(now.getTime() + kstOffset);

  const midnightKST = new Date(nowKST);
  midnightKST.setUTCHours(0, 0, 0, 0);
  midnightKST.setUTCDate(midnightKST.getUTCDate() + 1);

  // Convert back to local time
  const targetUTC = midnightKST.getTime() - kstOffset;
  return targetUTC - now.getTime();
}

async function computeDiff(fastify, domain, domainId) {
  const [zoneRecords, [dbRows]] = await Promise.all([
    bindService.listDnsRecords(domain),
    fastify.mysql.execute(
      "SELECT subdomain, record_value, record_type FROM subdomains WHERE domain_id = ?",
      [domainId]
    ),
  ]);

  // Build maps
  const zoneMap = new Map();
  for (const rec of zoneRecords) {
    const key = `${rec.name}|${rec.type}`;
    zoneMap.set(key, rec.value);
  }

  const dbMap = new Map();
  for (const row of dbRows) {
    const key = `${row.subdomain}|${row.record_type}`;
    dbMap.set(key, row.record_value);
  }

  const issues = [];

  // Zone-only: in BIND but not in DB (skip infrastructure records)
  const infraSet = new Set(config.infraRecords || []);
  for (const [key, value] of zoneMap) {
    if (!dbMap.has(key)) {
      const [name, type] = key.split("|");
      if (infraSet.has(name.toLowerCase())) continue;
      issues.push({ type: "zone-only", name, recordType: type, zoneValue: value });
    }
  }

  // DB-only: in DB but not in BIND
  for (const [key, value] of dbMap) {
    if (!zoneMap.has(key)) {
      const [name, type] = key.split("|");
      issues.push({ type: "db-only", name, recordType: type, dbValue: value });
    }
  }

  // Value drift: in both but values differ
  for (const [key, dbValue] of dbMap) {
    if (zoneMap.has(key)) {
      const zoneValue = zoneMap.get(key);
      // Normalize: CNAME zone values end with "."
      const [, type] = key.split("|");
      const normalizedDb = type === "CNAME" && !dbValue.endsWith(".")
        ? dbValue + "."
        : dbValue;
      if (zoneValue !== normalizedDb && zoneValue !== dbValue) {
        const [name] = key.split("|");
        issues.push({ type: "value-drift", name, recordType: type, zoneValue, dbValue });
      }
    }
  }

  return issues;
}

async function reconcile(fastify) {
  fastify.log.info("Reconciler: starting run");
  try {
    const domains = await getManagedDomains(fastify);
    const allIssues = [];

    for (const { id: domainId, domain } of domains) {
      try {
        const issues = await computeDiff(fastify, domain, domainId);
        for (const issue of issues) {
          issue.domain = domain;
        }
        allIssues.push(...issues);
      } catch (err) {
        fastify.log.error({ err, domain }, "Reconciler: failed to check domain");
      }
    }

    if (allIssues.length === 0) {
      fastify.log.info("Reconciler: no inconsistencies found");
      return;
    }

    fastify.log.warn({ count: allIssues.length }, "Reconciler: inconsistencies detected, debouncing...");

    // Debounce: wait 10s and re-check
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));

    const reconfirmed = [];
    for (const { id: domainId, domain } of domains) {
      try {
        const issues = await computeDiff(fastify, domain, domainId);
        for (const issue of issues) {
          issue.domain = domain;
        }
        reconfirmed.push(...issues);
      } catch (err) {
        fastify.log.error({ err, domain }, "Reconciler: re-check failed for domain");
      }
    }

    if (reconfirmed.length === 0) {
      fastify.log.info("Reconciler: inconsistencies resolved after debounce");
      return;
    }

    // Dedup: hash the diff and compare with last alert
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(reconfirmed))
      .digest("hex");

    if (fingerprint === lastAlertFingerprint) {
      fastify.log.info("Reconciler: same fingerprint as last alert, skipping (24h snooze)");
      return;
    }

    lastAlertFingerprint = fingerprint;

    // Build summary
    let details = reconfirmed
      .map((i) => {
        if (i.type === "zone-only") return `[ZONE-ONLY] ${i.name}.${i.domain} ${i.recordType} = ${i.zoneValue}`;
        if (i.type === "db-only") return `[DB-ONLY] ${i.name}.${i.domain} ${i.recordType} = ${i.dbValue}`;
        return `[DRIFT] ${i.name}.${i.domain} ${i.recordType} zone=${i.zoneValue} db=${i.dbValue}`;
      })
      .join("\n");

    if (details.length > MAX_DETAILS_LEN) {
      details = details.slice(0, MAX_DETAILS_LEN) + "\n... (truncated)";
    }

    fastify.log.warn({ count: reconfirmed.length }, "Reconciler: alerting on inconsistencies");
    await alertService.warn("RECONCILER_INCONSISTENCY", {
      count: reconfirmed.length,
      details,
    });
  } catch (err) {
    fastify.log.error({ err }, "Reconciler: unexpected error");
  }
}

async function reconcilerPlugin(fastify) {
  let intervalId = null;
  let initialTimeoutId = null;

  fastify.addHook("onReady", () => {
    const delayMs = msUntilMidnightKST();
    fastify.log.info({ delayMs, delayHours: (delayMs / 3600000).toFixed(1) },
      "Reconciler: scheduling first run at next midnight KST");

    initialTimeoutId = setTimeout(() => {
      reconcile(fastify);
      intervalId = setInterval(() => reconcile(fastify), RECONCILE_INTERVAL_MS);
    }, delayMs);
  });

  // Same shape as validation-scheduler: without this the timers keep the
  // process alive after fastify.close().
  fastify.addHook("onClose", async () => {
    if (initialTimeoutId) clearTimeout(initialTimeoutId);
    if (intervalId) clearInterval(intervalId);
  });
}

module.exports = fp(reconcilerPlugin, { name: "reconciler" });
