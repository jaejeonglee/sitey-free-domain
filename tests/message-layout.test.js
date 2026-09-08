import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// What a person actually reads from us.
//
// These messages cannot be checked after the fact: by the time one is wrong it
// is in somebody's inbox, and mail is the last thing between an owner and a
// subdomain they lose. So the constraints are pinned here rather than left to
// whoever edits the templates next — most of them are invisible until they
// break, and they break in one client and not in the one you tested in.
// ---------------------------------------------------------------------------

const layout = require2("../services/message-layout.js");

const RECORD = (subdomain, iso) => ({
  subdomain,
  domain: "sitey.my",
  expiresAt: new Date(iso),
});

const reminder = (records, daysLeft = 14) =>
  layout.renewalReminder({
    records,
    daysLeft,
    renewUrl: "https://sitey.my/renew/MSwyLDM.abcd",
  });

const NOTICE = {
  subdomain: "demo",
  domain: "sitey.my",
  recordType: "CNAME",
  recordValue: "cname.vercel-dns.com",
  days: 14,
};

/** every document we send, so a rule can be checked against all of them at once */
const everything = () => [
  ["renewal reminder", reminder([RECORD("demo", "2026-12-01T00:00:00Z")]).html],
  [
    "grouped renewal reminder",
    reminder([RECORD("one", "2026-12-01T00:00:00Z"), RECORD("two", "2026-12-08T00:00:00Z")]).html,
  ],
  ["unreachable notice", layout.unreachableNotice(NOTICE).html],
  [
    "renewal result page",
    layout.renewalResultPage({
      renewed: [{ fqdn: "demo.sitey.my", expiresAt: new Date("2026-12-01T00:00:00Z") }],
      missing: 0,
    }),
  ],
  ["expired link page", layout.renewalLinkPage("expired")],
];

describe("what may be used in a message", () => {
  it("uses nothing a mail client throws away", () => {
    // A <style> block is dropped by Gmail's web client, an external sheet is
    // never fetched, and script never runs. Anything that depended on one of
    // them would look right here and arrive as unstyled text.
    for (const [name, html] of everything()) {
      expect(html, name).not.toMatch(/<style[\s>]/i);
      expect(html, name).not.toMatch(/<link[\s>]/i);
      expect(html, name).not.toMatch(/<script[\s>]/i);
      expect(html, name).not.toMatch(/@import|@media/i);
    }
  });

  it("says everything in text, never in a picture", () => {
    // Images are off by default in a lot of inboxes. A message whose words are
    // in a picture arrives blank in exactly the case that matters.
    for (const [name, html] of everything()) {
      expect(html, name).not.toMatch(/<img[\s>]/i);
      expect(html, name).not.toMatch(/background-image|url\(/i);
    }
  });

  it("lays out with tables, not with layout the client does not have", () => {
    for (const [name, html] of everything()) {
      expect(html, name).toContain('role="presentation"');
      expect(html, name).not.toMatch(/display:\s*(flex|grid)/i);
      expect(html, name).not.toMatch(/position:\s*(absolute|fixed)/i);
    }
  });

  it("asks for no font it would have to download", () => {
    for (const [name, html] of everything()) {
      expect(html, name).toContain("Arial, Helvetica, sans-serif");
      expect(html, name).not.toMatch(/fonts\.googleapis|@font-face/i);
    }
  });

  it("names a background beside every colour it sets", () => {
    // Dark mode inverts what it is given. An element with a text colour and no
    // background of its own ends up dark grey on near-black, which is the
    // failure where the message is there and cannot be read.
    for (const [name, html] of everything()) {
      expect(html, name).toContain('name="color-scheme"');
      const body = html.match(/<body[^>]*>/)[0];
      expect(body, name).toContain("background-color:");
      expect(body, name).toContain("color:#");
    }
  });

  it("escapes what it is given rather than trusting it", () => {
    // record_value is whatever the owner pointed the record at.
    const html = layout.unreachableNotice({
      ...NOTICE,
      recordValue: '"><script>alert(1)</script>',
    }).html;

    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the one skeleton", () => {
  it("is the same for the mails and for the page after the button", () => {
    // The point of the shared file: matching these to the web design later is
    // one edit, not four.
    for (const [name, html] of everything()) {
      expect(html, name).toContain(">SITEY.MY<");
      expect(html, name).toContain("Sent by sitey.my because you hold a subdomain there.");
      expect(html, name).toContain("sitey.my/dashboard");
    }
  });

  it("keeps the renewal pages out of search results", () => {
    expect(layout.renewalLinkPage("expired")).toContain('name="robots" content="noindex"');
    expect(
      layout.renewalResultPage({
        renewed: [{ fqdn: "demo.sitey.my", expiresAt: new Date() }],
        missing: 0,
      })
    ).toContain('name="robots" content="noindex"');
  });

  it("writes a date one way only, and in UTC", () => {
    // 22/09 and 09/22 are the same string to us and different days to the
    // reader. The month is spelled out for that reason, and the timezone is
    // the one the expiry itself is compared in.
    expect(layout.formatDate("2026-09-22T23:30:00Z")).toBe("22 September 2026");
    expect(layout.formatDate(new Date("2026-01-01T00:00:00Z"))).toBe("1 January 2026");
  });
});

describe("the renewal reminder", () => {
  it("names one subdomain when there is one", () => {
    const { subject, html } = reminder([RECORD("demo", "2026-12-01T00:00:00Z")], 14);

    expect(subject).toBe("demo.sitey.my expires in 14 days");
    expect(html).toContain("Keep demo.sitey.my");
    expect(html).toContain("Expires 1 December 2026");
  });

  it("counts them when there are several, and offers one button for the lot", () => {
    const { subject, html } = reminder(
      [
        RECORD("one", "2026-12-01T00:00:00Z"),
        RECORD("two", "2026-12-05T00:00:00Z"),
        RECORD("three", "2026-12-11T00:00:00Z"),
      ],
      4
    );

    expect(subject).toBe("3 of your subdomains expire in 4 days");
    expect(html).toContain("Keep all 3");
    // one button, not one per record
    expect(html.match(/href="https:\/\/sitey\.my\/renew\//g)).toHaveLength(1);
    for (const name of ["one.sitey.my", "two.sitey.my", "three.sitey.my"]) {
      expect(html).toContain(name);
    }
    // and each record's own date, since the heading can only carry the soonest
    expect(html).toContain("Expires 1 December 2026");
    expect(html).toContain("Expires 11 December 2026");
  });

  it("counts the last days in words", () => {
    const one = [RECORD("demo", "2026-12-01T00:00:00Z")];
    expect(reminder(one, 1).subject).toBe("demo.sitey.my expires tomorrow");
    expect(reminder(one, 0).subject).toBe("demo.sitey.my expires today");
    expect(reminder(one, -1).subject).toBe("demo.sitey.my expires today");
  });

  it("lets the raw link break mid-word", () => {
    // A token is one ~90-character word with nothing to break on, and a table
    // sized by its content stretches to fit it: without this the card grew
    // past its 560px and every line ran off the right edge. Found by rendering
    // it, not by reading it.
    const { html } = reminder([RECORD("demo", "2026-12-01T00:00:00Z")]);

    expect(
      html,
      "the paragraph holding the bare link is the one that has to break"
    ).toMatch(/<p[^>]*word-break:break-all[^>]*>If the button does not work/);
  });

  it("puts the link in the text as well as in the button", () => {
    // Mail clients break long links across lines and some strip the button
    // styling entirely. The address has to be copyable either way.
    const { html } = reminder([RECORD("demo", "2026-12-01T00:00:00Z")]);
    const bare = html.split("If the button does not work")[1];

    expect(bare).toContain("https://sitey.my/renew/MSwyLDM.abcd");
  });

  it("has a subject that says what it is without a tag in front of it", () => {
    // Was "[Sitey] x.sitey.my expires today". The sender address already says
    // who it is from; the bracket only ate the width a phone shows.
    for (const [, html] of everything()) expect(html).not.toContain("[Sitey]");
    expect(reminder([RECORD("demo", "2026-12-01T00:00:00Z")]).subject).not.toContain("[");
    expect(layout.unreachableNotice(NOTICE).subject).toBe(
      "demo.sitey.my has not been loading for 14 days"
    );
  });
});

describe("the page after the button", () => {
  it("lists what was renewed and until when", () => {
    const html = layout.renewalResultPage({
      renewed: [
        { fqdn: "one.sitey.my", expiresAt: new Date("2026-12-08T00:00:00Z") },
        { fqdn: "two.sitey.my", expiresAt: new Date("2026-12-08T00:00:00Z") },
      ],
      missing: 0,
    });

    expect(html).toContain("2 subdomains are yours for another three months");
    expect(html).toContain("Renewed until 8 December 2026");
    expect(html).not.toContain("skipped");
  });

  it("says plainly when part of the link had nothing left to renew", () => {
    const html = layout.renewalResultPage({
      renewed: [{ fqdn: "one.sitey.my", expiresAt: new Date("2026-12-08T00:00:00Z") }],
      missing: 2,
    });

    expect(html).toContain("2 other subdomains");
    expect(html).toContain("skipped");
  });
});
