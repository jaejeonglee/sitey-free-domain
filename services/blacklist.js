// services/blacklist.js
//
// Names nobody may take, in three layers (2026-10-07):
//
//   reserved  — exact names the service itself needs (admin, ns1, mail …)
//   brands    — anywhere in the name, for everyone. `toss-login.sitey.my` is a
//               fake sign-in page the moment it exists, and an account does not
//               make it less of one.
//   words     — anywhere in the name, for a caller with NO account only.
//               `login-demo` is an ordinary thing for a developer to want, and
//               the same thing a phishing kit wants; an account is the line
//               between the two we can draw without reading anybody's mind.
//
// 🔴 Checked on create only. Names do not change after that, and a rule added
// today does not reach back and take a name somebody already holds —
// scripts/010-blacklist-hits.sql counts how many existing names a list would
// have caught, for deciding by hand.
//
// Matching is a substring, as it always was here. That catches `tosslogin` and
// `my-toss` alike, and it also catches `pineapple` under `apple`: the price of
// not being out-guessed by a missing hyphen.

const RESERVED_NAMES = new Set([
  "admin", "www", "mail", "ftp", "ns1", "ns2", "api",
  "mx", "smtp", "pop", "imap", "webmail",
  "_dmarc", "_acme-challenge", "autoconfig", "autodiscover",
]);

// Everyone. The first seven are the list as it stood before 2026-10-07 and
// stay here unchanged — `bank` and `signin` are also "words" below, but moving
// them would have opened them to accounts, and this change only ever narrows.
const BRAND_KEYWORDS = [
  "paypal", "google-login", "facebook-auth", "bank",
  "secure-login", "signin", "account-verify",
  "toss", "kakao", "naver", "upbit", "bithumb", "coinbase", "binance",
  "metamask", "apple", "icloud", "microsoft", "office365", "outlook",
  "amazon", "netflix", "instagram", "whatsapp", "telegram", "hometax",
  "shinhan", "kbstar", "wooribank", "hanabank", "kakaobank", "nhbank",
  "coupang",
];

// No account only.
const ANON_KEYWORDS = [
  "login", "signin", "verify", "wallet", "password", "recovery",
  "support", "security", "account", "auth", "bank",
];

/**
 * Check if a subdomain name is blacklisted
 * @param {string} subdomain - normalized (lowercase, trimmed)
 * @param {{ anonymous?: boolean }} [caller] - true when there is no account
 *   behind the request (no API key, no signed-in user)
 * @returns {{ blocked: boolean, reason?: string, code?: "BLACKLISTED"|"ACCOUNT_REQUIRED" }}
 */
function isBlacklisted(subdomain, { anonymous = false } = {}) {
  if (RESERVED_NAMES.has(subdomain)) {
    return { blocked: true, reason: "This subdomain name is reserved.", code: "BLACKLISTED" };
  }

  for (const keyword of BRAND_KEYWORDS) {
    if (subdomain.includes(keyword)) {
      return {
        blocked: true,
        reason: "This subdomain name is blocked by security policy.",
        code: "BLACKLISTED",
      };
    }
  }

  if (anonymous) {
    for (const keyword of ANON_KEYWORDS) {
      if (subdomain.includes(keyword)) {
        return {
          blocked: true,
          reason:
            `Names containing "${keyword}" need an account. Sign in to the dashboard, ` +
            "create an API key there, and send it as 'Authorization: Bearer styo_…' " +
            "(or the same header on the MCP request).",
          code: "ACCOUNT_REQUIRED",
        };
      }
    }
  }

  return { blocked: false };
}

module.exports = { isBlacklisted, RESERVED_NAMES, BRAND_KEYWORDS, ANON_KEYWORDS };
