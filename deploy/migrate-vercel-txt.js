#!/usr/bin/env node
// Move TXT records from the shared zone apex to per-subdomain names.
//
//   node deploy/migrate-vercel-txt.js            # dry run, writes nothing
//   node deploy/migrate-vercel-txt.js --apply    # actually writes
//
// Background: TXT creation used to write the bare prefix (`_vercel`), one slot
// shared by the whole domain, while deletion looked for `<prefix>.<subdomain>`.
// The DB kept each owner's token separately, so it is the source of truth for
// rebuilding the per-subdomain records.
//
// ⚠️ Do not run this before sitey.my / sitey.one are on the Public Suffix List.
//    Until then Vercel asks for `_vercel` at the registered domain (the apex),
//    so the apex record is the one that actually verifies. See deploy/README.md.
//
// This script never deletes the apex record. It only reports it — that line may
// have been placed by hand by the operator, and removing it is a human call.

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
      "SELECT s.subdomain, m.domain_name AS domain, t.host_prefix, t.txt_value " +
        "FROM subdomain_txt_records t " +
        "JOIN subdomains s ON t.subdomain_id = s.id " +
        "JOIN managed_domains m ON s.domain_id = m.id " +
        "ORDER BY m.domain_name, s.subdomain, t.host_prefix"
    );

    console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} TXT record(s) in the database\n`);

    const zoneCache = new Map();
    const plan = [];

    for (const row of rows) {
      const zonePath = config.bind.zoneFilePath(row.domain);
      if (!zoneCache.has(zonePath)) {
        zoneCache.set(zonePath, await fs.readFile(zonePath, "utf8"));
      }
      const zone = zoneCache.get(zonePath);
      const targetName = `${row.host_prefix}.${row.subdomain}`;
      const present = new RegExp(`^${escapeRegex(targetName)}\\s+IN\\s+TXT\\s+`, "im").test(zone);

      plan.push({ ...row, targetName, present });
      console.log(
        `${present ? "  ok  " : "  ADD "} ${targetName}.${row.domain}` +
          (present ? "" : `   <- ${truncate(row.txt_value)}`)
      );
    }

    const missing = plan.filter((p) => !p.present);
    console.log(`\n${missing.length} record(s) to create, ${plan.length - missing.length} already in place.`);

    // Report — never remove — apex records left over from the old naming.
    console.log("\nApex records still in the zone files (left untouched):");
    const prefixes = [...new Set(rows.map((r) => r.host_prefix))];
    for (const [zonePath, zone] of zoneCache) {
      for (const prefix of prefixes) {
        const match = zone.match(new RegExp(`^${escapeRegex(prefix)}\\s+IN\\s+TXT\\s+.*$`, "im"));
        if (match) console.log(`  ${zonePath}: ${match[0].trim()}`);
      }
    }

    if (!APPLY) {
      console.log("\nNothing was written. Re-run with --apply to create the records above.");
      return;
    }

    for (const item of missing) {
      await bindService.createOrUpdateTxtRecord(
        item.subdomain,
        item.domain,
        item.host_prefix,
        item.txt_value
      );
      console.log(`  created ${item.targetName}.${item.domain}`);
    }
    console.log(`\nDone — ${missing.length} record(s) created.`);
  } finally {
    await connection.end();
  }
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value) {
  const str = String(value);
  return str.length > 50 ? `${str.slice(0, 47)}...` : str;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
