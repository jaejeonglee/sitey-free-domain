#!/usr/bin/env node
// Backfill the TXT values that overwriting destroyed.
//
//   node deploy/migrate-vercel-txt.js            # dry run, writes nothing
//   node deploy/migrate-vercel-txt.js --apply    # actually writes
//
// Background: TXT creation used to *replace* the line whose name matched, so
// every new token deleted the previous owner's. 2026-09-07 on the live server:
// 28 rows in `subdomain_txt_records`, 3 TXT lines left in the zone files.
//
// The database kept each owner's token, so it is the source of truth. Now that
// services/bind.js appends instead of replacing, those values can sit next to
// each other under the one name Vercel reads (`_vercel.<domain>`).
//
// This script only ever ADDS. It never deletes or rewrites an existing line, so
// the subdomain that currently verifies stays verified whatever happens. Worst
// case it changes nothing; best case 25 records come back.

const mysql = require("mysql2/promise");
const fs = require("fs").promises;
const config = require("../configs/index");
const bindService = require("../services/bind");

const APPLY = process.argv.includes("--apply");

bindService.setLogger({
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: () => {},
  fatal: (...args) => console.error(...args),
});

/**
 * Work out what to add, from database rows plus the current zone files.
 *
 * Pure on purpose: the plan can be checked against fixtures with no database
 * and no zone file anywhere near it.
 *
 * @param {object[]} rows - one per subdomain_txt_records row
 * @param {Map<string,string>} zones - zone file path -> contents
 */
function buildPlan(rows, zones) {
  // Retries left several rows for the same (subdomain, prefix). The newest id
  // is the value the user last asked for, and the only one worth restoring.
  const newest = new Map();
  for (const row of rows) {
    const key = `${row.subdomain_id} ${row.host_prefix}`;
    const previous = newest.get(key);
    if (!previous || row.id > previous.id) newest.set(key, row);
  }
  const duplicates = rows.length - newest.size;

  const items = [];
  for (const row of newest.values()) {
    const zonePath = config.bind.zoneFilePath(row.domain);
    const zone = zones.get(zonePath) || "";
    const recordName = bindService.txtRecordName(row.subdomain, row.host_prefix);
    items.push({
      ...row,
      zonePath,
      recordName,
      fqdn: `${recordName}.${row.domain}`,
      present: bindService.txtLineRegex(recordName, row.txt_value).test(zone),
    });
  }
  items.sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.subdomain.localeCompare(b.subdomain)
  );

  // Lines already in the zone under one of these prefixes that no row claims —
  // put there by hand, or fossils of the old `<prefix>.<subdomain>` naming.
  // Reported so a human can look at them; never touched.
  const prefixes = [...new Set(rows.map((r) => r.host_prefix))];
  const claimed = new Set(items.map((i) => `${i.zonePath} ${i.txt_value}`));
  const unclaimed = [];
  for (const [zonePath, zone] of zones) {
    for (const prefix of prefixes) {
      const scan = new RegExp(
        `^(${escapeRegex(prefix)}(?:\\.\\S+)?)[ \\t]+IN[ \\t]+TXT[ \\t]+"([^"]*)"`,
        "gim"
      );
      let match;
      while ((match = scan.exec(zone)) !== null) {
        if (!claimed.has(`${zonePath} ${match[2]}`)) {
          unclaimed.push({ zonePath, name: match[1], value: match[2] });
        }
      }
    }
  }

  return { items, duplicates, unclaimed };
}

function printPlan({ items, duplicates, unclaimed }, totalRows) {
  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} — ${totalRows} row(s) in subdomain_txt_records, ` +
      `${items.length} after keeping only the newest of each retry` +
      (duplicates ? ` (${duplicates} duplicate row(s) skipped)` : "")
  );
  console.log();

  let lastDomain = null;
  for (const item of items) {
    if (item.domain !== lastDomain) {
      console.log(`${item.domain}  (${item.zonePath})`);
      lastDomain = item.domain;
    }
    console.log(
      `  ${item.present ? "ok  " : "ADD "} ${item.fqdn.padEnd(22)} ` +
        `${item.subdomain.padEnd(20)} ${truncate(item.txt_value)}`
    );
  }

  const missing = items.filter((i) => !i.present);
  console.log();
  console.log(
    `${missing.length} value(s) to add, ${items.length - missing.length} already in place.`
  );

  if (unclaimed.length) {
    console.log();
    console.log("In the zone but claimed by no row (left untouched, decide by hand):");
    for (const line of unclaimed) {
      console.log(`  ${line.zonePath}: ${line.name}  IN  TXT  "${truncate(line.value)}"`);
    }
  }
  return missing;
}

async function main() {
  if (config.bind.devMode) {
    console.error("BIND_DEV_MODE is on — refusing to run, nothing would be written.");
    process.exitCode = 1;
    return;
  }

  const connection = await mysql.createConnection({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    const [rows] = await connection.execute(
      "SELECT t.id, t.subdomain_id, s.subdomain, m.domain_name AS domain, t.host_prefix, t.txt_value " +
        "FROM subdomain_txt_records t " +
        "JOIN subdomains s ON t.subdomain_id = s.id " +
        "JOIN managed_domains m ON s.domain_id = m.id " +
        "ORDER BY t.id"
    );

    const zones = new Map();
    for (const domain of new Set(rows.map((r) => r.domain))) {
      const zonePath = config.bind.zoneFilePath(domain);
      zones.set(zonePath, await fs.readFile(zonePath, "utf8"));
    }

    const plan = buildPlan(rows, zones);
    const missing = printPlan(plan, rows.length);

    if (!APPLY) {
      console.log();
      console.log("Nothing was written. Re-run with --apply to add the values above.");
      return;
    }

    // No previousValue is passed: this is a pure append, so no existing line
    // can be removed even if a value in the database looks stale.
    for (const item of missing) {
      await bindService.addTxtRecord(
        item.subdomain,
        item.domain,
        item.host_prefix,
        item.txt_value
      );
      console.log(`  added ${item.fqdn}  <- ${item.subdomain}`);
    }
    console.log();
    console.log(`Done — ${missing.length} value(s) added, nothing removed.`);
  } finally {
    await connection.end();
  }
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value) {
  const str = String(value);
  return str.length > 46 ? `${str.slice(0, 43)}...` : str;
}

module.exports = { buildPlan, printPlan };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
