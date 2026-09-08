const crypto = require("crypto");
const { google } = require("googleapis");
const config = require("../configs/index");

let gmailClient;

let logger = { info: () => {}, warn: () => {}, error: () => {} };

function setLogger(l) {
  logger = l;
}

// Purpose-separated key, same construction as services/access-log.js: a
// recipient in the log is personal data, and a hash from here cannot be lined
// up against a hash made anywhere else.
const RECIPIENT_HASH_KEY = crypto
  .createHmac("sha256", config.log.hashSecret)
  .update("sitey:email:recipient:v1")
  .digest();

function hashRecipient(address) {
  if (!address) return null;
  return crypto
    .createHmac("sha256", RECIPIENT_HASH_KEY)
    .update(String(address).trim().toLowerCase())
    .digest("base64url")
    .slice(0, 16);
}

function ensureGmailConfig() {
  const emailConfig = config.email || {};
  const gmail = emailConfig.gmail || {};
  const { clientId, clientSecret, redirectUri, refreshToken, user } = gmail;

  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new Error(
      "Gmail API credentials are not configured. Please set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, and GMAIL_REFRESH_TOKEN."
    );
  }

  return { clientId, clientSecret, redirectUri, refreshToken, user };
}

function ensureFromAddress(defaultUser) {
  const from = config.email?.gmail?.from || defaultUser;
  if (!from) {
    throw new Error(
      "EMAIL_FROM or GMAIL_SENDER must be configured to send verification emails."
    );
  }
  return from;
}

function getGmailClient() {
  if (gmailClient) {
    return gmailClient;
  }

  const { clientId, clientSecret, redirectUri, refreshToken } = ensureGmailConfig();
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  gmailClient = google.gmail({ version: "v1", auth: oauth2Client });
  return gmailClient;
}

function buildRawMessage({ from, to, subject, html }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ];

  const message = messageParts.join("\r\n");
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Resend's HTTP API, over the runtime's own fetch.
 *
 * One POST, so no client library: a package here would be a package the
 * nightly mail cannot go out without, and this send is already the last step
 * before somebody loses a subdomain they still want.
 *
 * The key is read at call time and stays in this function — it is not in the
 * log line, not in the error, and not in any test.
 */
async function sendViaResend({ to, subject, html }) {
  const apiKey = config.email?.resend?.apiKey;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set — nothing was sent. Put it in the server's " +
        "environment file, or set EMAIL_PROVIDER=gmail to go back to the old path."
    );
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [to],
      subject,
      html,
    }),
  });

  // Resend answers in JSON either way — `{id}` when it took the message,
  // `{name, message}` when it refused. The status decides, so a body that will
  // not parse cannot turn a refusal into a success or a success into a crash.
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || `Resend API ${response.status}`);
  }
  return { id: body?.id ?? null };
}

async function sendViaGmail({ to, subject, html }) {
  const gmail = getGmailClient();
  const { user } = ensureGmailConfig();
  const from = ensureFromAddress(user);
  const raw = buildRawMessage({ from, to, subject, html });

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return { id: response?.data?.id ?? null };
}

const TRANSPORTS = { resend: sendViaResend, gmail: sendViaGmail };

/**
 * Fail-close: a name that is not a transport sends nothing. Falling back to
 * the default would mail from an address nobody chose, and the whole reason
 * for this switch is that mail was going out from the wrong sender.
 */
function pickTransport(provider) {
  const transport = TRANSPORTS[provider];
  if (!transport) {
    throw new Error(
      `EMAIL_PROVIDER must be one of ${Object.keys(TRANSPORTS).join(", ")} — got "${provider}"`
    );
  }
  return transport;
}

/**
 * Send one message and write down what happened to it.
 *
 * Every send used to be fire-and-forget: whether any of these mails were ever
 * delivered was unknowable, which is the reason the notice below is off by
 * default until one has been watched arriving. The line names the record, not
 * the person — an address is personal data, and the fqdn is enough to find the
 * owner in the database when a delivery has to be chased. `id` is what the
 * provider called the message, which is what a support request is answered
 * with; `error` is why it refused.
 *
 * Never throws: a mail that cannot be sent is not a reason to abandon the job
 * that was sending it. The caller reads `ok`.
 *
 * @returns {Promise<{ok: boolean, id?: string|null, error?: string}>}
 */
async function send({ kind, to, subject, html, fqdn }) {
  const provider = config.email?.provider;
  const line = { evt: "email", kind, provider, fqdn, to: hashRecipient(to) };
  try {
    const { id } = await pickTransport(provider)({ to, subject, html });

    logger.info({ ...line, ok: true, id }, `Sent ${kind} for ${fqdn}`);
    return { ok: true, id };
  } catch (error) {
    // Gmail puts the useful part in the response body, not in error.message;
    // fetch says only "fetch failed" and hangs the real reason off `cause`.
    const reason =
      error?.response?.data?.error?.message ||
      error?.cause?.code ||
      error?.code ||
      error?.message ||
      "unknown";
    logger.error({ ...line, ok: false, error: String(reason) }, `Failed to send ${kind} for ${fqdn}`);
    return { ok: false, error: String(reason) };
  }
}

const FOOTER = `
      <p style="margin-top: 24px; font-size: 0.9rem; color: #4b5563;">
        This is an automated message from Sitey (sitey.my).
      </p>`;

/**
 * "Your address has not been answering." Not "we took it away".
 *
 * Nothing has been removed when this goes out and nothing will be on account
 * of it — the mail exists so that somebody who did not know their site was
 * down finds out. The tone follows from that.
 */
async function sendUnreachableNoticeEmail(to, subdomainInfo) {
  const { subdomain, domain, recordType, recordValue, days } = subdomainInfo;
  const fullDomain = `${subdomain}.${domain}`;

  return send({
    kind: "unreachable_notice",
    to,
    fqdn: fullDomain,
    subject: `[Sitey] ${fullDomain} hasn't been loading`,
    html: `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1d2330;">
      <h2 style="color: #1c2d4a;">${fullDomain} hasn't opened for ${days} days</h2>
      <p>We check each subdomain once a day. <strong>${fullDomain}</strong> has not
         answered for ${days} days in a row, so we thought you would want to know.</p>
      <table style="border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 12px; font-weight: bold;">Subdomain</td><td style="padding: 4px 12px;">${fullDomain}</td></tr>
        <tr><td style="padding: 4px 12px; font-weight: bold;">Record type</td><td style="padding: 4px 12px;">${recordType}</td></tr>
        <tr><td style="padding: 4px 12px; font-weight: bold;">Points at</td><td style="padding: 4px 12px;">${recordValue}</td></tr>
      </table>
      <p><strong>Your subdomain is still yours.</strong> Nothing has been removed and
         nothing will be removed because of this. If the target moved, you can point
         it somewhere else at <a href="https://sitey.my/dashboard">sitey.my</a>; if it
         is meant to be down, you can ignore this.</p>
      <p>We will not send this again unless the site comes back and goes dark once more.</p>${FOOTER}
    </div>
  `,
  });
}

/**
 * "Your subdomain is up for renewal — one click keeps it."
 *
 * Three of these go out per period, at 14 days, 3 days and on the day. The
 * link is a one-purpose signed token (services/renewal-token.js) so the button
 * works without a sign-in, which is the whole point: a renewal that takes a
 * login is a renewal most people will not do.
 */
async function sendRenewalReminderEmail(to, info) {
  const { subdomain, domain, daysLeft, expiresAt, renewUrl } = info;
  const fullDomain = `${subdomain}.${domain}`;
  const when =
    daysLeft <= 0
      ? "today"
      : daysLeft === 1
        ? "tomorrow"
        : `in ${daysLeft} days`;

  return send({
    kind: "renewal_reminder",
    to,
    fqdn: fullDomain,
    subject:
      daysLeft <= 0
        ? `[Sitey] ${fullDomain} expires today`
        : `[Sitey] ${fullDomain} expires ${when}`,
    html: `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1d2330;">
      <h2 style="color: #1c2d4a;">${fullDomain} expires ${when}</h2>
      <p>Subdomains on Sitey are renewed every few months so that names nobody is
         using go back into the pool. Yours is due on
         <strong>${new Date(expiresAt).toUTCString()}</strong>.</p>
      <p style="margin: 28px 0;">
        <a href="${renewUrl}"
           style="background: #1c2d4a; color: #ffffff; padding: 12px 24px;
                  border-radius: 6px; text-decoration: none; font-weight: bold;">
          Keep ${fullDomain}
        </a>
      </p>
      <p>That is the whole thing — one click, no sign-in, and the clock resets.
         If the link does not work, open it directly:<br>
         <span style="color: #4b5563; word-break: break-all;">${renewUrl}</span></p>
      <p>If you no longer need this subdomain, ignore this message and it will be
         released when it expires.</p>${FOOTER}
    </div>
  `,
  });
}

module.exports = {
  setLogger,
  hashRecipient,
  sendUnreachableNoticeEmail,
  sendRenewalReminderEmail,
};
