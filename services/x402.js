// services/x402.js — the whole of the payment protocol, in one file.
//
// 🔴 Everything this service knows about paying over HTTP is in here on
// purpose. The specification is still moving — v2 arrived after v1 with
// session tokens and more chains, and the field names below are v1's — so when
// it moves again this is the only file that has to change. Nothing outside it
// learns the shape of a payment header, the wire format of the 402 body, or
// how a facilitator is asked. Callers ask two things: what do I answer with,
// and is this proof good.
//
// The shape of it: a caller over their limit is answered 402 with what to pay
// and where; they pay, and repeat the request with the proof in a header; the
// proof is checked, the payment settled, and the request goes on.
//
// We verify nothing ourselves. Checking a signature against a chain needs a
// node and a crypto library, and the facilitator exists to be that. It is the
// authority on whether a payment is good, which is also why its address is a
// setting: a different one can be pointed at without touching this code.
//
// 🔴 Off unless X402_ENABLED is set, and being set is not enough — there is no
// wallet to be paid into yet. With the address, the token or the facilitator
// missing this reports itself off and says which one, every time. It never
// quietly lets through a request it was supposed to charge for.

const config = require("../configs/index");

// The version this speaks, sent on every facilitator call and in every 402.
const X402_VERSION = 1;
// The only scheme worth supporting here: a fixed amount for one request.
const SCHEME = "exact";

let logger = { info: () => {}, warn: () => {}, error: () => {} };

function setLogger(l) {
  logger = l;
}

let announced = false;

/**
 * Whether payment can be asked for at all, and if not, why not.
 *
 * The reason is written for a person reading a log at deploy time, and names
 * the settings rather than describing them.
 */
function status() {
  if (!config.x402.enabled) {
    return { enabled: false, reason: "X402_ENABLED is off" };
  }

  const missing = [];
  if (!config.x402.payTo) missing.push("X402_PAY_TO");
  if (!config.x402.asset) missing.push("X402_ASSET");
  if (!config.x402.facilitatorUrl) missing.push("X402_FACILITATOR_URL");

  if (missing.length > 0) {
    const reason =
      `X402_ENABLED is on but ${missing.join(", ")} ` +
      `${missing.length === 1 ? "is" : "are"} not set, so there is nowhere to be paid ` +
      "and nobody to ask — the payment route stays off";
    if (!announced) {
      announced = true;
      logger.error({ evt: "x402", action: "disabled", missing }, reason);
    }
    return { enabled: false, reason };
  }

  return { enabled: true };
}

/**
 * What we are asking for: one payment, for one request.
 *
 * `resource` is the URL being charged for and travels back with the proof, so
 * a payment made for one endpoint cannot be spent at another.
 */
function requirementsFor({ resource, description }) {
  return {
    scheme: SCHEME,
    network: config.x402.network,
    maxAmountRequired: String(config.quota.slotPriceMicros),
    resource,
    description,
    mimeType: "application/json",
    payTo: config.x402.payTo,
    maxTimeoutSeconds: Math.ceil(config.x402.timeoutMs / 1000),
    asset: config.x402.asset,
  };
}

/**
 * The body of a 402. `accepts` is a list because the protocol lets a server
 * offer several ways to pay; we offer one.
 */
function paymentRequiredBody({ resource, description, error }) {
  return {
    x402Version: X402_VERSION,
    error,
    accepts: [requirementsFor({ resource, description })],
  };
}

/**
 * Ask the facilitator something. Resolves rather than throws: a facilitator
 * that is down must read as "this payment did not go through", never as a 500
 * on a request somebody is trying to pay for.
 */
async function ask(path, body) {
  const url = `${config.x402.facilitatorUrl}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.x402.timeoutMs),
    });
  } catch (err) {
    logger.error({ evt: "x402", action: "unreachable", path, err: err.message },
      `Payment facilitator could not be reached at ${url}`);
    return { ok: false, reason: "the payment facilitator could not be reached" };
  }

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    logger.error({ evt: "x402", action: "rejected", path, st: response.status },
      `Payment facilitator answered ${response.status}`);
    return {
      ok: false,
      reason: parsed?.error || `the payment facilitator answered ${response.status}`,
    };
  }
  return { ok: true, body: parsed };
}

/**
 * Check a payment proof and take the money.
 *
 * Verify first, settle second, and only then is anything owed to the caller:
 * a proof the facilitator will not accept never reaches the settle call, so a
 * bad proof costs nobody anything.
 *
 * A settlement that comes back without a transaction is refused even though it
 * says it succeeded. The transaction is the only name the payment has, and a
 * payment with no name cannot be recorded once — which means it cannot be
 * stopped from being presented again.
 *
 * @returns {{ok:true, payer, reference, amountMicros, responseHeader}}
 *        | {ok:false, reason:string}   `reason` is safe to show the caller.
 */
async function settle(headerValue, requirement) {
  const state = status();
  if (!state.enabled) return { ok: false, reason: state.reason };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(headerValue), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "the X-PAYMENT header is not base64-encoded JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "the X-PAYMENT header does not carry a payment" };
  }

  const body = {
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirement,
  };

  const verified = await ask("/verify", body);
  if (!verified.ok) return { ok: false, reason: verified.reason };
  if (verified.body?.isValid !== true) {
    return {
      ok: false,
      reason: verified.body?.invalidReason || "the facilitator did not accept this payment",
    };
  }

  const settled = await ask("/settle", body);
  if (!settled.ok) return { ok: false, reason: settled.reason };
  if (settled.body?.success !== true) {
    return {
      ok: false,
      reason: settled.body?.errorReason || "the payment could not be settled",
    };
  }

  const reference = settled.body?.transaction;
  if (!reference) {
    logger.error({ evt: "x402", action: "unnameable" },
      "Facilitator settled a payment without returning a transaction; refusing it");
    return {
      ok: false,
      reason: "the settlement came back without a transaction to record it under",
    };
  }

  logger.info(
    { evt: "x402", action: "settled", reference: String(reference), payer: settled.body.payer || null },
    `Payment settled: ${reference}`
  );

  return {
    ok: true,
    payer: settled.body.payer || verified.body.payer || null,
    reference: String(reference),
    amountMicros: config.quota.slotPriceMicros,
    // What the protocol asks a paid response to carry back, so the caller can
    // see the transaction its money went into.
    responseHeader: Buffer.from(JSON.stringify(settled.body)).toString("base64"),
  };
}

module.exports = { setLogger, status, requirementsFor, paymentRequiredBody, settle };
