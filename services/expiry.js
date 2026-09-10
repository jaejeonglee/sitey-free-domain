// services/expiry.js — when a subdomain lapses, and when its owner hears about it.
//
// A name is lent, not given. Renewal is the one thing that removes a record
// (see services/validation.js for why reachability no longer does), and it
// doubles as the only reason anyone comes back: the act of renewing is the
// visit.
//
// Two lifetimes, because the two kinds of owner are reachable in different
// ways. A person gets three months and a mail with a button in it. An agent
// gets one month and no mail at all — agent-created records have no address
// attached — so its expiry date rides along in every API response it reads,
// and one call renews it.

const USER_MONTHS = 3;
const AGENT_MONTHS = 1;

// How many days before expiry a person is written to. Three months is short
// enough that a month's notice would arrive before they had finished setting
// the thing up.
const REMINDER_DAYS = [14, 3, 0];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How close to expiry a record may be renewed.
 *
 * Read off the first reminder rather than written again. The mail that says
 * "renew now" and the door that opens when you press its button are the same
 * event, and the direction two separate numbers would drift in is the one that
 * hurts: a window shorter than the notice means somebody reads the mail we
 * sent, presses the button we put in it, and is turned away.
 *
 * There is a window at all because renewing measures from today rather than
 * adding to the old date (expiryAfter). A renewal taken on the day a record is
 * created would be worth nothing to its owner, and would still clear the
 * notice stage; asking near the deadline is what makes the answer mean the
 * name is still wanted.
 */
const RENEWAL_WINDOW_DAYS = REMINDER_DAYS[0];

function periodMonths(ownerType) {
  return ownerType === "agent" ? AGENT_MONTHS : USER_MONTHS;
}

/**
 * Add months the way MySQL's DATE_ADD does, clamping the day of the month.
 * Plain setMonth rolls 31 January + 1 month over into March; the backfill runs
 * in SQL and the application runs here, and the two have to agree.
 */
function addMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDayOfTargetMonth = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();
  result.setDate(Math.min(day, lastDayOfTargetMonth));
  return result;
}

/**
 * When a record issued or renewed *now* falls due.
 *
 * Deliberately blind to when the record was created. The 44 records that exist
 * today predate the whole idea, some by ten months, and dating them from
 * creation would expire the lot on the morning this is switched on — before
 * anybody had been given a chance to press the button. Everyone gets a full
 * period from the day it starts.
 *
 * The same rule applies to a renewal: the new date is measured from now, not
 * added to the old one, so calling renew in a loop cannot stack up years.
 */
function expiryAfter(now, ownerType) {
  return addMonths(new Date(now), periodMonths(ownerType));
}

/**
 * Whole days left, floored, so the day a record falls due reads as 0 rather
 * than as a fraction that never reaches it.
 */
function daysUntil(expiresAt, now) {
  return Math.floor((new Date(expiresAt).getTime() - new Date(now).getTime()) / DAY_MS);
}

/**
 * Which of the three notices is due, or null if it is too early.
 *
 * Ranges rather than exact matches: the job runs once a night and a night can
 * be missed — a restart, a machine that was down — and a missed reminder
 * should still go out late rather than never.
 */
function reminderStageFor(daysLeft) {
  if (daysLeft > REMINDER_DAYS[0]) return null;
  if (daysLeft > REMINDER_DAYS[1]) return REMINDER_DAYS[0];
  if (daysLeft > REMINDER_DAYS[2]) return REMINDER_DAYS[1];
  return REMINDER_DAYS[2];
}

/**
 * Stages count down (14, then 3, then 0), so a stage is due only when it is
 * lower than the last one sent. Renewal clears the record's stage back to null.
 */
function shouldSendReminder(stage, alreadySentStage) {
  if (stage === null) return false;
  if (alreadySentStage === null || alreadySentStage === undefined) return true;
  return stage < alreadySentStage;
}

/**
 * Whether this record may be renewed now, and when it could be.
 *
 * The only place the rule is written. All three doors — the link in the mail,
 * the REST call, the MCP tool — come through renewSubdomain to here, so none
 * of them carries its own copy of the comparison and none of them can be
 * forgotten when the number moves.
 *
 * @param {Date|string|null} expiresAt
 * @returns {{open: boolean, reason: string|null, daysLeft: number|null, opensAt: Date|null}}
 *   `reason` is "too_early" or "no_expiry" when shut, and the caller has to be
 *   able to say *when* — "not yet" on its own leaves nobody anything to do.
 */
function renewalWindow(expiresAt, now = new Date()) {
  if (expiresAt === null || expiresAt === undefined) {
    // NULL is "never expires" (deploy/migrations/002). There is no date to
    // move, and renewing would hand the record an expiry it did not have.
    return { open: false, reason: "no_expiry", daysLeft: null, opensAt: null };
  }

  const daysLeft = daysUntil(expiresAt, now);
  const opensAt = new Date(
    new Date(expiresAt).getTime() - RENEWAL_WINDOW_DAYS * DAY_MS
  );
  if (daysLeft > RENEWAL_WINDOW_DAYS) {
    return { open: false, reason: "too_early", daysLeft, opensAt };
  }
  return { open: true, reason: null, daysLeft, opensAt };
}

/**
 * What a caller with no screen is told when the window is shut.
 *
 * One sentence in one place: the REST endpoint and the MCP tool are answering
 * the same question and have no reason to word it differently. It names the
 * date, because an agent that is only told "too early" can do nothing but try
 * again blindly.
 */
function renewalNotDueMessage({ reason, daysLeft, opensAt }) {
  if (reason === "no_expiry") {
    return "This subdomain has no expiry date, so there is nothing to renew.";
  }
  return (
    `Too early to renew: ${daysLeft} days left. Renewal opens ` +
    `${RENEWAL_WINDOW_DAYS} days before expiry, on ${opensAt.toISOString().slice(0, 10)}.`
  );
}

/**
 * Extend one subdomain by its owner's period.
 *
 * The single place a record's expiry moves. Every entry point — the link in
 * the mail, the REST call, the MCP tool — lands here, so there is one answer
 * to "what does renewing do" and one place the notice stage is cleared.
 *
 * @returns {{renewed: boolean, reason?: string, expiresAt?: Date, ownerType?: string}}
 *   `renewed: false` carries a `reason`: "not_found" for no such row — the
 *   caller says the same thing whether it is missing or was never theirs — or
 *   the shut window's reason, which comes with the date it opens.
 */
async function renewSubdomain(fastify, subdomainId, now = new Date()) {
  const [rows] = await fastify.mysql.execute(
    "SELECT s.id, s.subdomain, s.owner_type, s.expires_at, m.domain_name FROM subdomains s " +
      "JOIN managed_domains m ON s.domain_id = m.id WHERE s.id = ?",
    [subdomainId]
  );
  const record = rows[0];
  if (!record) return { renewed: false, reason: "not_found" };

  const gate = renewalWindow(record.expires_at, now);
  if (!gate.open) {
    fastify.log.info(
      {
        evt: "renew",
        action: "not_due",
        subdomain: record.subdomain,
        domain: record.domain_name,
        owner: record.owner_type,
        days_left: gate.daysLeft,
      },
      `Refused: ${record.subdomain}.${record.domain_name} is not due yet`
    );
    return {
      renewed: false,
      reason: gate.reason,
      daysLeft: gate.daysLeft,
      opensAt: gate.opensAt,
      expiresAt: record.expires_at,
      ownerType: record.owner_type,
      subdomain: record.subdomain,
      domain: record.domain_name,
    };
  }

  const expiresAt = expiryAfter(now, record.owner_type);
  // renewal_notice_stage back to NULL: the next period starts with none of its
  // three reminders sent.
  await fastify.mysql.execute(
    "UPDATE subdomains SET expires_at = ?, renewal_notice_stage = NULL WHERE id = ?",
    [expiresAt, record.id]
  );

  fastify.log.info(
    {
      evt: "renew",
      subdomain: record.subdomain,
      domain: record.domain_name,
      owner: record.owner_type,
      expires_at: expiresAt.toISOString(),
    },
    `Renewed ${record.subdomain}.${record.domain_name} until ${expiresAt.toISOString()}`
  );

  return {
    renewed: true,
    expiresAt,
    ownerType: record.owner_type,
    subdomain: record.subdomain,
    domain: record.domain_name,
  };
}

module.exports = {
  USER_MONTHS,
  AGENT_MONTHS,
  REMINDER_DAYS,
  RENEWAL_WINDOW_DAYS,
  renewalWindow,
  renewalNotDueMessage,
  periodMonths,
  addMonths,
  expiryAfter,
  daysUntil,
  reminderStageFor,
  shouldSendReminder,
  renewSubdomain,
};
