// utils/validators.js — shared input validation (web + API)
const { checkRedirectTarget } = require("../services/redirect-safety");

const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const HOSTNAME_REGEX =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}\.?$/i;

const TXT_MAX_LENGTH = 512;

// TXT host prefix: one or more DNS labels, each optionally starting with "_"
// (_vercel, _acme-challenge, selector1._domainkey ...).
const HOST_PREFIX_LABEL_REGEX = /^_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_PREFIX_MAX_LENGTH = 100;

// The host_prefix that means "no prefix at all — the subdomain's own name".
// `test.sitey.my IN TXT "..."` rather than `_vercel.sitey.my IN TXT "..."`.
//
// `@` is what a zone file calls the name it is already at, so it is the
// conventional spelling, and it is also the one value the label grammar above
// can never accept: no prefix a caller invents can collide with it, and no row
// already in subdomain_txt_records can be holding it. That is what lets it
// share the (subdomain_id, host_prefix) unique key with the real prefixes
// instead of needing a column of its own.
const TXT_SELF_NAME = "@";

function isValidSubdomain(name) {
  return SUBDOMAIN_REGEX.test(name);
}

/**
 * Validate a TXT record host prefix.
 *
 * The prefix ends up as the *name* of a zone file line
 * (`<prefix>\tIN\tTXT\t"..."`), so anything that is not a plain
 * DNS label lets the caller write arbitrary zone directives — a space turns
 * the rest of the input into extra fields, ";" starts a comment, "$" starts a
 * directive like $ORIGIN. Allow-list the label grammar instead of blocking
 * characters one by one.
 *
 * `allowed`, when given, additionally restricts the prefix to a list. Creation
 * paths pass one because the record lands on the shared root name, where the
 * prefix decides what the record claims about the root domain — see
 * configs/index.js. Deletion paths pass nothing, so shrinking the list never
 * traps an existing record. TXT_SELF_NAME is exempt from the list either way —
 * see below.
 */
function validateHostPrefix(hostPrefix, { allowed } = {}) {
  const trimmed = String(hostPrefix ?? "").trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, message: "host_prefix is required." };
  }
  if (trimmed.length > HOST_PREFIX_MAX_LENGTH) {
    return {
      valid: false,
      message: `host_prefix must be ${HOST_PREFIX_MAX_LENGTH} characters or fewer.`,
    };
  }
  // "@" is not a prefix at the root: it is the caller's own name, and they own
  // it already. The `allowed` list below exists because a name at the root is
  // a claim about the root domain (configs/index.js) — there is no such claim
  // here, so there is nothing for the list to gate.
  if (trimmed === TXT_SELF_NAME) {
    return { valid: true, value: TXT_SELF_NAME };
  }

  const labels = trimmed.split(".");
  for (const label of labels) {
    if (!HOST_PREFIX_LABEL_REGEX.test(label)) {
      return {
        valid: false,
        message:
          "host_prefix must be dot-separated DNS labels (letters, digits, '-', optional leading '_'), e.g. _vercel or selector1._domainkey.",
      };
    }
  }
  if (allowed && !allowed.includes(trimmed)) {
    return {
      valid: false,
      message:
        `host_prefix "${trimmed}" is not accepted. TXT records are written at the root domain, ` +
        `where the prefix decides what the record claims about the domain itself. ` +
        `Accepted: ${allowed.join(", ")}.`,
    };
  }
  return { valid: true, value: trimmed };
}

/**
 * May a TXT record be written at this name, given what the subdomain is?
 *
 * DNS allows no other data beside a CNAME (RFC 1034 §3.6.2): a CNAME says
 * "everything about this name is read somewhere else", so a TXT next to one
 * would never be looked at. BIND does not merely ignore it — `named-checkzone`
 * rejects the *whole zone* with "CNAME and other data", so one bad line stops
 * every name in the file from loading, not just this one.
 *
 * services/bind.js validates the temp file before it swaps it in, so the live
 * zone survives; what the caller gets is a 500 with nothing in it that says
 * what they did wrong. 23 of the 32 records in the live zone are CNAME, so
 * that is most people. Refuse before the write and say why.
 *
 * Only a self-named TXT can collide. An apex prefix such as `_vercel` is a
 * different name from the subdomain, and a CNAME at the subdomain has nothing
 * to say about it.
 */
function checkTxtRecordName(hostPrefix, recordType) {
  if (hostPrefix !== TXT_SELF_NAME) return { valid: true };
  if (String(recordType || "").trim().toUpperCase() !== "CNAME") return { valid: true };
  return {
    valid: false,
    code: "CNAME_CANNOT_HOLD_TXT",
    message:
      "This name is a CNAME, and DNS does not allow a TXT record beside a CNAME: a CNAME " +
      "means the name is an alias, so nothing else stored at it is ever read. Change the " +
      "record to an A record and add the TXT again, or store the value under a prefix such " +
      "as _vercel, which is a name of its own.",
  };
}

function validateRecordValue(recordType, value, { subdomain, domain }) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return { valid: false, message: "Record value is required." };
  }

  if (recordType === "REDIRECT") {
    // Shape, scheme and self-reference — services/redirect-safety.js holds
    // the rules, and carries `code` so the API can name the refusal.
    return checkRedirectTarget(trimmed);
  }

  if (recordType === "A") {
    if (!IPV4_REGEX.test(trimmed)) {
      return {
        valid: false,
        message: "Provide a valid IPv4 address (e.g. 203.0.113.10).",
      };
    }
    return { valid: true, value: trimmed };
  }

  const candidate = trimmed.toLowerCase();
  if (!HOSTNAME_REGEX.test(candidate)) {
    return {
      valid: false,
      message: "Provide a valid hostname (e.g. app.example.com).",
    };
  }

  const fullDomain = `${subdomain}.${domain}`.toLowerCase();
  if (candidate.replace(/\.$/, "") === fullDomain.replace(/\.$/, "")) {
    return {
      valid: false,
      message: "CNAME target cannot point to itself.",
    };
  }

  return { valid: true, value: candidate.replace(/\.$/, "") };
}

function validateTxtValue(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return { valid: false, message: "TXT value is required." };
  }
  if (trimmed.length > TXT_MAX_LENGTH) {
    return { valid: false, message: `TXT value must be ${TXT_MAX_LENGTH} characters or fewer.` };
  }
  if (/[\r\n]/.test(trimmed)) {
    return { valid: false, message: "TXT value must not contain newlines." };
  }
  if (/["\\\x00-\x1f]/.test(trimmed)) {
    return { valid: false, message: "TXT value contains invalid characters." };
  }
  return { valid: true, value: trimmed };
}

module.exports = {
  SUBDOMAIN_REGEX,
  IPV4_REGEX,
  HOSTNAME_REGEX,
  isValidSubdomain,
  TXT_SELF_NAME,
  validateHostPrefix,
  checkTxtRecordName,
  validateRecordValue,
  validateTxtValue,
};
