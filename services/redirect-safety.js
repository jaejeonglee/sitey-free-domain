// services/redirect-safety.js — is this somewhere a REDIRECT may send people?
//
// A REDIRECT record turns a name we issue into a link somebody else controls,
// so the target is checked before it is written. Today the checks are shape
// and self-reference only. 🔴 Google Safe Browsing goes here once there is an
// API key for it: one more branch in checkRedirectTarget, same return shape.
//
// The rules are the whole policy, in one place, and both the REST route and
// the MCP tool reach them through utils/validators.js validateRecordValue.

const config = require("../configs/index");

/**
 * Is `hostname` one of the roots we issue names under, or beneath one?
 *
 * Suffix on whole labels: `sitey.my` and `x.sitey.my` are ours,
 * `notsitey.my` is not.
 */
function isOwnHost(hostname) {
  const lower = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return (config.redirect.ownDomains || []).some(
    (root) => lower === root || lower.endsWith(`.${root}`)
  );
}

/**
 * Check a REDIRECT target.
 *
 * @param {string} raw - what the caller sent
 * @returns {{valid: true, value: string} |
 *           {valid: false, code: "INVALID_REDIRECT_URL"|"REDIRECT_LOOP", message: string}}
 *   `value` is the URL as the WHATWG parser writes it back (lower-cased host,
 *   percent-encoded path), which is what goes in the Location header.
 */
function checkRedirectTarget(raw) {
  const trimmed = String(raw ?? "").trim();
  const invalid = (message) => ({ valid: false, code: "INVALID_REDIRECT_URL", message });

  if (!trimmed) {
    return invalid("Redirect target is required.");
  }
  if (trimmed.length > config.redirect.maxUrlLength) {
    return invalid(`Redirect target must be ${config.redirect.maxUrlLength} characters or fewer.`);
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return invalid("Redirect target must be an absolute URL starting with https:// (e.g. https://example.com/page).");
  }

  // https only. A name of ours sending visitors to a plain-http page would
  // hand every one of them an unencrypted hop we introduced.
  if (url.protocol !== "https:") {
    return invalid("Redirect target must start with https://. Plain http:// targets are not accepted.");
  }
  if (!url.hostname) {
    return invalid("Redirect target must name a host.");
  }
  // user:pass@host is a phishing shape ("https://bank.com@evil.example").
  if (url.username || url.password) {
    return invalid("Redirect target must not carry credentials.");
  }

  if (isOwnHost(url.hostname)) {
    return {
      valid: false,
      code: "REDIRECT_LOOP",
      message:
        `Redirect target must not point at ${config.redirect.ownDomains.join(", ")} or a name under them; ` +
        "two such records could send a browser round in a loop.",
    };
  }

  return { valid: true, value: url.href };
}

module.exports = { checkRedirectTarget, isOwnHost };
