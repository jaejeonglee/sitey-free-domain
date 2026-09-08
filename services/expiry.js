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

module.exports = {
  USER_MONTHS,
  AGENT_MONTHS,
  REMINDER_DAYS,
  periodMonths,
  addMonths,
  expiryAfter,
  daysUntil,
  reminderStageFor,
  shouldSendReminder,
};
