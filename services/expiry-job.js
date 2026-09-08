// services/expiry-job.js — the nightly pass over expiry dates.
//
// Two halves, each behind its own flag, and both off by default:
//
//   RENEWAL_REMINDERS_ENABLED  writes to owners whose records are coming due
//   EXPIRY_DELETION_ENABLED    removes records that were not renewed
//
// Separate flags because they are switched on in that order. Whether these
// mails arrive has never been recorded anywhere, and the deletion half must not
// run until somebody has watched one land — otherwise people lose addresses
// after warnings that went nowhere, which is the exact failure this whole
// change was made to stop.
//
// The rules the job applies live in services/expiry.js; this file is the
// database work and the logging.

const config = require("../configs/index");
const bindService = require("./bind");
const { deleteSubdomain } = require("./subdomain");
const { sendRenewalReminderEmail } = require("./email");
const renewalToken = require("./renewal-token");
const { REMINDER_DAYS, daysUntil, reminderStageFor, shouldSendReminder } = require("./expiry");

/**
 * Gather what is coming due into one mail per person per reminder.
 *
 * 🔴 The grouping key is (owner, stage), not owner alone.
 *
 * Stage first: the backfill dated all 44 existing records from the day it ran,
 * so one owner's records fall due together and one mail covers them — but new
 * records are dated from when they were made, and two records a fortnight
 * apart are at different points in the countdown. They cannot share a mail,
 * because
 *   1. the mail states a deadline, and it would have to state two, and
 *   2. `renewal_notice_stage` is recorded per record against the mail that was
 *      sent. One send cannot honestly record two different stages.
 * Grouping by owner alone would either lie about a date or mark a record as
 * reminded at a stage it was never reminded at, and a record marked too early
 * is a record whose real reminder never goes out.
 *
 * Owner second: a mail per record meant 33 mails over one period for the
 * person holding 11 subdomains. At that point the button they press is
 * "unsubscribe", and the mail that matters — the one before deletion — is the
 * one that never arrives.
 *
 * Only user-owned records are here at all: the join to `users` is what leaves
 * agent-created ones out, and they have no address attached, which is why
 * their expiry date is carried in the API responses they read instead.
 */
async function sendRenewalReminders(fastify, now = new Date()) {
  const [rows] = await fastify.mysql.query(
    `SELECT s.id, s.subdomain, s.expires_at, s.renewal_notice_stage,
            s.user_id, m.domain_name, u.email
       FROM subdomains s
       JOIN managed_domains m ON s.domain_id = m.id
       JOIN users u ON s.user_id = u.id
      WHERE s.expires_at IS NOT NULL
        AND s.expires_at <= DATE_ADD(NOW(), INTERVAL ${Number(REMINDER_DAYS[0])} DAY)
      ORDER BY s.expires_at`
  );

  const groups = new Map();
  for (const record of rows) {
    const daysLeft = daysUntil(record.expires_at, now);
    const stage = reminderStageFor(daysLeft);
    if (!shouldSendReminder(stage, record.renewal_notice_stage)) continue;

    const key = `${record.user_id}:${stage}`;
    let group = groups.get(key);
    if (!group) {
      group = { email: record.email, stage, daysLeft, records: [] };
      groups.set(key, group);
    }
    // The soonest of them is the deadline the mail leads with, because the one
    // button renews the lot. Every record's own date is in the list as well.
    group.daysLeft = Math.min(group.daysLeft, daysLeft);
    group.records.push({
      id: record.id,
      subdomain: record.subdomain,
      domain: record.domain_name,
      expiresAt: record.expires_at,
    });
  }

  let sent = 0;
  let messages = 0;
  for (const group of groups.values()) {
    const fqdns = group.records.map((r) => `${r.subdomain}.${r.domain}`);
    const base = {
      evt: "renewal_reminder",
      fqdns,
      records: group.records.length,
      stage: group.stage,
      days_left: group.daysLeft,
    };

    if (!config.expiry.remindersEnabled) {
      fastify.log.warn(
        { ...base, action: "withheld" },
        `Renewal reminder not sent (RENEWAL_REMINDERS_ENABLED is off): ${fqdns.join(" ")}`
      );
      continue;
    }

    const result = await sendRenewalReminderEmail(group.email, {
      records: group.records,
      daysLeft: group.daysLeft,
      renewUrl: `${config.server.publicOrigin}/renew/${renewalToken.sign(
        group.records.map((r) => r.id)
      )}`,
    });

    if (!result.ok) {
      // The stage is deliberately not recorded — for any of them. A mail that
      // failed has not been sent, so tomorrow's run should offer this whole
      // group again.
      fastify.log.error(
        { ...base, action: "failed", error: result.error },
        `Renewal reminder failed for ${fqdns.join(" ")}`
      );
      continue;
    }

    // Every record the mail listed, in one statement. Marking only some of
    // them would send the rest the same mail again tomorrow night. The
    // placeholders are counted from the group, never from anything a caller
    // supplied, and the ids still go in as parameters.
    const ids = group.records.map((r) => r.id);
    await fastify.mysql.execute(
      `UPDATE subdomains SET renewal_notice_stage = ? WHERE id IN (${ids.map(() => "?").join(", ")})`,
      [group.stage, ...ids]
    );
    sent += ids.length;
    messages++;
    fastify.log.info({ ...base, action: "sent" }, `Renewal reminder sent for ${fqdns.join(" ")}`);
  }

  return { considered: rows.length, sent, messages };
}

/**
 * Remove what was not renewed.
 *
 * `expires_at < NOW()` and the job runs at midnight, so a record due at any
 * time today is still in the future at tonight's run: the "expires today"
 * reminder goes out on one run and the removal happens on the next. That gap
 * is on purpose and is the only grace period there is.
 *
 * A NULL expires_at is skipped — it means never expires, which is what a row
 * the backfill missed looks like, and those must not be swept up.
 */
async function removeExpired(fastify) {
  const [rows] = await fastify.mysql.query(
    `SELECT s.id, s.subdomain, s.record_type, s.record_value, s.owner_type,
            s.expires_at, m.domain_name
       FROM subdomains s
       JOIN managed_domains m ON s.domain_id = m.id
      WHERE s.expires_at IS NOT NULL
        AND s.expires_at < NOW()
      ORDER BY s.id`
  );

  let removed = 0;
  for (const record of rows) {
    const base = {
      evt: "expire",
      subdomain: record.subdomain,
      domain: record.domain_name,
      owner: record.owner_type,
      expires_at: new Date(record.expires_at).toISOString(),
    };

    if (!config.expiry.deletionEnabled) {
      fastify.log.warn(
        { ...base, action: "withheld" },
        `Expired but not removed (EXPIRY_DELETION_ENABLED is off): ${record.subdomain}.${record.domain_name}`
      );
      continue;
    }

    try {
      await deleteSubdomain(fastify, {
        recordId: record.id,
        subdomain: record.subdomain,
        domain: record.domain_name,
        recordType: bindService.normalizeRecordType(record.record_type),
      });
      removed++;
      fastify.log.warn({ ...base, action: "removed" }, `Removed expired subdomain ${record.subdomain}.${record.domain_name}`);
    } catch (err) {
      fastify.log.error(
        { ...base, action: "failed", err },
        `Failed to remove expired subdomain ${record.subdomain}.${record.domain_name}`
      );
    }
  }

  return { due: rows.length, removed };
}

async function runExpiryJob(fastify) {
  if (config.bind.devMode) {
    fastify.log.info("Skipping expiry job in dev mode");
    return;
  }

  const reminders = await sendRenewalReminders(fastify);
  const expired = await removeExpired(fastify);

  fastify.log.info(
    { evt: "expiry_run", ...reminders, ...expired },
    `Expiry pass: ${reminders.sent}/${reminders.considered} reminded in ${reminders.messages} ` +
      `message(s), ${expired.removed}/${expired.due} removed`
  );
}

module.exports = { sendRenewalReminders, removeExpired, runExpiryJob };
