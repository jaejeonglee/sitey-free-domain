// services/credits.js — one balance, however the money arrived.
//
// Two doors are planned. An agent pays over HTTP with a stablecoin
// (services/x402.js); a person would pay with a card, because a card needs
// somebody to press a button in a browser and an agent has no browser. Neither
// door is open yet.
//
// Nothing outside this file should know which door a payment came through. The
// application has one question — how much may this account spend — and the
// answer is the sum of its entries. Adding a card later is a new value in
// `channel` and no new concept.
//
// Amounts are integers in millionths of one unit, so nothing here is a float.
// Only positive entries are written today: a payment raises the account's
// ceiling by a bundle of subdomains rather than being drawn down per request,
// which is the smallest thing that is true for both doors. The column is
// signed so that metering can arrive later without reshaping the table.
//
// What is sold is a bundle — five more subdomains for a year — and bundles
// stack rather than extend. A second payment adds five more and starts its own
// year, so the two run side by side and neither one moves the other. Extending
// would be the alternative and it is worse in both directions: it would let a
// caller buy ten years of five instead of a year of ten, and it would make one
// payment change the meaning of an earlier one. Each entry answers for itself.

const config = require("../configs/index");

/** ER_NO_SUCH_TABLE — deploy/migrations/004 has not been applied here. */
const NO_TABLE = 1146;
/** ER_DUP_ENTRY — this settlement has already been credited. */
const DUPLICATE = 1062;

const DAY_MS = 24 * 60 * 60 * 1000;

let tableWarned = false;

function warnMissingTable(fastify) {
  if (tableWarned) return;
  tableWarned = true;
  fastify.log.warn(
    { evt: "credits", action: "no_table" },
    "credit_entries is missing — apply deploy/migrations/004-credit-ledger.sql. " +
      "Until it is there no payment can be recorded and no balance can be read."
  );
}

/**
 * How many extra subdomains this account has paid for and has not used up the
 * year of.
 *
 * Only bundles that are still running are counted, which is the whole of what
 * expiry does here. 🔴 There is no rule for what happens when one ends,
 * because the rule that already exists is the answer: services/quota.js asks
 * about the *next* subdomain and never about the last one. An account holding
 * eight when its bundle lapses keeps all eight and is refused a ninth — the
 * limit falls, nothing is taken away, and the day it pays again the ninth is
 * allowed. Anything more than that would be this service removing names by
 * itself, which it has done once by accident and will not do on purpose.
 *
 * Whole bundles only: an amount that does not cover one does not grant a
 * partial one, and the remainder stays on the account.
 *
 * An account is the only thing a balance can belong to. A caller with no
 * account has nothing to attach one to, so their payment buys the request that
 * carried it and nothing more — see routes/api-v1.js.
 */
async function slotsFor(fastify, userId) {
  if (userId === null || userId === undefined) return 0;
  const { size, priceMicros } = config.quota.bundle;
  if (!priceMicros || priceMicros <= 0 || !size || size <= 0) return 0;

  try {
    const [rows] = await fastify.mysql.execute(
      // NOW() rather than a date from here: the database decides what has
      // lapsed, so a clock skewed on this host cannot hand out or withdraw a
      // year. A NULL expiry is one that never lapses — nothing writes one
      // today, and a grant entered by hand is the reason to allow it.
      "SELECT COALESCE(SUM(amount_micros), 0) AS total FROM credit_entries " +
        "WHERE user_id = ? AND (expires_at IS NULL OR expires_at > NOW())",
      [userId]
    );
    const total = Number(rows[0]?.total || 0);
    if (total <= 0) return 0;
    return Math.floor(total / priceMicros) * size;
  } catch (err) {
    if (err?.errno !== NO_TABLE) throw err;
    warnMissingTable(fastify);
    return 0;
  }
}

/**
 * Write down that money arrived.
 *
 * `reference` is the channel's own identifier for the payment, and the unique
 * index on (channel, reference) is what makes this idempotent: a payment proof
 * replayed a second time collides with the row it already wrote, and the
 * caller is told so rather than being given a second subdomain for one
 * payment.
 *
 * The bundle's year is set here rather than by the caller, and from `now`
 * rather than from anything already on the account: two bundles bought a month
 * apart lapse a month apart, which is what makes them stack instead of extend.
 *
 * @returns {{recorded: boolean, code?: string, reason?: string}}
 *   `reason` is safe to show a caller: it says what happened, never what is in
 *   the table. `code` separates the two failures that matter — "duplicate"
 *   means the caller gets nothing, anything else means the money has already
 *   moved and somebody has to be told.
 */
async function record(
  fastify,
  { userId = null, payer = null, amountMicros, channel, reference },
  now = new Date()
) {
  if (!reference) {
    // A payment we cannot name cannot be recorded once, which means it cannot
    // be stopped from being used twice. Refuse rather than credit it blind.
    return {
      recorded: false,
      code: "unnameable",
      reason: "the payment has no identifier to record it under",
    };
  }

  const expiresAt = new Date(now.getTime() + config.quota.bundle.days * DAY_MS);

  try {
    await fastify.mysql.execute(
      "INSERT INTO credit_entries (user_id, payer, amount_micros, channel, reference, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, payer, amountMicros, channel, reference, expiresAt]
    );
  } catch (err) {
    if (err?.errno === DUPLICATE) {
      return { recorded: false, code: "duplicate", reason: "this payment has already been used" };
    }
    if (err?.errno === NO_TABLE) {
      warnMissingTable(fastify);
      return {
        recorded: false,
        code: "unrecordable",
        reason: "payments cannot be recorded on this server yet",
      };
    }
    throw err;
  }

  fastify.log.info(
    {
      evt: "credit",
      channel,
      reference,
      amount_micros: amountMicros,
      user_id: userId,
      payer,
      expires_at: expiresAt.toISOString(),
    },
    `Credited ${amountMicros} micros via ${channel}, good until ${expiresAt.toISOString()}`
  );
  return { recorded: true };
}

module.exports = { slotsFor, record };
