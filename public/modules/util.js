import { IPV4_REGEX, HOSTNAME_REGEX } from "./constants.js";

export function normalizeRecordType(type = "A") {
  const upper = String(type || "A").trim().toUpperCase();
  return upper === "CNAME" || upper === "REDIRECT" ? upper : "A";
}

export function sanitizeHostname(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

export function validateRecordValue(recordType, value, context = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return { valid: false, message: "Enter a record value." };
  }

  if (recordType === "REDIRECT") {
    // The same shape rule the server applies (services/redirect-safety.js);
    // the server also refuses a URL under one of its own roots.
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || !url.hostname) {
      return {
        valid: false,
        message: "Use an absolute https:// URL (e.g. https://example.com/page).",
      };
    }
    if (trimmed.length > 2048) {
      return { valid: false, message: "The URL must be 2048 characters or fewer." };
    }
    return { valid: true, value: url.href };
  }

  if (recordType === "A") {
    if (!IPV4_REGEX.test(trimmed)) {
      return {
        valid: false,
        message: "Use a valid IPv4 address (e.g. 203.0.113.10).",
      };
    }
    return { valid: true, value: trimmed };
  }

  const target = sanitizeHostname(trimmed);
  if (!HOSTNAME_REGEX.test(target)) {
    return {
      valid: false,
      message: "Use a valid hostname (e.g. app.example.com).",
    };
  }

  if (context?.subdomain && context?.domain) {
    const full = `${context.subdomain}.${context.domain}`.toLowerCase();
    if (target === full.replace(/\.$/, "")) {
      return {
        valid: false,
        message: "CNAME target cannot point to itself.",
      };
    }
  }

  return { valid: true, value: target };
}
