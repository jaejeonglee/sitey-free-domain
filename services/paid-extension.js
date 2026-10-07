// services/paid-extension.js — a year on an agent's record, paid over x402.
//
// An agent-created record is lent for a month and renewed free a month at a
// time (services/expiry.js). That stays exactly as it is. This is the second
// door, for an agent that would rather not come back every month: one payment
// (X402_EXTEND_PRICE_MICROS, 1.00 by default) and the record runs a year from
// today. Jay, 2026-10-02 「x402로 결제 받는거 안되나?」.
//
// Both the REST route and the MCP tool come through extend() below, so there
// is one answer to "what does paying do". Nothing here speaks the payment
// protocol — services/x402.js does — and nothing here knows HTTP status codes;
// the callers turn a `state` into whatever their transport can carry.
//
// 🔴 Off unless the payment route is on (services/x402.js status()). Off is
// a plain answer, never a 402: a server that cannot settle a payment must not
// ask for one.
//
// Only a record held by an owner token. An account's records are three months
// and have a mailbox to be reminded at; the payment is for the caller that has
// neither, which is what "anonymous record" meant in the plan.

const config = require("../configs/index");
const x402 = require("./x402");
const credits = require("./credits");
const alertService = require("./alert");
const { addMonths, AGENT_MONTHS } = require("./expiry");

// What one payment buys. Fixed rather than a setting: "a year" is the thing
// on sale, and the price is the number that may move.
const PAID_MONTHS = 12;

function priceMicros() {
  return config.x402.extendPriceMicros;
}

/** "1.00" — the price as an agent reads it in a description. */
function priceText() {
  return (priceMicros() / 1e6).toFixed(2);
}

/**
 * Whether paying now would buy anything, and when it would.
 *
 * The year is measured from today, not added to the old date — the same rule
 * renewal has, so paying in a loop cannot stack up decades. That makes a
 * second payment while a paid year is still running worth almost nothing, so
 * it is refused before anybody is asked for money: the door opens once the
 * record is within one free period (a month) of falling due. A record on its
 * free month is always within that, so the first payment is never refused.
 */
function extensionWindow(expiresAt, now = new Date()) {
  if (expiresAt === null || expiresAt === undefined) {
    return { open: false, reason: "no_expiry", opensAt: null };
  }
  const due = new Date(expiresAt);
  if (due.getTime() <= addMonths(now, AGENT_MONTHS).getTime()) {
    return { open: true, reason: null, opensAt: null };
  }
  return { open: false, reason: "too_early", opensAt: addMonths(due, -AGENT_MONTHS) };
}

function notDueMessage({ reason, opensAt }, expiresAt) {
  if (reason === "no_expiry") {
    return "This subdomain has no expiry date, so there is nothing to extend.";
  }
  return (
    `Already paid up: this record runs until ${new Date(expiresAt).toISOString().slice(0, 10)}. ` +
    `A year is counted from the day you pay, so paying now would buy almost nothing. ` +
    `It opens again on ${opensAt.toISOString().slice(0, 10)}.`
  );
}

/**
 * The URL a payment is for. The same for REST and MCP, because it is the
 * same thing being bought, and free of any query string a caller arrived with.
 */
function resourceFor(subdomain, domain) {
  return `${config.server.publicOrigin}/api/v1/subdomains/${subdomain}/${domain}/extend`;
}

function descriptionFor(fqdn) {
  return `${PAID_MONTHS} months on ${fqdn}, counted from the day of payment.`;
}

/**
 * Extend one record by a paid year, or say why not.
 *
 * @param {object} args
 * @param {number} args.recordId   a row the caller has already been shown to own
 * @param {string} args.subdomain
 * @param {string} args.domain
 * @param {string|undefined} args.proof  the X-PAYMENT value, if the caller sent one
 * @returns {Promise<object>} `state` is one of
 *   "off"               — the payment route is off; `reason` names why
 *   "not_found"         — the row went away
 *   "not_agent"         — the row is an account's, not an owner token's
 *   "not_due"           — paying now would buy nothing; `message`, `expiresAt`, `opensAt`
 *   "payment_required"  — no proof; `body` is the x402 402 body
 *   "payment_invalid"   — the proof did not settle; `body` says why and asks again
 *   "replayed"          — that settlement was already spent; `body`
 *   "extended"          — `expiresAt`, `transaction`, `network`, `payer`, `responseHeader`
 */
async function extend(fastify, { recordId, subdomain, domain, proof }, now = new Date()) {
  const state = x402.status();
  if (!state.enabled) return { state: "off", reason: state.reason };

  const [rows] = await fastify.mysql.execute(
    "SELECT id, owner_type, expires_at FROM subdomains WHERE id = ?",
    [recordId]
  );
  const record = rows[0];
  if (!record) return { state: "not_found" };
  if (record.owner_type !== "agent") return { state: "not_agent" };

  const gate = extensionWindow(record.expires_at, now);
  if (!gate.open) {
    return {
      state: "not_due",
      message: notDueMessage(gate, record.expires_at),
      expiresAt: record.expires_at,
      opensAt: gate.opensAt,
    };
  }

  const fqdn = `${subdomain}.${domain}`;
  const asking = {
    resource: resourceFor(subdomain, domain),
    description: descriptionFor(fqdn),
    priceMicros: priceMicros(),
  };

  if (!proof) {
    return {
      state: "payment_required",
      body: x402.paymentRequiredBody({
        ...asking,
        error: `A year on ${fqdn} costs ${priceText()} USDC. Pay and repeat with the proof.`,
      }),
    };
  }

  const settlement = await x402.settle(proof, asking);
  if (!settlement.ok) {
    return {
      state: "payment_invalid",
      body: x402.paymentRequiredBody({ ...asking, error: settlement.reason }),
    };
  }

  // Written down before the date moves, and with no account: user_id NULL is
  // what keeps this payment out of services/credits.js slotsFor — it buys a
  // year on one name, not five more names. The row's own expires_at (the
  // bundle's year) means nothing for it. The unique (channel, reference) is
  // the replay guard, as it is for bundles.
  const recorded = await credits.record(fastify, {
    userId: null,
    payer: settlement.payer,
    amountMicros: settlement.amountMicros,
    channel: "x402",
    reference: settlement.reference,
  });
  if (!recorded.recorded) {
    if (recorded.code === "duplicate") {
      return {
        state: "replayed",
        body: x402.paymentRequiredBody({ ...asking, error: recorded.reason }),
      };
    }
    // The money has moved. Giving nothing for it is the worse failure, so the
    // year is granted and a person is told the ledger missed it.
    await alertService.critical("PAYMENT_UNRECORDED", {
      channel: "x402",
      purpose: "extend",
      reference: settlement.reference,
      amount_micros: settlement.amountMicros,
      reason: recorded.reason,
    });
  }

  const expiresAt = addMonths(now, PAID_MONTHS);
  try {
    await fastify.mysql.execute(
      "UPDATE subdomains SET expires_at = ?, renewal_notice_stage = NULL WHERE id = ?",
      [expiresAt, record.id]
    );
  } catch (err) {
    // Paid and not extended. Nobody can fix that from here; somebody has to
    // be told with the transaction in hand.
    await alertService.critical("PAID_EXTENSION_NOT_WRITTEN", {
      fqdn,
      reference: settlement.reference,
      err: err.message,
    });
    throw err;
  }

  fastify.log.info(
    {
      evt: "extend",
      fqdn,
      reference: settlement.reference,
      payer: settlement.payer,
      asset: settlement.asset,
      expires_at: expiresAt.toISOString(),
    },
    `Extended ${fqdn} by a paid year until ${expiresAt.toISOString()}`
  );

  return {
    state: "extended",
    expiresAt,
    transaction: settlement.reference,
    network: settlement.network,
    payer: settlement.payer,
    responseHeader: settlement.responseHeader,
  };
}

module.exports = { PAID_MONTHS, priceMicros, priceText, extensionWindow, resourceFor, extend };
