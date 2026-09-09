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
// ceiling by whole subdomains rather than being drawn down per request, which
// is the smallest thing that is true for both doors. The column is signed so
// that metering can arrive later without reshaping the table.

const config = require("../configs/index");

/** ER_NO_SUCH_TABLE — deploy/migrations/004 has not been applied here. */
const NO_TABLE = 1146;
/** ER_DUP_ENTRY — this settlement has already been credited. */
const DUPLICATE = 1062;

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
 * How many extra subdomains this account has already paid for.
 *
 * Whole slots only: a balance that does not cover one more name does not grant
 * one, and the remainder stays on the account.
 *
 * An account is the only thing a balance can belong to. A caller with no
 * account has nothing to attach one to, so their payment buys the request that
 * carried it and nothing more — see routes/api-v1.js.
 */
async function slotsFor(fastify, userId) {
  if (userId === null || userId === undefined) return 0;
  const price = config.quota.slotPriceMicros;
  if (!price || price <= 0) return 0;

  try {
    const [rows] = await fastify.mysql.execute(
      "SELECT COALESCE(SUM(amount_micros), 0) AS total FROM credit_entries WHERE user_id = ?",
      [userId]
    );
    const total = Number(rows[0]?.total || 0);
    return total <= 0 ? 0 : Math.floor(total / price);
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
 * @returns {{recorded: boolean, reason?: string}} `reason` is safe to show a
 *   caller: it says what happened, never what is in the table.
 */
async function record(fastify, { userId = null, payer = null, amountMicros, channel, reference }) {
  if (!reference) {
    // A payment we cannot name cannot be recorded once, which means it cannot
    // be stopped from being used twice. Refuse rather than credit it blind.
    return { recorded: false, reason: "the payment has no identifier to record it under" };
  }

  try {
    await fastify.mysql.execute(
      "INSERT INTO credit_entries (user_id, payer, amount_micros, channel, reference) VALUES (?, ?, ?, ?, ?)",
      [userId, payer, amountMicros, channel, reference]
    );
  } catch (err) {
    if (err?.errno === DUPLICATE) {
      return { recorded: false, reason: "this payment has already been used" };
    }
    if (err?.errno === NO_TABLE) {
      warnMissingTable(fastify);
      return { recorded: false, reason: "payments cannot be recorded on this server yet" };
    }
    throw err;
  }

  fastify.log.info(
    { evt: "credit", channel, reference, amount_micros: amountMicros, user_id: userId, payer },
    `Credited ${amountMicros} micros via ${channel}`
  );
  return { recorded: true };
}

module.exports = { slotsFor, record };
