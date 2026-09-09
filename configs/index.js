require("dotenv").config();

const required = [
  "JWT_SECRET",
  "DB_USER",
  "DB_PASSWORD",
  "DB_DATABASE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
];
const devMode =
  String(process.env.BIND_DEV_MODE || "").trim().toLowerCase() === "true";

if (!devMode && !process.env.BIND_DB_PATH) {
  required.push("BIND_DB_PATH");
}

if (!devMode) {
  if (!process.env.TELEGRAM_BOT_TOKEN) required.push("TELEGRAM_BOT_TOKEN");
  if (!process.env.TELEGRAM_ALERT_CHAT_ID) required.push("TELEGRAM_ALERT_CHAT_ID");
}

function parseIntEnv(envKey, defaultVal) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return defaultVal;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer value for ${envKey}: ${raw}`);
  }
  return parsed;
}

/**
 * A flag that has to be switched on deliberately.
 *
 * Everything that sends mail or removes a record defaults to off, so a deploy
 * never starts one of them by arriving. deploy/README.md §4 lists them.
 */
function parseBoolEnv(envKey, defaultVal) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return defaultVal;
  return String(raw).trim().toLowerCase() === "true";
}

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}`
  );
}

// Which chain a token is on unless the token says otherwise.
const x402Network = (process.env.X402_NETWORK || "base").trim();

/**
 * One token we are willing to be paid in, read from `X402_<SYMBOL>_*`.
 *
 * No default address, deliberately: an unset address is how a token stays
 * listed here without being offered to anybody (services/x402.js drops it and
 * says so once). Decimals default to six, which is what USDC and USDT have on
 * the chains this would run on, and can be set for one that does not.
 */
function asset(symbol) {
  return {
    symbol,
    address: (process.env[`X402_${symbol}_ADDRESS`] || "").trim(),
    network: (process.env[`X402_${symbol}_NETWORK`] || x402Network).trim(),
    decimals: parseIntEnv(`X402_${symbol}_DECIMALS`, 6),
  };
}

module.exports = {
  db: {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
  },
  bind: {
    zoneFilePath: (domain) => `${process.env.BIND_DB_PATH}/db.${domain}`,
    devMode,
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
  },
  email: {
    // Which way mail goes out. Gmail was the only way until 2026-09-08 and
    // sent as a personal account; it is kept as the way back, not as a
    // fallback the code takes on its own — a message that quietly left from
    // somewhere else would be worse than one that did not leave.
    provider: (process.env.EMAIL_PROVIDER || "resend").trim().toLowerCase(),
    // The address recipients see. Resend sends from a domain we own, so this
    // is a real default rather than something that has to be configured.
    from: process.env.EMAIL_FROM || "noreply@sitey.my",
    resend: {
      // Read from the environment and nowhere else, and never logged. Missing
      // is not checked at boot: mail is off by default (deploy/README.md §4)
      // and refusing to start over an unset mail key would take DNS down with
      // it. services/email.js fails loudly on the send instead.
      apiKey: process.env.RESEND_API_KEY,
    },
    gmail: {
      clientId: process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GMAIL_REDIRECT_URI,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      user: process.env.GMAIL_SENDER || process.env.GMAIL_USER || process.env.SMTP_USER,
      // Gmail can only send as the account it holds a token for, so the way
      // back keeps using that account unless an address was set on purpose.
      // `email.from` above has a default and would otherwise be rejected here.
      from: process.env.EMAIL_FROM || null,
    },
  },
  validation: {
    enabled:
      String(process.env.VALIDATION_ENABLED || "true")
        .trim()
        .toLowerCase() === "true",
    intervalMs: parseIntEnv("VALIDATION_INTERVAL_MS", 24 * 60 * 60 * 1000),
    // Replaces VALIDATION_TCP_TIMEOUT_MS: the check is an HTTP(S) request now,
    // which has a TLS handshake and a response to wait for, not just a connect.
    httpTimeoutMs: parseIntEnv("VALIDATION_HTTP_TIMEOUT_MS", 5000),
    concurrency: parseIntEnv("VALIDATION_CONCURRENCY", 5),
    batchSize: parseIntEnv("VALIDATION_BATCH_SIZE", 50),
    // How long a record may stay dark before its owner is told. Nothing is
    // removed at this point or any other — see services/validation.js.
    unreachableNoticeDays: parseIntEnv("UNREACHABLE_NOTICE_DAYS", 14),
    unreachableNoticeEnabled: parseBoolEnv("UNREACHABLE_NOTICE_ENABLED", false),
  },
  expiry: {
    intervalMs: parseIntEnv("EXPIRY_INTERVAL_MS", 24 * 60 * 60 * 1000),
    // Both off by default, and switched on in this order: whether these mails
    // are delivered has never been recorded, so nothing may be removed until a
    // reminder has been watched arriving. deploy/README.md §4.
    remindersEnabled: parseBoolEnv("RENEWAL_REMINDERS_ENABLED", false),
    deletionEnabled: parseBoolEnv("EXPIRY_DELETION_ENABLED", false),
  },
  // How many subdomains one subject may hold, and whether that number is
  // enforced or only counted.
  //
  // The axis is "how many", not "person or agent": somebody holding eleven
  // names for a company and an agent doing the same job are the same customer,
  // and two different allowances could be walked around by claiming to be the
  // other one. services/quota.js.
  quota: {
    // What an account gets when `users.subdomain_limit` says nothing.
    //
    // Five, and enforced, from 2026-09-09. Measured that day: of the 14
    // accounts holding anything, only two hold more than five and both already
    // carry an exception, so switching enforcement on refuses nobody who is
    // here today. The next largest holding is three.
    subdomainLimit: parseIntEnv("SUBDOMAIN_LIMIT_DEFAULT", 5),
    // 🔴 Off means observe. A request over the limit is written to the log as
    // the refusal it would have been, and then allowed through. Nobody has
    // ever been refused a subdomain for holding too many, and there is no
    // evidence anybody wants a fourth — that log line is how the question gets
    // answered, and enforcing before it is answered costs real users for a
    // demand we cannot show exists. deploy/README.md §7.
    enforced: parseBoolEnv("SUBDOMAIN_LIMIT_ENFORCED", false),
    // What is sold, and for how long. One payment is one bundle: five more
    // subdomains for a year, for 1.00. Nothing here is a rate per subdomain —
    // a bundle is the unit, and a caller who wants ten buys two.
    //
    // It sits here rather than with the payment route below because it is the
    // price of the thing, not the price of paying for it one particular way: a
    // card would charge the same number. services/credits.js.
    bundle: {
      // How many extra subdomains one bundle carries.
      size: parseIntEnv("SUBDOMAIN_BUNDLE_SIZE", 5),
      // In millionths of one unit, because USDC and USDT have six decimals —
      // 1.00 by default. An asset with a different number of decimals is
      // converted from this at the point of asking (services/x402.js), so this
      // stays one number whatever is being paid in.
      priceMicros: parseIntEnv("SUBDOMAIN_BUNDLE_PRICE_MICROS", 1000000),
      // How long a bundle lasts. Bundles stack rather than extend: buying a
      // second one adds five more and runs its own year, so a payment can
      // never shorten or lengthen a bundle that is already running.
      days: parseIntEnv("SUBDOMAIN_BUNDLE_DAYS", 365),
    },
  },
  // Paying for a subdomain over HTTP: a caller over their limit is answered
  // 402 with what to pay and where, pays, and repeats the request with the
  // proof in a header. It is the one way an agent can pay at all — a card
  // needs somebody to press a button in a browser.
  //
  // 🔴 Off, and switching it on is not enough: there is no wallet to be paid
  // into yet. With any of these empty the route reports itself off and says
  // which one is missing, rather than letting a request through it was
  // supposed to charge for. What a bundle costs is `quota.bundle.priceMicros`
  // above — that is the price of the thing, not of paying this way.
  // deploy/README.md §7.
  x402: {
    enabled: parseBoolEnv("X402_ENABLED", false),
    // The wallet that receives payment. No default, because it does not exist.
    payTo: (process.env.X402_PAY_TO || "").trim(),
    // The chain an asset is on unless it says otherwise.
    network: x402Network,
    // What we are willing to be paid in. Two are listed because Jay named two;
    // 🔴 neither is switched on, and USDT in particular is unconfirmed — which
    // token a facilitator will actually settle differs by facilitator and by
    // chain, and nobody has checked ours. That is why an address is required
    // and has no default: an asset with no address is not offered at all, so
    // this list can name a token we hope to take without claiming we take it.
    //
    // The address is the identity, not the symbol: the same name is a
    // different contract on every chain. `decimals` is how many the token's
    // own smallest unit has, which is what the price has to be converted into.
    assets: [asset("USDC"), asset("USDT")],
    // Who is asked whether a proof is good, and who moves the money. Checking
    // a signature against a chain needs a node and a crypto library; this is
    // the address of the thing that has both.
    facilitatorUrl: (process.env.X402_FACILITATOR_URL || "").trim().replace(/\/+$/, ""),
    timeoutMs: parseIntEnv("X402_TIMEOUT_MS", 10000),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID,
  },
  log: {
    // journald wants one JSON object per line; pino-pretty is for a terminal.
    // The app has no log file at all today, so this format *is* the record.
    pretty:
      String(
        process.env.LOG_PRETTY ??
          (process.env.NODE_ENV === "production" ? "false" : "true")
      )
        .trim()
        .toLowerCase() === "true",
    // Key material for hashing client IPs in the access log. Derived from
    // JWT_SECRET so turning the log on needs no new deployment step;
    // ACCESS_LOG_SECRET overrides it, and rotating it only makes older hashes
    // stop matching newer ones.
    hashSecret: process.env.ACCESS_LOG_SECRET || process.env.JWT_SECRET,
  },
  txt: {
    // TXT records are written at the root domain under this prefix (see
    // services/bind.js), so the prefix decides what the record *means for the
    // root domain itself*. `_acme-challenge` there would let any subdomain
    // owner answer a DNS-01 challenge for sitey.my and be issued a certificate
    // for it; `_dmarc` would rewrite the domain's mail policy. `_vercel` is
    // safe because its value names its own target
    // (`vc-domain-verify=<fqdn>,<token>`), so an extra value next to someone
    // else's proves nothing about their domain.
    // Measured 2026-09-07: 28 of 28 records in use are `_vercel`.
    apexPrefixes: (process.env.APEX_TXT_PREFIXES || "_vercel")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
  // Names in the zone that this app did not write. The reconciler compares the
  // zone with the database every night, and these have no row to match — that
  // is what they are, not drift, so it says nothing about them.
  //
  // A name here covers that name *and everything under it*. DNS names read
  // right to left, so `resend._domainkey` is a node beneath `_domainkey`, and
  // the selector is the half that changes: rotating a key or adding a second
  // sender mints a new one. Listing `resend._domainkey` would be correct until
  // the first rotation, and then wrong on the night somebody is doing mail
  // work. Relative names in a zone file put the parent on the right, so the
  // test in plugins/reconciler.js is a suffix on whole labels.
  //
  // `_vercel` must never appear here: those are user records, every one of
  // which has a row to match. tests/reconciler.test.js holds the two lists
  // apart.
  //
  // 🔴 Adding a record to a zone by hand means adding its name here too —
  // deploy/README.md §6. `send`/`rsend`/`_dmarc`/`_domainkey` are Resend's,
  // added 2026-09-08.
  infraRecords: (
    process.env.INFRA_RECORDS || "ns1,ns2,@,www,send,rsend,_dmarc,_domainkey"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  server: {
    port: process.env.PORT || 3000,
    host: "0.0.0.0",
    // Where a link in an email has to point. The app is behind Caddy and only
    // ever sees loopback, so it cannot work this out from a request — and the
    // Host header is the caller's to set. Canonical domain, decided 2026-09-07.
    publicOrigin: (process.env.PUBLIC_ORIGIN || "https://sitey.my").replace(/\/+$/, ""),
    // Which peers may set X-Forwarded-For. Caddy terminates HTTPS on this same
    // host and proxies over loopback, so loopback is the only honest source.
    // `trustProxy: true` trusted every hop, which let any caller pick their own
    // client IP with one header and take over another anonymous user's records.
    // Override only if the proxy ever moves off-box.
    trustProxy: (process.env.TRUSTED_PROXIES || "127.0.0.1,::1")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};
