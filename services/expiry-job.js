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
 * Write to the people whose records are coming due.
 *
 * Only user-owned records: an agent-created one has no address attached, which
 * is why its expiry date is carried in the API responses it reads instead.
 */
async function sendRenewalReminders(fastify, now = new Date()) {
  const [rows] = await fastify.mysql.query(
    `SELECT s.id, s.subdomain, s.expires_at, s.renewal_notice_stage,
            m.domain_name, u.email
       FROM subdomains s
       JOIN managed_domains m ON s.domain_id = m.id
       JOIN users u ON s.user_id = u.id
      WHERE s.expires_at IS NOT NULL
        AND s.expires_at <= DATE_ADD(NOW(), INTERVAL ${Number(REMINDER_DAYS[0])} DAY)
      ORDER BY s.expires_at`
  );

  let sent = 0;
  for (const record of rows) {
    const daysLeft = daysUntil(record.expires_at, now);
    const stage = reminderStageFor(daysLeft);
    if (!shouldSendReminder(stage, record.renewal_notice_stage)) continue;

    const base = {
      evt: "renewal_reminder",
      subdomain: record.subdomain,
      domain: record.domain_name,
      stage,
      days_left: daysLeft,
    };

    if (!config.expiry.remindersEnabled) {
      fastify.log.warn(
        { ...base, action: "withheld" },
        `Renewal reminder not sent (RENEWAL_REMINDERS_ENABLED is off): ${record.subdomain}.${record.domain_name}`
      );
      continue;
    }

    const result = await sendRenewalReminderEmail(record.email, {
      subdomain: record.subdomain,
      domain: record.domain_name,
      daysLeft,
      expiresAt: record.expires_at,
      renewUrl: `${config.server.publicOrigin}/renew/${renewalToken.sign(record.id)}`,
    });

    if (!result.ok) {
      // The stage is deliberately not recorded: a mail that failed has not
      // been sent, so tomorrow's run should try this stage again.
      fastify.log.error(
        { ...base, action: "failed", error: result.error },
        `Renewal reminder failed for ${record.subdomain}.${record.domain_name}`
      );
      continue;
    }

    await fastify.mysql.execute(
      "UPDATE subdomains SET renewal_notice_stage = ? WHERE id = ?",
      [stage, record.id]
    );
    sent++;
    fastify.log.info({ ...base, action: "sent" }, `Renewal reminder sent for ${record.subdomain}.${record.domain_name}`);
  }

  return { considered: rows.length, sent };
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
    `Expiry pass: ${reminders.sent}/${reminders.considered} reminded, ${expired.removed}/${expired.due} removed`
  );
}

module.exports = { sendRenewalReminders, removeExpired, runExpiryJob };
