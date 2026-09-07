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
    from: process.env.EMAIL_FROM,
    gmail: {
      clientId: process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GMAIL_REDIRECT_URI,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      user: process.env.GMAIL_SENDER || process.env.GMAIL_USER || process.env.SMTP_USER,
    },
  },
  validation: {
    enabled:
      String(process.env.VALIDATION_ENABLED || "true")
        .trim()
        .toLowerCase() === "true",
    intervalMs: parseIntEnv("VALIDATION_INTERVAL_MS", 24 * 60 * 60 * 1000),
    tcpTimeoutMs: parseIntEnv("VALIDATION_TCP_TIMEOUT_MS", 3000),
    concurrency: parseIntEnv("VALIDATION_CONCURRENCY", 5),
    batchSize: parseIntEnv("VALIDATION_BATCH_SIZE", 50),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID,
  },
  infraRecords: (process.env.INFRA_RECORDS || "ns1,ns2,@,www")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  server: {
    port: process.env.PORT || 3000,
    host: "0.0.0.0",
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
