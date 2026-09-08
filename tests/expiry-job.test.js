import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The nightly pass. Both halves are off by default and that is the point of
// most of this file: whether these mails are delivered has never been recorded
// anywhere, so nothing may be removed until one has been watched arriving.
//
// Fakes go into the require cache — vi.mock cannot reach through createRequire.
// ---------------------------------------------------------------------------

function stub(specifier, exports) {
  const filename = require2.resolve(specifier);
  require2.cache[filename] = {
    id: filename, filename, path: filename, loaded: true,
    children: [], paths: [], exports,
  };
  return filename;
}

const deleteSubdomain = vi.fn(async () => {});
const sendRenewalReminderEmail = vi.fn(async () => ({ ok: true }));

const stubbed = [
  stub("../services/subdomain.js", {
    createSubdomain: vi.fn(), updateSubdomain: vi.fn(), deleteSubdomain,
  }),
  stub("../services/email.js", {
    setLogger: () => {},
    hashRecipient: () => "hash",
    sendUnreachableNoticeEmail: vi.fn(async () => ({ ok: true })),
    sendRenewalReminderEmail,
  }),
];

const savedEnv = {};
const ENV = ["BIND_DEV_MODE", "BIND_DB_PATH", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALERT_CHAT_ID",
             "RENEWAL_REMINDERS_ENABLED", "EXPIRY_DELETION_ENABLED"];
for (const key of ENV) savedEnv[key] = process.env[key];
process.env.BIND_DEV_MODE = "false";
process.env.BIND_DB_PATH = "/zones";
process.env.TELEGRAM_BOT_TOKEN = "test-tok";
process.env.TELEGRAM_ALERT_CHAT_ID = "123";

/** reload configs + the job with whatever the env now says */
function loadJob() {
  delete require2.cache[require2.resolve("../configs/index.js")];
  delete require2.cache[require2.resolve("../services/expiry-job.js")];
  delete require2.cache[require2.resolve("../services/expiry.js")];
  delete require2.cache[require2.resolve("../services/renewal-token.js")];
  return require2("../services/expiry-job.js");
}

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const filename of stubbed) delete require2.cache[filename];
  loadJob();
});

function fakeFastify(rows) {
  const writes = [];
  const lines = [];
  return {
    writes,
    lines,
    mysql: {
      query: async (sql) => [/expires_at < NOW\(\)/.test(sql) ? rows.expired || [] : rows.due || []],
      execute: async (sql, params) => {
        writes.push({ sql, params });
        return [[]];
      },
    },
    log: {
      info: (obj) => lines.push(obj),
      warn: (obj) => lines.push(obj),
      error: (obj) => lines.push(obj),
    },
  };
}

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const dueRow = (overrides = {}) => ({
  id: 5,
  subdomain: "demo",
  domain_name: "sitey.my",
  email: "owner@example.com",
  expires_at: inDays(14),
  renewal_notice_stage: null,
  ...overrides,
});

const expiredRow = (overrides = {}) => ({
  id: 9,
  subdomain: "stale",
  domain_name: "sitey.my",
  record_type: "CNAME",
  record_value: "gone.invalid",
  owner_type: "agent",
  expires_at: inDays(-2),
  ...overrides,
});

describe("with the flags at their defaults", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends no reminder", async () => {
    delete process.env.RENEWAL_REMINDERS_ENABLED;
    const { sendRenewalReminders } = loadJob();
    const app = fakeFastify({ due: [dueRow()] });

    await sendRenewalReminders(app);

    expect(sendRenewalReminderEmail).not.toHaveBeenCalled();
    expect(app.lines.pop()).toMatchObject({ evt: "renewal_reminder", action: "withheld", stage: 14 });
  });

  it("removes nothing, however far past due", async () => {
    delete process.env.EXPIRY_DELETION_ENABLED;
    const { removeExpired } = loadJob();
    const app = fakeFastify({ expired: [expiredRow({ expires_at: inDays(-90) })] });

    const result = await removeExpired(app);

    expect(deleteSubdomain).not.toHaveBeenCalled();
    expect(result).toEqual({ due: 1, removed: 0 });
    expect(app.lines.pop()).toMatchObject({ evt: "expire", action: "withheld" });
  });
});

describe("once reminders are switched on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RENEWAL_REMINDERS_ENABLED = "true";
  });

  it("writes to the owner and records which reminder went", async () => {
    const { sendRenewalReminders } = loadJob();
    const app = fakeFastify({ due: [dueRow()] });

    await sendRenewalReminders(app);

    expect(sendRenewalReminderEmail).toHaveBeenCalledOnce();
    const [to, info] = sendRenewalReminderEmail.mock.calls[0];
    expect(to).toBe("owner@example.com");
    expect(info.renewUrl).toMatch(/^https:\/\/sitey\.my\/renew\/[\w-]+\.[\w-]+$/);

    const write = app.writes.find((w) => /renewal_notice_stage = \?/.test(w.sql));
    expect(write.params).toEqual([14, 5]);
  });

  it("does not repeat a reminder it already sent", async () => {
    const { sendRenewalReminders } = loadJob();
    const app = fakeFastify({ due: [dueRow({ renewal_notice_stage: 14 })] });

    await sendRenewalReminders(app);

    expect(sendRenewalReminderEmail).not.toHaveBeenCalled();
  });

  it("moves on to the next reminder as the date closes in", async () => {
    const { sendRenewalReminders } = loadJob();
    const app = fakeFastify({ due: [dueRow({ expires_at: inDays(2), renewal_notice_stage: 14 })] });

    await sendRenewalReminders(app);

    expect(sendRenewalReminderEmail).toHaveBeenCalledOnce();
    expect(app.writes.find((w) => /renewal_notice_stage = \?/.test(w.sql)).params).toEqual([3, 5]);
  });

  it("leaves the stage alone when the send failed, so tomorrow tries again", async () => {
    sendRenewalReminderEmail.mockResolvedValueOnce({ ok: false, error: "quota exceeded" });
    const { sendRenewalReminders } = loadJob();
    const app = fakeFastify({ due: [dueRow()] });

    await sendRenewalReminders(app);

    expect(app.writes.find((w) => /renewal_notice_stage = \?/.test(w.sql))).toBeUndefined();
    expect(app.lines.pop()).toMatchObject({ action: "failed", error: "quota exceeded" });
  });
});

describe("once deletion is switched on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EXPIRY_DELETION_ENABLED = "true";
  });

  it("removes what was not renewed", async () => {
    const { removeExpired } = loadJob();
    const app = fakeFastify({ expired: [expiredRow()] });

    const result = await removeExpired(app);

    expect(deleteSubdomain).toHaveBeenCalledWith(app, {
      recordId: 9, subdomain: "stale", domain: "sitey.my", recordType: "CNAME",
    });
    expect(result).toEqual({ due: 1, removed: 1 });
  });

  it("only ever looks at rows that carry a date", async () => {
    // A NULL expires_at means never expires — that is what a row the backfill
    // missed looks like, and it must not be swept up.
    const { removeExpired } = loadJob();
    const seen = [];
    const app = fakeFastify({ expired: [] });
    app.mysql.query = async (sql) => {
      seen.push(sql);
      return [[]];
    };

    await removeExpired(app);

    expect(seen[0]).toMatch(/expires_at IS NOT NULL/);
    expect(seen[0]).toMatch(/expires_at < NOW\(\)/);
  });

  it("keeps going when one record fails to come out", async () => {
    deleteSubdomain.mockRejectedValueOnce(new Error("zone reload failed"));
    const { removeExpired } = loadJob();
    const app = fakeFastify({ expired: [expiredRow(), expiredRow({ id: 10, subdomain: "other" })] });

    const result = await removeExpired(app);

    expect(result).toEqual({ due: 2, removed: 1 });
  });
});
