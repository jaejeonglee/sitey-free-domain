const crypto = require("crypto");
const { google } = require("googleapis");
const config = require("../configs/index");
const { renewalReminder, unreachableNotice } = require("./message-layout");

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

/**
 * "Your address has not been answering." Not "we took it away".
 *
 * The words are in services/message-layout.js with the other two messages;
 * this is the send.
 */
async function sendUnreachableNoticeEmail(to, subdomainInfo) {
  const { subject, html } = unreachableNotice(subdomainInfo);

  return send({
    kind: "unreachable_notice",
    to,
    fqdn: `${subdomainInfo.subdomain}.${subdomainInfo.domain}`,
    subject,
    html,
  });
}

/**
 * "Your subdomains are up for renewal - one click keeps them."
 *
 * One mail per person per reminder, covering every subdomain of theirs at that
 * point in the countdown — see services/expiry-job.js for why they are grouped
 * and services/message-layout.js for what it says. The link is a one-purpose
 * signed token (services/renewal-token.js) so the button works without a
 * sign-in, which is the whole point: a renewal that takes a login is a renewal
 * most people will not do.
 *
 * `fqdn` on the log line is every name the mail listed, space separated, so a
 * delivery can still be traced back to the records it was about.
 *
 * @param {string} to
 * @param {{records: Array<{subdomain: string, domain: string, expiresAt: *}>,
 *          daysLeft: number, renewUrl: string}} info
 */
async function sendRenewalReminderEmail(to, info) {
  const { subject, html } = renewalReminder(info);

  return send({
    kind: "renewal_reminder",
    to,
    fqdn: info.records.map((r) => `${r.subdomain}.${r.domain}`).join(" "),
    subject,
    html,
  });
}

module.exports = {
  setLogger,
  hashRecipient,
  sendUnreachableNoticeEmail,
  sendRenewalReminderEmail,
};
