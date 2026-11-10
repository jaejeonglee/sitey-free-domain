import { IPV4_REGEX, HOSTNAME_REGEX } from "./constants.js";
import { t } from "./i18n.js";

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
    return { valid: false, message: t("common.value.empty") };
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
        message: t("common.value.url"),
      };
    }
    if (trimmed.length > 2048) {
      return { valid: false, message: t("common.value.url_long") };
    }
    return { valid: true, value: url.href };
  }

  if (recordType === "A") {
    if (!IPV4_REGEX.test(trimmed)) {
      return {
        valid: false,
        message: t("common.value.ipv4"),
      };
    }
    return { valid: true, value: trimmed };
  }

  const target = sanitizeHostname(trimmed);
  if (!HOSTNAME_REGEX.test(target)) {
    return {
      valid: false,
      message: t("common.value.hostname"),
    };
  }

  if (context?.subdomain && context?.domain) {
    const full = `${context.subdomain}.${context.domain}`.toLowerCase();
    if (target === full.replace(/\.$/, "")) {
      return {
        valid: false,
        message: t("common.value.self"),
      };
    }
  }

  return { valid: true, value: target };
}
