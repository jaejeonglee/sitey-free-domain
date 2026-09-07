const fp = require("fastify-plugin");
const crypto = require("crypto");
const bindService = require("../services/bind");
const alertService = require("../services/alert");
const { getManagedDomains } = require("../services/managedDomain");
const { liveTxtRows } = require("../services/txt-records");
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

/**
 * Compare one domain's zone file with the database.
 *
 * Pure on purpose — the comparison can be checked against fixtures with no
 * zone file and no database anywhere near it (same reasoning as buildPlan in
 * deploy/migrate-vercel-txt.js).
 *
 * @param {object[]} zoneRecords  - A/CNAME lines, from bind.listDnsRecords
 * @param {object[]} zoneTxtLines - TXT lines, from bind.listTxtRecords
 * @param {object[]} dbRows       - subdomains rows for this domain
 * @param {object[]} dbTxtRows    - subdomain_txt_records rows for this domain
 */
function diffRecords({ zoneRecords, zoneTxtLines, dbRows, dbTxtRows }) {
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

  issues.push(...diffTxt(zoneTxtLines, dbTxtRows));

  return issues;
}

/**
 * The TXT half, kept apart because TXT does not fit the maps above.
 *
 * Every subdomain's Vercel token lives under the one name `_vercel`, so a name
 * does not identify a record — a *value* does. Keying TXT by name would have
 * kept one line out of 28 and called the rest consistent, which is close to
 * what actually happened: creation used to overwrite by name, 25 owners wiped
 * each other out, and this reconciler said nothing for months because
 * listDnsRecords only ever read A and CNAME.
 *
 * Only live rows are expected to be in the zone. A retry left a second row
 * behind and the token its owner uses is the newest of them, so the earlier
 * one is history, not a missing record — see services/txt-records.js. The
 * first run of this reconciler warned about two of those, which is how the
 * rule got here.
 */
function diffTxt(zoneTxtLines, dbTxtRows) {
  // Only the names this app writes are ours to judge. A zone also carries TXT
  // the operator put there by hand (SPF, site verification), and reporting
  // those as orphans every night would bury the ones that matter.
  //
  // Which names are ours is decided by *every* row, superseded or not: a name
  // this app once wrote stays ours, and that is what keeps the fossil
  // `_vercel.stock` on the list instead of reading it as somebody's SPF.
  const prefixes = [
    ...new Set([
      ...(config.txt.apexPrefixes || []),
      ...dbTxtRows.map((row) => String(row.host_prefix).toLowerCase()),
    ]),
  ];
  // `_vercel` is ours, and so is `_vercel.stock` — the fossil name the old code
  // wrote before it moved to the apex.
  const isOurs = (name) => {
    const lower = name.toLowerCase();
    return prefixes.some((p) => lower === p || lower.startsWith(`${p}.`));
  };

  const zoneByName = new Map();
  for (const line of zoneTxtLines) {
    if (!isOurs(line.name)) continue;
    const name = line.name.toLowerCase();
    if (!zoneByName.has(name)) zoneByName.set(name, []);
    zoneByName.get(name).push(line.value);
  }

  // ...but only live rows decide *what should be there*.
  const wanted = liveTxtRows(dbTxtRows).map((row) => ({
    subdomain: row.subdomain,
    value: row.txt_value,
    name: bindService
      .txtRecordName(row.subdomain, row.host_prefix)
      .toLowerCase(),
  }));

  const rowsAtName = new Map();
  for (const row of wanted) {
    rowsAtName.set(row.name, (rowsAtName.get(row.name) || 0) + 1);
  }

  const issues = [];
  const explained = new Set(); // "name|value" of zone lines a row accounts for
  const missing = [];

  for (const row of wanted) {
    if ((zoneByName.get(row.name) || []).includes(row.value)) {
      explained.add(`${row.name}|${row.value}`);
    } else {
      missing.push(row);
    }
  }

  // A value the database holds, sitting in the zone under a different one of
  // our names, is one record at the wrong name — not a missing record plus a
  // stray line. The old code wrote `_vercel.<subdomain>` and Vercel only ever
  // reads the apex, so the token is present and unreadable, and moving it
  // clears both halves at once. Two lines in an alert for one fact reads as
  // two problems, and the fix for the first one looks like it caused the
  // second.
  const stillMissing = [];
  for (const row of missing) {
    const found = [...zoneByName].find(
      ([name, values]) =>
        name !== row.name &&
        values.includes(row.value) &&
        !explained.has(`${name}|${row.value}`)
    );
    if (!found) {
      stillMissing.push(row);
      continue;
    }
    explained.add(`${found[0]}|${row.value}`);
    issues.push({
      type: "txt-name-mismatch",
      name: row.name,
      foundAt: found[0],
      recordType: "TXT",
      subdomain: row.subdomain,
      dbValue: row.value,
    });
  }

  for (const row of stillMissing) {
    const spare = (zoneByName.get(row.name) || []).filter(
      (value) => !explained.has(`${row.name}|${value}`)
    );
    // A changed value only reads as drift when the name belongs to one row and
    // one unclaimed line — otherwise there is no telling whose line it is.
    // While every subdomain shares `_vercel` that never holds, so a value that
    // is not in the zone is reported as missing, which is what it is.
    if (rowsAtName.get(row.name) === 1 && spare.length === 1) {
      explained.add(`${row.name}|${spare[0]}`);
      issues.push({
        type: "txt-value-drift",
        name: row.name,
        recordType: "TXT",
        subdomain: row.subdomain,
        zoneValue: spare[0],
        dbValue: row.value,
      });
    } else {
      issues.push({
        type: "txt-db-only",
        name: row.name,
        recordType: "TXT",
        subdomain: row.subdomain,
        dbValue: row.value,
      });
    }
  }

  for (const [name, values] of zoneByName) {
    for (const value of values) {
      if (explained.has(`${name}|${value}`)) continue;
      issues.push({ type: "txt-zone-only", name, recordType: "TXT", zoneValue: value });
    }
  }

  return issues;
}

async function computeDiff(fastify, domain, domainId) {
  const [zoneRecords, zoneTxtLines, [dbRows], [dbTxtRows]] = await Promise.all([
    bindService.listDnsRecords(domain),
    bindService.listTxtRecords(domain),
    fastify.mysql.execute(
      "SELECT subdomain, record_value, record_type FROM subdomains WHERE domain_id = ?",
      [domainId]
    ),
    fastify.mysql.execute(
      // t.id and t.subdomain_id are what liveTxtRows() sorts retries by;
      // without them every row of a subdomain reads as a separate record.
      "SELECT t.id, t.subdomain_id, s.subdomain, t.host_prefix, t.txt_value " +
        "FROM subdomain_txt_records t JOIN subdomains s ON t.subdomain_id = s.id " +
        "WHERE s.domain_id = ?",
      [domainId]
    ),
  ]);

  return diffRecords({ zoneRecords, zoneTxtLines, dbRows, dbTxtRows });
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
      fastify.log.info({ evt: "reconcile", result: "clean" }, "Reconciler: no inconsistencies found");
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
      fastify.log.info(
        { evt: "reconcile", result: "resolved" },
        "Reconciler: inconsistencies resolved after debounce"
      );
      return;
    }

    // One line per finding, in the same shape as the access log
    // (services/access-log.js): one JSON object per line under journald, `evt`
    // saying what kind of line it is.
    //
    // Logged *before* the alert dedup below on purpose. The Telegram alert is
    // snoozed while the diff stays identical, but a disagreement that lasts a
    // week is worse than a new one, not quieter — so every run leaves the
    // whole diff in the log even when no message goes out.
    for (const issue of reconfirmed) {
      const line = {
        evt: "reconcile",
        issue: issue.type,
        domain: issue.domain,
        name: issue.name,
        type: issue.recordType,
        subdomain: issue.subdomain || null,
        // only txt-name-mismatch sets this: the name the value is actually under
        foundAt: issue.foundAt ?? null,
        zoneValue: issue.zoneValue ?? null,
        dbValue: issue.dbValue ?? null,
      };
      if (
        issue.type === "db-only" ||
        issue.type === "txt-db-only" ||
        issue.type === "txt-name-mismatch"
      ) {
        // The database says this record exists and DNS is not answering with
        // it: somebody's site or domain verification is down right now. This
        // is the case that went unseen for months — TXT was never compared.
        // A record at the wrong name belongs here too: nothing reads that
        // name, so for its owner it is simply absent.
        fastify.log.error(line, "Reconciler: in the database, missing from the zone");
      } else {
        fastify.log.warn(line, "Reconciler: zone and database disagree");
      }
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
        if (i.type === "txt-db-only") return `[TXT-DB-ONLY] ${i.name}.${i.domain} <- ${i.subdomain} = ${i.dbValue}`;
        if (i.type === "txt-zone-only") return `[TXT-ZONE-ONLY] ${i.name}.${i.domain} = ${i.zoneValue}`;
        if (i.type === "txt-name-mismatch") return `[TXT-WRONG-NAME] ${i.subdomain}: at ${i.foundAt}.${i.domain}, should be ${i.name}.${i.domain} = ${i.dbValue}`;
        if (i.type === "txt-value-drift") return `[TXT-DRIFT] ${i.name}.${i.domain} <- ${i.subdomain} zone=${i.zoneValue} db=${i.dbValue}`;
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
// Exported for tests/reconciler.test.js. The scheduling wrapper is a timer;
// the part worth testing is the comparison and the query behind it.
module.exports.diffRecords = diffRecords;
module.exports.computeDiff = computeDiff;
