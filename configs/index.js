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
