// services/message-layout.js — the one shape everything a person reads from us
// comes in: the two mails, and the page they land on after pressing the button.
//
// It is in one file so that matching these to the web design later is one
// edit. Splitting the mails from the page would mean the page drifts, and the
// page is the last thing somebody sees after clicking a link out of an inbox.
//
// What may be used here is decided by the worst client, not the best one:
//
//   * inline styles only — Gmail strips <style> blocks in some clients, and
//     there is no external stylesheet a mail reader will fetch
//   * tables for layout — flexbox and grid are not reliable in mail
//   * no images, no web fonts, no javascript. Every word has to be text: a
//     mail with images off must still say what it means, and a mail is often
//     read with images off
//   * a background colour AND a text colour on every element that holds words.
//     Dark mode inverts what it is given, and an element with only one of the
//     two ends up as white on white
//
// Config is deliberately not required from here: these documents can then be
// rendered by scripts/preview-emails.js with no environment and no secrets, so
// what will actually be sent can be looked at before it is sent to anyone.

const FONT = "Arial, Helvetica, sans-serif";

// One palette, so a redesign is a change to these seven lines.
const INK = "#111827"; // body text
const MUTED = "#5b6470"; // dates, small print
const PAPER = "#ffffff"; // the card
const BACKDROP = "#f4f5f7"; // around the card
const LINE = "#e3e6ea"; // rules and borders
const ACCENT = "#1c2d4a"; // the button, links
const ALERT = "#8a2b2b"; // a heading that is bad news

const DASHBOARD_URL = "https://sitey.my/dashboard";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "22 September 2026", in UTC.
 *
 * Spelled out rather than 22/09/2026, which is read two ways depending on
 * where the reader is. UTC because the expiry dates are stored and compared in
 * UTC and a mail that names a different day from the job is worse than one
 * that is a few hours out. Written by hand rather than through toLocaleDateString
 * so it cannot change with the runtime's locale data.
 */
function formatDate(value) {
  const date = new Date(value);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "today" / "tomorrow" / "in 4 days" — how a date is said in a sentence. */
function whenIn(daysLeft) {
  if (daysLeft <= 0) return "today";
  if (daysLeft === 1) return "tomorrow";
  return `in ${daysLeft} days`;
}

// --- blocks -----------------------------------------------------------------
// Each one is a table row, so they can be listed in any order and the skeleton
// does not have to know what is in them.

function cell(inner, padding = "0 28px 16px") {
  return `<tr><td style="padding:${padding};background-color:${PAPER};">${inner}</td></tr>`;
}

/**
 * A paragraph. `muted` is for small print — still readable, not shouting.
 *
 * `breakAnywhere` is for the raw renewal link. A token is one unbreakable word
 * about 90 characters long, and a table sized by its content stretches to fit
 * it — which pushed the whole card past its 560px and ran every line off the
 * right edge. Seen in a rendered preview, not reasoned about.
 */
function text(content, { muted = false, breakAnywhere = false } = {}) {
  const size = muted ? "13px" : "15px";
  const color = muted ? MUTED : INK;
  const wrap = breakAnywhere ? "word-break:break-all;" : "";
  return cell(
    `<p style="margin:0;font:${size}/1.6 ${FONT};color:${color};${wrap}">${content}</p>`
  );
}

/**
 * The subdomains this message is about, one per line.
 *
 * One column rather than two: a name and a date side by side wrap into a mess
 * on a phone, and this list is the part somebody actually reads.
 */
function list(items) {
  const rows = items
    .map(
      ({ name, detail }) => `<tr><td style="padding:12px 0;border-top:1px solid ${LINE};background-color:${PAPER};">
<div style="font:bold 15px/1.4 ${FONT};color:${INK};">${escapeHtml(name)}</div>
<div style="font:13px/1.5 ${FONT};color:${MUTED};">${escapeHtml(detail)}</div>
</td></tr>`
    )
    .join("");
  return cell(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`
  );
}

/** Label/value pairs — what a record is and where it points. */
function facts(rows) {
  const body = rows
    .map(
      ([label, value]) => `<tr>
<td style="padding:6px 16px 6px 0;font:13px/1.5 ${FONT};color:${MUTED};background-color:${PAPER};white-space:nowrap;">${escapeHtml(label)}</td>
<td style="padding:6px 0;font:13px/1.5 ${FONT};color:${INK};background-color:${PAPER};word-break:break-all;">${escapeHtml(value)}</td>
</tr>`
    )
    .join("");
  return cell(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${LINE};padding-top:8px;">${body}</table>`
  );
}

/**
 * The one thing to press.
 *
 * A table with a background colour rather than a styled <a> on its own: if the
 * padding is dropped the reader still sees a coloured, labelled link. The raw
 * address goes underneath as its own paragraph — mail clients break long links
 * across lines and somebody has to be able to copy it.
 */
function button(label, url) {
  return cell(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="${ACCENT}" style="border-radius:6px;background-color:${ACCENT};">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 28px;font:bold 15px/1 ${FONT};color:#ffffff;background-color:${ACCENT};text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
</td></tr></table>`,
    "8px 28px 20px"
  );
}

// --- the skeleton -----------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.title    - <title>, and the inbox preview line
 * @param {string} options.heading  - the one sentence the message is about
 * @param {string[]} options.blocks - built by the helpers above
 * @param {"plain"|"alert"} [options.tone] - colours the heading
 * @param {boolean} [options.noindex] - for the pages; harmless in a mail
 */
function render({ title, heading, blocks, tone = "plain", noindex = false }) {
  const headingColor = tone === "alert" ? ALERT : INK;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">${
    noindex ? '\n<meta name="robots" content="noindex">' : ""
  }
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BACKDROP};color:${INK};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BACKDROP};">${escapeHtml(title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BACKDROP};">
<tr><td align="center" style="padding:32px 16px;background-color:${BACKDROP};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:${PAPER};border:1px solid ${LINE};border-radius:10px;">
<tr><td style="padding:26px 28px 4px;background-color:${PAPER};">
<div style="font:bold 12px/1 ${FONT};color:${MUTED};letter-spacing:.14em;">SITEY.MY</div>
</td></tr>
<tr><td style="padding:12px 28px 16px;background-color:${PAPER};">
<h1 style="margin:0;font:bold 20px/1.35 ${FONT};color:${headingColor};">${escapeHtml(heading)}</h1>
</td></tr>
${blocks.join("\n")}
<tr><td style="padding:4px 28px 26px;background-color:${PAPER};">
<p style="margin:0;padding-top:16px;border-top:1px solid ${LINE};font:12px/1.6 ${FONT};color:${MUTED};">
Sent by sitey.my because you hold a subdomain there. This address is not read &mdash;
manage your subdomains at <a href="${DASHBOARD_URL}" style="color:${ACCENT};">sitey.my/dashboard</a>.
</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// --- the messages -----------------------------------------------------------

/**
 * "Your subdomains are up for renewal - one click keeps them."
 *
 * One mail covers every subdomain the same person has at the same point in the
 * countdown, and the single button renews all of them (services/expiry-job.js
 * for why, services/renewal-token.js for how).
 *
 * `daysLeft` is the soonest of them, which is the deadline that matters when
 * one button renews the lot. The exact date of each is in the list, so a
 * heading that says "in 4 days" over a record due in 14 is never the only
 * thing the reader is given.
 *
 * @param {{records: Array<{subdomain: string, domain: string, expiresAt: *}>,
 *          daysLeft: number, renewUrl: string}} info
 * @returns {{subject: string, html: string}}
 */
function renewalReminder({ records, daysLeft, renewUrl }) {
  const when = whenIn(daysLeft);
  const many = records.length > 1;
  const names = records.map((r) => `${r.subdomain}.${r.domain}`);

  const subject = many
    ? `${records.length} of your subdomains expire ${when}`
    : `${names[0]} expires ${when}`;

  return {
    subject,
    html: render({
      title: subject,
      heading: subject,
      blocks: [
        text(
          many
            ? `Subdomains on sitey.my are lent for three months at a time, so names nobody is using go back into the pool. These ${records.length} are due:`
            : "Subdomains on sitey.my are lent for three months at a time, so names nobody is using go back into the pool. This one is due:"
        ),
        list(
          records.map((record) => ({
            name: `${record.subdomain}.${record.domain}`,
            detail: `Expires ${formatDate(record.expiresAt)}`,
          }))
        ),
        text(
          many
            ? `One click keeps all ${records.length}. No sign-in, and the three months start again from today.`
            : "One click keeps it. No sign-in, and the three months start again from today."
        ),
        button(many ? `Keep all ${records.length}` : `Keep ${names[0]}`, renewUrl),
        text(`If the button does not work, open this link:<br>${escapeHtml(renewUrl)}`, {
          muted: true,
          breakAnywhere: true,
        }),
        text(
          many
            ? "If you no longer need some of them, renew anyway and delete those from your dashboard. Ignore this message and all of them are released when they expire."
            : "If you no longer need it, ignore this message and it is released when it expires.",
          { muted: true }
        ),
      ],
    }),
  };
}

/**
 * "Your address has not been answering." Not "we took it away".
 *
 * Nothing has been removed when this goes out and nothing will be on account
 * of it — reachability does not delete (services/validation.js). The mail
 * exists so that somebody who did not know their site was down finds out, and
 * the tone follows from that.
 *
 * @returns {{subject: string, html: string}}
 */
function unreachableNotice({ subdomain, domain, recordType, recordValue, days }) {
  const fqdn = `${subdomain}.${domain}`;
  const subject = `${fqdn} has not been loading for ${days} days`;

  return {
    subject,
    html: render({
      title: subject,
      heading: subject,
      tone: "alert",
      blocks: [
        text(
          `We open each subdomain once a day. <strong>${escapeHtml(fqdn)}</strong> has not answered for ${days} days in a row, so we thought you would want to know.`
        ),
        facts([
          ["Subdomain", fqdn],
          ["Record", recordType],
          ["Points at", recordValue],
        ]),
        text(
          "<strong>It is still yours.</strong> Nothing has been removed, and nothing will be removed because of this. If the target moved, point it somewhere else from your dashboard; if it is meant to be down, ignore this."
        ),
        button("Open your dashboard", DASHBOARD_URL),
        text("We will not send this again unless it comes back and then goes dark once more.", {
          muted: true,
        }),
      ],
    }),
  };
}

/**
 * The page behind the button, once the renewal has happened.
 *
 * `missing` is how many of the ids in the link no longer have a row. That is
 * not an error worth a red page — the usual cause is a subdomain the owner
 * deleted themselves after the mail went out — so it is one line under the
 * ones that were renewed.
 */
function renewalResultPage({ renewed, missing }) {
  const many = renewed.length > 1;
  const heading = many
    ? `${renewed.length} subdomains are yours for another three months`
    : `${renewed[0].fqdn} is yours for another three months`;

  const blocks = [
    list(
      renewed.map((record) => ({
        name: record.fqdn,
        detail: `Renewed until ${formatDate(record.expiresAt)}`,
      }))
    ),
    text("Nothing else to do. We will write again before they next come due."),
  ];

  if (missing > 0) {
    blocks.push(
      text(
        `${missing} other ${missing === 1 ? "subdomain" : "subdomains"} named in that link ${
          missing === 1 ? "is" : "are"
        } no longer here, so ${missing === 1 ? "it was" : "they were"} skipped.`,
        { muted: true }
      )
    );
  }

  blocks.push(button("Go to your dashboard", DASHBOARD_URL));

  return render({ title: heading, heading, blocks, noindex: true });
}

/**
 * The page behind a link that cannot be used: not signed by us, past its 30
 * days, or naming rows that have all gone.
 *
 * One function for the three because the reader's next step is the same in
 * every case — open the dashboard — and only the sentence above it differs.
 */
function renewalLinkPage(reason) {
  const pages = {
    expired: {
      heading: "This link has expired",
      body: "Renewal links stop working after 30 days. If the subdomain is still on your dashboard you can renew it there; if it has already been released, the name is free to claim again.",
    },
    invalid: {
      heading: "This link is not valid",
      body: "Check that the whole link was copied — some mail clients break long ones across lines. You can also renew from your dashboard.",
    },
    gone: {
      heading: "That is no longer here",
      body: "It may have already been released. You can claim the name again from your dashboard if it is still free.",
    },
  };
  const { heading, body } = pages[reason] || pages.invalid;

  return render({
    title: heading,
    heading,
    tone: "alert",
    blocks: [text(body), button("Go to your dashboard", DASHBOARD_URL)],
    noindex: true,
  });
}

module.exports = {
  renewalReminder,
  unreachableNotice,
  renewalResultPage,
  renewalLinkPage,
  // Exported for scripts/preview-emails.js and the tests, not for building
  // documents elsewhere: a fourth message would belong in this file too.
  render,
  formatDate,
  escapeHtml,
};
