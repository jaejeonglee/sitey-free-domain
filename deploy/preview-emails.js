// deploy/preview-emails.js — write every message we send to disk, so it can be
// looked at in a browser before anybody is sent one.
//
// Here rather than in scripts/, which .gitignore keeps for SQL; this has to be
// in the repository because "look at it before switching the reminders on" is
// a step in deploy/README.md §4.
//
// Nothing here touches the network, the database or the environment: it builds
// the same documents services/email.js would post to Resend and saves them.
// Reading a template is not the same as seeing it, and these three are only
// ever seen once — by the recipient.
//
//   node deploy/preview-emails.js [output directory]
//
// Default output directory: /tmp/sitey-email-preview

const fs = require("fs");
const path = require("path");
const layout = require("../services/message-layout");

const outDir = process.argv[2] || "/tmp/sitey-email-preview";

const day = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

// The real shape of the problem this change was made for: one owner holding
// eleven subdomains that the backfill dated to the same day.
const ELEVEN = [
  "jay", "trend", "blog", "demo", "api", "staging",
  "docs", "shop", "test", "beta", "old",
].map((subdomain) => ({ subdomain, domain: "sitey.my", expiresAt: day(14) }));

const renewUrl =
  "https://sitey.my/renew/MSwyLDMsNCw1LDYsNyw4LDksMTAsMTEuMTc5NDQ2NDAwMDAwMA.7bK2xQpZ0mJvR4nT8sLcWdEfGhIjKlMnOpQrStUvWxY";

const documents = [
  [
    "01-renewal-reminder-grouped.html",
    "Renewal reminder, 11 subdomains, 14 days out - the case that made this change",
    layout.renewalReminder({ records: ELEVEN, daysLeft: 14, renewUrl }).html,
  ],
  [
    "02-renewal-reminder-single.html",
    "Renewal reminder, one subdomain, three days out",
    layout.renewalReminder({
      records: [{ subdomain: "demo", domain: "sitey.my", expiresAt: day(3) }],
      daysLeft: 3,
      renewUrl,
    }).html,
  ],
  [
    "03-renewal-reminder-today.html",
    "Renewal reminder, last of the three, sent on the day",
    layout.renewalReminder({
      records: [
        { subdomain: "jay", domain: "sitey.my", expiresAt: day(0) },
        { subdomain: "trend", domain: "sitey.my", expiresAt: day(0) },
      ],
      daysLeft: 0,
      renewUrl,
    }).html,
  ],
  [
    "04-unreachable-notice.html",
    "Your address has not been loading - nothing is removed because of it",
    layout.unreachableNotice({
      subdomain: "demo",
      domain: "sitey.my",
      recordType: "CNAME",
      recordValue: "cname.vercel-dns.com",
      days: 14,
    }).html,
  ],
  [
    "05-renewal-done.html",
    "The page after the button, 11 renewed",
    layout.renewalResultPage({
      renewed: ELEVEN.map((r) => ({
        fqdn: `${r.subdomain}.${r.domain}`,
        expiresAt: day(92),
      })),
      missing: 0,
    }),
  ],
  [
    "06-renewal-done-partial.html",
    "The page after the button, when one of them had already gone",
    layout.renewalResultPage({
      renewed: [
        { fqdn: "jay.sitey.my", expiresAt: day(92) },
        { fqdn: "trend.sitey.my", expiresAt: day(92) },
      ],
      missing: 1,
    }),
  ],
  ["07-link-expired.html", "A link older than 30 days", layout.renewalLinkPage("expired")],
  ["08-link-invalid.html", "A link that was not signed by us", layout.renewalLinkPage("invalid")],
];

fs.mkdirSync(outDir, { recursive: true });
for (const [name, , html] of documents) {
  fs.writeFileSync(path.join(outDir, name), html, "utf8");
}

// An index, so the whole set can be opened with one command.
const index = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>sitey — message preview</title></head>
<body style="font:15px/1.6 Arial,Helvetica,sans-serif;max-width:620px;margin:40px auto;padding:0 16px;">
<h1 style="font-size:20px;">sitey — every message we send</h1>
<p>Built from <code>services/message-layout.js</code>. Nothing was sent.</p>
<ol>${documents
  .map(([name, caption]) => `\n<li><a href="./${name}">${name}</a> — ${caption}</li>`)
  .join("")}
</ol>
</body></html>`;
fs.writeFileSync(path.join(outDir, "index.html"), index, "utf8");

console.log(`${documents.length + 1} files written to ${outDir}`);
console.log(`open ${path.join(outDir, "index.html")}`);
