// services/abuse-policy.js — what a caller with no account may not do.
//
// 2026-10-06/07 one anonymous caller used sitey to publish a malware contact
// point: a TXT record on a name of its own, and CNAMEs to a throwaway tunnel.
// Blocking its address held for a day; it came back from another one. An
// address is not an identity, so the rules below are about *what* is asked
// for rather than who is asking, and the line they draw is an account:
// somebody we could write to and whose key we could revoke.
//
// Both REST (routes/api-v1.js) and MCP (plugins/mcp.js) come here, so the
// wording an agent reads is the same on either road. The dashboard has no
// anonymous callers and never asks.
const config = require("../configs/index");

/** The way out, in every refusal: an API key is an account an agent can carry. */
const ACCOUNT_HINT =
  "Sign in to the dashboard, create an API key there, and send it as " +
  "'Authorization: Bearer styo_…' — over REST, or on the MCP request.";

const TXT_ACCOUNT_REQUIRED_MESSAGE =
  "TXT records need an account. " + ACCOUNT_HINT +
  " Records you already hold are unaffected, and their TXT records can still be deleted.";

/**
 * Is `hostname` one of the configured tunnel domains, or beneath one?
 * Suffix on whole labels, as services/redirect-safety.js does for our own
 * roots: `x.trycloudflare.com` is one, `nottrycloudflare.com` is not.
 */
function isTunnelHost(hostname) {
  const lower = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return config.abuse.anonTunnelDomains.some(
    (root) => lower === root || lower.endsWith(`.${root}`)
  );
}

/**
 * May a caller with no account point a record of this type at this value?
 *
 * Call it with the value as validated (validateRecordValue's `value`), so a
 * REDIRECT is already a well-formed URL and a CNAME already lower-cased.
 *
 * @returns {{ ok: true } | { ok: false, code: "TUNNEL_TARGET_FORBIDDEN", message: string }}
 */
function checkAnonTarget(recordType, value) {
  let host = null;
  if (recordType === "CNAME") {
    host = value;
  } else if (recordType === "REDIRECT") {
    try {
      host = new URL(value).hostname;
    } catch {
      // validateRecordValue has already refused anything URL() cannot read.
      host = null;
    }
  }
  if (!host || !isTunnelHost(host)) return { ok: true };

  return {
    ok: false,
    code: "TUNNEL_TARGET_FORBIDDEN",
    message:
      "Without an account a record may not point at a temporary tunnel " +
      `(${host}). Those addresses change hands every session. ` + ACCOUNT_HINT,
  };
}

module.exports = {
  ACCOUNT_HINT,
  TXT_ACCOUNT_REQUIRED_MESSAGE,
  isTunnelHost,
  checkAnonTarget,
};
