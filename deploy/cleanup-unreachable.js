#!/usr/bin/env node
// One-off tidy-up of the records that are dark *today*.
//
//   node deploy/cleanup-unreachable.js                   # probe everything, list the dead
//   node deploy/cleanup-unreachable.js --notify          # dry run: who would be written to
//   node deploy/cleanup-unreachable.js --notify --apply  # send, and record the date
//   node deploy/cleanup-unreachable.js --purge           # dry run: what would be removed
//   node deploy/cleanup-unreachable.js --purge --apply   # remove those told 14+ days ago
//
// Why this is a script and not a rule in the server: the standing policy is
// that reachability never deletes (services/validation.js). This is the
// backlog that policy inherited — measured 2026-09-08, of 44 issued subdomains
// only 19 serve a page, because for months the nightly check called a resolving
// CDN hostname a living site. Those records need clearing once, by a person who
// has read the list, and then never this way again.
//
// The safety rails, in order:
//   * dry run unless --apply is passed, on every mode
//   * --purge removes nothing that was not notified at least GRACE_DAYS ago
//   * --purge re-probes first, so a site that came back is not removed
//   * the verdict is the same table the server uses — no second opinion here

const mysql = require("mysql2/promise");
const config = require("../configs/index");
const bindService = require("../services/bind");
const { probeRecord } = require("../services/validation");
const { deleteSubdomain } = require("../services/subdomain");
const { sendUnreachableNoticeEmail } = require("../services/email");

const APPLY = process.argv.includes("--apply");
const NOTIFY = process.argv.includes("--notify");
const PURGE = process.argv.includes("--purge");

// Days between telling somebody and taking the name. The same fortnight the
// standing notice uses, so nobody is removed on a shorter fuse than the policy.
const GRACE_DAYS = config.validation.unreachableNoticeDays;

const consoleLogger = {
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: () => {},
  fatal: (...args) => console.error(...args),
};

bindService.setLogger(consoleLogger);

/**
 * Which of the dark records may be removed now.
 *
 * Pure, so the rule can be checked without a database: a row qualifies only if
 * somebody was told about it and the grace period has since run out. A row
 * that was never notified is never removed by this script, whatever else is
 * true of it.
 */
function purgeCandidates(records, now = new Date(), graceDays = GRACE_DAYS) {
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
  return records.filter(
    (record) =>
      record.unreachable_notified_at != null &&
      new Date(record.unreachable_notified_at) <= cutoff
  );
}

/** run `fn` over `items`, at most `limit` at a time */
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

function fqdnOf(record) {
  return `${record.subdomain}.${record.domain_name}`;
}

function daysSince(date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}

async function probeAll(records) {
  const probes = await mapWithLimit(records, config.validation.concurrency, (record) =>
    probeRecord(
      bindService.normalizeRecordType(record.record_type),
      record.record_value,
      { fqdn: fqdnOf(record) }
    )
  );
  return records.map((record, i) => ({ ...record, probe: probes[i] }));
}

function printDead(dead, total) {
  console.log();
  console.log(`${dead.length} of ${total} record(s) are not answering right now:`);
  console.log();
  for (const record of dead) {
    const notified = record.unreachable_notified_at
      ? `told ${daysSince(record.unreachable_notified_at)}d ago`
      : "not told";
    console.log(
      `  ${fqdnOf(record).padEnd(34)} ${record.record_type.padEnd(6)} ` +
        `${String(record.record_value).padEnd(32)} ${record.owner_type.padEnd(6)} ` +
        `${record.email ? "has email" : "no email "}  ${notified}`
    );
    console.log(`      ${record.probe.detail}`);
  }
}

async function runNotify(connection, dead) {
  // Nobody is written to twice: a record already carrying a date has had its
  // message, and the standing job will not repeat it either.
  const targets = dead.filter((r) => r.email && !r.unreachable_notified_at);
  const skipped = dead.length - targets.length;

  console.log();
  console.log(
    `${targets.length} owner(s) would be written to; ${skipped} skipped ` +
      `(no address on the record, or already told).`
  );
  for (const record of targets) {
    console.log(`  ${fqdnOf(record)}`);
  }

  if (!APPLY) {
    console.log();
    console.log("Nothing was sent. Re-run with --notify --apply to send.");
    return;
  }

  let sent = 0;
  for (const record of targets) {
    const result = await sendUnreachableNoticeEmail(record.email, {
      subdomain: record.subdomain,
      domain: record.domain_name,
      recordType: record.record_type,
      recordValue: record.record_value,
      days: record.warning_count || 0,
    });

    if (!result.ok) {
      console.error(`  FAILED ${fqdnOf(record)} — ${result.error}`);
      continue;
    }
    // The date is what starts the clock --purge reads, so it is written only
    // when the message actually went.
    await connection.execute(
      "UPDATE subdomains SET unreachable_notified_at = NOW() WHERE id = ?",
      [record.id]
    );
    sent++;
    console.log(`  sent   ${fqdnOf(record)}`);
  }
  console.log();
  console.log(`Done — ${sent} of ${targets.length} message(s) sent and recorded.`);
}

async function runPurge(fastifyish, dead) {
  const candidates = purgeCandidates(dead);
  const waiting = dead.length - candidates.length;

  console.log();
  console.log(
    `${candidates.length} record(s) were told at least ${GRACE_DAYS} days ago and are ` +
      `still dark; ${waiting} not yet eligible (never told, or told more recently).`
  );
  for (const record of candidates) {
    console.log(
      `  ${fqdnOf(record).padEnd(34)} told ${daysSince(record.unreachable_notified_at)}d ago`
    );
  }

  if (!APPLY) {
    console.log();
    console.log("Nothing was removed. Re-run with --purge --apply to remove the list above.");
    return;
  }

  let removed = 0;
  for (const record of candidates) {
    try {
      await deleteSubdomain(fastifyish, {
        recordId: record.id,
        subdomain: record.subdomain,
        domain: record.domain_name,
        recordType: bindService.normalizeRecordType(record.record_type),
      });
      removed++;
      console.log(`  removed ${fqdnOf(record)}`);
    } catch (err) {
      console.error(`  FAILED  ${fqdnOf(record)} — ${err.message}`);
    }
  }
  console.log();
  console.log(`Done — ${removed} of ${candidates.length} record(s) removed.`);
}

async function main() {
  if (config.bind.devMode) {
    console.error("BIND_DEV_MODE is on — refusing to run, nothing would be written.");
    process.exitCode = 1;
    return;
  }

  const pool = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: 4,
  });

  // deleteSubdomain expects a Fastify instance; it uses exactly these two.
  const fastifyish = { mysql: pool, log: consoleLogger };

  try {
    const [records] = await pool.query(
      `SELECT s.id, s.subdomain, s.record_value, s.record_type, s.owner_type,
              s.warning_count, s.unreachable_notified_at, m.domain_name, u.email
         FROM subdomains s
         JOIN managed_domains m ON s.domain_id = m.id
         LEFT JOIN users u ON s.user_id = u.id
        ORDER BY m.domain_name, s.subdomain`
    );

    console.log(
      `${APPLY ? "APPLY" : "DRY RUN"} — probing ${records.length} record(s) over HTTP(S). ` +
        `This takes a minute.`
    );

    const probed = await probeAll(records);
    const dead = probed.filter((r) => !r.probe.ok);
    printDead(dead, records.length);

    if (NOTIFY) await runNotify(pool, dead);
    if (PURGE) await runPurge(fastifyish, dead);

    if (!NOTIFY && !PURGE) {
      console.log();
      console.log("Listing only. Add --notify to write to the owners, --purge to remove.");
    }
  } finally {
    await pool.end();
  }
}

module.exports = { purgeCandidates, mapWithLimit };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
