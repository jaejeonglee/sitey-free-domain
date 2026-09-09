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
// wallet to be paid into yet. With the address, every token or the facilitator
// missing this reports itself off and says which one, every time. It never
// quietly lets through a request it was supposed to charge for.
//
// More than one token can be offered, and only the ones with an address
// configured are. Which tokens a facilitator will actually settle differs by
// facilitator and by chain, and ours has not been checked — so a token is
// named in the settings without that being a claim we take it, and one with no
// address drops out of the offer with a line in the log rather than being
// offered and failing at somebody else's expense.

const config = require("../configs/index");

// The version this speaks, sent on every facilitator call and in every 402.
const X402_VERSION = 1;
// The only scheme worth supporting here: a fixed amount for one request.
const SCHEME = "exact";
// How many decimals the price is quoted in (configs/index.js keeps it in
// millionths). A token with a different number is converted, so the price is
// one number however it is being paid.
const PRICE_DECIMALS = 6;

let logger = { info: () => {}, warn: () => {}, error: () => {} };

function setLogger(l) {
  logger = l;
}

let announced = false;
const assetAnnounced = new Set();

/**
 * The tokens we can actually be paid in: the configured ones that have an
 * address.
 *
 * A token with no address is dropped rather than offered. Saying we take USDT
 * when no USDT contract has been set would send a caller off to pay something
 * that cannot be settled, and they would carry the cost of our guess. It is
 * said once per token, because this is read on every request that reaches the
 * limit and a line per request would say nothing new.
 */
function usableAssets() {
  const usable = [];
  for (const candidate of config.x402.assets) {
    if (candidate.address) {
      usable.push(candidate);
      continue;
    }
    if (!assetAnnounced.has(candidate.symbol)) {
      assetAnnounced.add(candidate.symbol);
      logger.warn(
        { evt: "x402", action: "asset_unset", symbol: candidate.symbol },
        `${candidate.symbol} is listed but X402_${candidate.symbol}_ADDRESS is not set, ` +
          "so it is not offered as a way to pay"
      );
    }
  }
  return usable;
}

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

  const assets = usableAssets();
  const missing = [];
  if (!config.x402.payTo) missing.push("X402_PAY_TO");
  // One address is enough, so the names are one entry: any of them will do.
  if (assets.length === 0) {
    missing.push(config.x402.assets.map((a) => `X402_${a.symbol}_ADDRESS`).join(" or "));
  }
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
 * The bundle price in one token's own smallest unit.
 *
 * The price is quoted in millionths and a token counts in whatever it counts
 * in, so the two have to be lined up: six decimals is the same number, and
 * eighteen is that number followed by twelve zeroes. BigInt because eighteen
 * decimals of anything leaves the range a Number can hold exactly. A token
 * with fewer than six decimals rounds up, so the answer is never less than the
 * price — we have no such token, and undercharging is the worse way to be
 * wrong about one.
 */
function amountFor(asset) {
  const micros = BigInt(config.quota.bundle.priceMicros);
  const shift = asset.decimals - PRICE_DECIMALS;
  if (shift >= 0) return String(micros * 10n ** BigInt(shift));
  const unit = 10n ** BigInt(-shift);
  return String((micros + unit - 1n) / unit);
}

/**
 * What we are asking for, in one token.
 *
 * `resource` is the URL being charged for and travels back with the proof, so
 * a payment made for one endpoint cannot be spent at another.
 */
function requirementFor(asset, { resource, description }) {
  return {
    scheme: SCHEME,
    network: asset.network,
    maxAmountRequired: amountFor(asset),
    resource,
    description,
    mimeType: "application/json",
    payTo: config.x402.payTo,
    maxTimeoutSeconds: Math.ceil(config.x402.timeoutMs / 1000),
    asset: asset.address,
  };
}

/**
 * The body of a 402: one entry per token we can be paid in.
 *
 * The protocol has always let a server offer several, and a caller picks. An
 * empty list cannot happen here — the route asks status() first and a server
 * with no usable token reports itself off.
 */
function paymentRequiredBody({ resource, description, error }) {
  return {
    x402Version: X402_VERSION,
    error,
    accepts: usableAssets().map((asset) => requirementFor(asset, { resource, description })),
  };
}

/**
 * Which of the tokens we offered this payment is in.
 *
 * A payment has to be verified against the requirement it was made for, so
 * offering two means working out which one came back. The proof is asked, not
 * assumed: settling a USDT payment against the USDC requirement would be
 * asking the facilitator the wrong question.
 *
 * Naming nothing is allowed when only one token is on offer — that is what a
 * client that only echoes the scheme does, and there is no ambiguity to
 * resolve. With two on offer and nothing said, we refuse rather than guess.
 */
function assetOf(payload) {
  const named = String(payload.asset || "").trim().toLowerCase();
  const network = String(payload.network || "").trim().toLowerCase();

  let candidates = usableAssets();
  if (named) candidates = candidates.filter((a) => a.address.toLowerCase() === named);
  if (network) candidates = candidates.filter((a) => a.network.toLowerCase() === network);

  if (candidates.length === 1) return { ok: true, asset: candidates[0] };
  if (candidates.length === 0) {
    return { ok: false, reason: "the payment is in an asset this endpoint did not ask for" };
  }
  return {
    ok: false,
    reason: "the payment does not say which of the assets offered it was made in",
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
 * @returns {{ok:true, payer, reference, amountMicros, asset, responseHeader}}
 *        | {ok:false, reason:string}   `reason` is safe to show the caller.
 */
async function settle(headerValue, { resource, description }) {
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

  // Which token it is in, before anything is asked of the facilitator: a
  // payment in something we never offered is refused here rather than being
  // checked against a requirement it was not made for.
  const chosen = assetOf(payload);
  if (!chosen.ok) return { ok: false, reason: chosen.reason };

  const body = {
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirementFor(chosen.asset, { resource, description }),
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
    {
      evt: "x402",
      action: "settled",
      reference: String(reference),
      payer: settled.body.payer || null,
      asset: chosen.asset.symbol,
    },
    `Payment settled in ${chosen.asset.symbol}: ${reference}`
  );

  return {
    ok: true,
    payer: settled.body.payer || verified.body.payer || null,
    reference: String(reference),
    // The ledger counts in one unit whatever the payment was made in, so a
    // bundle bought with USDT and one bought with USDC are the same entry.
    amountMicros: config.quota.bundle.priceMicros,
    asset: chosen.asset.symbol,
    // What the protocol asks a paid response to carry back, so the caller can
    // see the transaction its money went into.
    responseHeader: Buffer.from(JSON.stringify(settled.body)).toString("base64"),
  };
}

module.exports = { setLogger, status, paymentRequiredBody, settle };
