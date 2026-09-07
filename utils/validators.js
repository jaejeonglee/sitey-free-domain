// utils/validators.js — shared input validation (web + API)

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
 * traps an existing record.
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

function validateRecordValue(recordType, value, { subdomain, domain }) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return { valid: false, message: "Record value is required." };
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
  validateHostPrefix,
  validateRecordValue,
  validateTxtValue,
};
