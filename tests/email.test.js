import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Mail went out through the Gmail API until 2026-09-08, which meant every
// renewal reminder and every "your site has gone dark" notice arrived from a
// personal account. Resend replaces the transport and nothing else: the four
// send functions, their templates and their log line are unchanged.
//
// Nothing here reaches the network. fetch is stubbed, so what is actually
// pinned is the request — where it goes, what authorises it, and what is in
// the body — because that is the part nobody can check by reading the logs
// afterwards.
//
// The key never appears in this file. The one below is made up, and the test
// that matters most is the one where there is no key at all: a send that
// cannot happen has to say so, not return quietly.
// ---------------------------------------------------------------------------

const FAKE_KEY = "not-a-real-key";

describe("email transport", () => {
  let emailMod;
  let configMod;
  let fetchMock;
  let logger;
  let savedEmail;

  const NOTICE = {
    subdomain: "demo",
    domain: "sitey.my",
    recordType: "CNAME",
    recordValue: "cname.vercel-dns.com",
    days: 14,
  };

  /** what Resend answers when it accepts a message */
  const accepted = (id = "6f9a1b2c-0000-4000-8000-abcdefabcdef") => ({
    ok: true,
    status: 200,
    json: async () => ({ id }),
  });

  beforeEach(() => {
    configMod = require2("../configs/index.js");
    emailMod = require2("../services/email.js");

    savedEmail = {
      provider: configMod.email.provider,
      from: configMod.email.from,
      apiKey: configMod.email.resend.apiKey,
    };
    configMod.email.resend.apiKey = FAKE_KEY;

    fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal("fetch", fetchMock);

    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    emailMod.setLogger(logger);
  });

  afterEach(() => {
    configMod.email.provider = savedEmail.provider;
    configMod.email.from = savedEmail.from;
    configMod.email.resend.apiKey = savedEmail.apiKey;
    vi.unstubAllGlobals();
  });

  it("sends through Resend without being told to", () => {
    // The default is the new path; Gmail is a way back, not the way.
    expect(savedEmail.provider).toBe("resend");
  });

  it("comes from an address on a domain we own", () => {
    expect(savedEmail.from).toBe("noreply@sitey.my");
  });

  it("posts the message to Resend and says it went", async () => {
    const result = await emailMod.sendUnreachableNoticeEmail("owner@example.com", NOTICE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.from).toBe("noreply@sitey.my");
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.subject).toContain("demo.sitey.my");
    expect(body.html).toContain("demo.sitey.my");

    expect(result.ok).toBe(true);
    expect(result.id).toBe("6f9a1b2c-0000-4000-8000-abcdefabcdef");
  });

  it("writes down the message id, and the recipient only as a hash", async () => {
    await emailMod.sendRenewalReminderEmail("owner@example.com", {
      subdomain: "demo",
      domain: "sitey.my",
      daysLeft: 3,
      expiresAt: new Date("2026-10-01T00:00:00Z"),
      renewUrl: "https://sitey.my/renew/tok",
    });

    const [line] = logger.info.mock.calls[0];
    expect(line).toMatchObject({
      evt: "email",
      kind: "renewal_reminder",
      provider: "resend",
      fqdn: "demo.sitey.my",
      ok: true,
      id: "6f9a1b2c-0000-4000-8000-abcdefabcdef",
    });
    expect(line.to).toBe(emailMod.hashRecipient("owner@example.com"));
    expect(JSON.stringify(line)).not.toContain("owner@example.com");
  });

  it("never puts the key in the log line", async () => {
    await emailMod.sendUnreachableNoticeEmail("owner@example.com", NOTICE);

    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(FAKE_KEY);
  });

  it("keeps the reason Resend gave for refusing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        name: "validation_error",
        message: "The sitey.my domain is not verified.",
      }),
    });

    const result = await emailMod.sendUnreachableNoticeEmail("owner@example.com", NOTICE);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("The sitey.my domain is not verified.");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ ok: false, provider: "resend" });
  });

  it("still fails on a refusal with no readable body", async () => {
    // A body that will not parse must not read as success.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });

    const result = await emailMod.sendUnreachableNoticeEmail("owner@example.com", NOTICE);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Resend API 502");
  });

  it("says the key is missing instead of passing over it", async () => {
    // The job that calls this runs whether or not mail is configured, so a
    // missing key that returned ok would look exactly like a delivered mail —
    // and deletion is switched on off the back of "the reminders arrived".
    configMod.email.resend.apiKey = undefined;

    const result = await emailMod.sendUnreachableNoticeEmail("owner@example.com", NOTICE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("RESEND_API_KEY");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("refuses a provider name it does not know rather than guessing", async () => {
    configMod.email.provider = "resnd";

    const result = await emailMod.sendUnreachableNoticeEmail("owner@example.com", NOTICE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("EMAIL_PROVIDER");
  });

  it("goes back to Gmail when told to, and not through Resend", async () => {
    // The way back is still wired up. There are no Gmail credentials in the
    // test environment, so it gets as far as saying which ones are missing —
    // which is enough to show the switch reaches the other transport.
    configMod.email.provider = "gmail";

    const result = await emailMod.sendUnreachableNoticeEmail("owner@example.com", NOTICE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("GMAIL_REFRESH_TOKEN");
    expect(logger.error.mock.calls[0][0]).toMatchObject({ provider: "gmail" });
  });
});
