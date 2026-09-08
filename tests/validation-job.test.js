import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The nightly job used to delete a subdomain on its second consecutive failed
// check. It runs daily, so two days of downtime cost the owner their address —
// with no warning that could reach an anonymous record at all. On 2026-09-08
// three of the owner's own subdomains were gone for exactly this reason.
//
// Reachability now never deletes. Deletion has one path and one path only:
// a renewal that was not done. The reasoning, in the order it matters:
//   1. one way to lose a record makes an incident traceable to one cause
//   2. renewal already sweeps up what nobody is using
//   3. deleting something alive costs far more than deleting it late
//
// vi.mock cannot reach modules pulled in through createRequire, so the fakes
// go into the require cache the way app.test.js stubs plugins/db.
// ---------------------------------------------------------------------------

function stub(specifier, exports) {
  const filename = require2.resolve(specifier);
  require2.cache[filename] = {
    id: filename,
    filename,
    path: filename,
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
  return filename;
}

const probeHost = vi.fn(async () => ({
  ok: false,
  status: null,
  check: "https",
  detail: "https failed: ECONNREFUSED",
}));
const deleteSubdomain = vi.fn(async () => {});
const sendUnreachableNoticeEmail = vi.fn(async () => ({ ok: true }));

const stubbed = [
  stub("../services/reachability.js", {
    DEAD_STATUSES: new Set([502, 503, 504]),
    isAliveStatus: (status) => ![502, 503, 504].includes(status),
    probeOrigin: vi.fn(),
    probeHost,
  }),
  stub("../services/subdomain.js", {
    createSubdomain: vi.fn(),
    updateSubdomain: vi.fn(),
    deleteSubdomain,
  }),
  stub("../services/email.js", {
    setLogger: () => {},
    sendUnreachableNoticeEmail,
    sendRenewalReminderEmail: vi.fn(async () => ({ ok: true })),
  }),
];

const savedEnv = {};
for (const key of ["BIND_DEV_MODE", "BIND_DB_PATH", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALERT_CHAT_ID"]) {
  savedEnv[key] = process.env[key];
}
// The job returns immediately in dev mode, so it has to be off to test at all.
process.env.BIND_DEV_MODE = "false";
process.env.BIND_DB_PATH = "/zones";
process.env.TELEGRAM_BOT_TOKEN = "test-tok";
process.env.TELEGRAM_ALERT_CHAT_ID = "123";
delete require2.cache[require2.resolve("../configs/index.js")];
delete require2.cache[require2.resolve("../services/validation.js")];

const { runPeriodicValidation } = require2("../services/validation.js");

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const filename of stubbed) delete require2.cache[filename];
  delete require2.cache[require2.resolve("../configs/index.js")];
  delete require2.cache[require2.resolve("../services/validation.js")];
});

/** a fastify stand-in that hands out one batch of rows and then none */
function fakeFastify(rows) {
  const writes = [];
  const lines = [];
  let served = false;
  return {
    writes,
    lines,
    mysql: {
      query: async () => {
        if (served) return [[]];
        served = true;
        return [rows];
      },
      execute: async (sql, params) => {
        writes.push({ sql, params });
        if (/FROM users/i.test(sql)) return [[{ email: "owner@example.com" }]];
        return [[]];
      },
    },
    log: {
      info: (obj) => lines.push(obj),
      warn: (obj) => lines.push(obj),
      error: () => {},
    },
  };
}

const record = (overrides = {}) => ({
  id: 7,
  subdomain: "demo",
  domain_name: "sitey.my",
  // .invalid never resolves (RFC 2606), so the old dns.resolve check called
  // this dead too — this test fails on the old code because a record was
  // deleted, not because a lookup happened to go the other way.
  record_value: "deleted-deployment.invalid",
  record_type: "CNAME",
  warning_count: 0,
  user_id: 3,
  owner_type: "user",
  last_warning_at: null,
  unreachable_notified_at: null,
  ...overrides,
});

/** the structured lines this job writes, in order */
const validateLines = (app) => app.lines.filter((l) => l && l.evt === "validate");

describe("an unreachable record is never deleted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not delete on the second consecutive failure", async () => {
    // The exact shape of the incident: one day already failed, today fails too.
    const app = fakeFastify([record({ warning_count: 1 })]);

    await runPeriodicValidation(app);

    expect(deleteSubdomain).not.toHaveBeenCalled();
  });

  it("does not delete after a fortnight of failures either", async () => {
    const app = fakeFastify([record({ warning_count: 30 })]);

    await runPeriodicValidation(app);

    expect(deleteSubdomain).not.toHaveBeenCalled();
  });

  it("counts the failed days instead", async () => {
    const app = fakeFastify([record({ warning_count: 4 })]);

    await runPeriodicValidation(app);

    expect(validateLines(app).pop()).toMatchObject({ result: "fail", failure: 5 });
    const write = app.writes.find((w) => /warning_count = \?/.test(w.sql));
    expect(write.params[0]).toBe(5);
  });

  it("records which check ran and what it saw", async () => {
    const app = fakeFastify([record()]);

    await runPeriodicValidation(app);

    expect(validateLines(app).pop()).toMatchObject({
      evt: "validate",
      subdomain: "demo",
      domain: "sitey.my",
      check: "https",
      detail: "https failed: ECONNREFUSED",
    });
  });

  it("presents the subdomain's own name to the target it dialled", async () => {
    const app = fakeFastify([record()]);

    await runPeriodicValidation(app);

    expect(probeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "deleted-deployment.invalid",
        hostname: "demo.sitey.my",
      })
    );
  });

  it("clears the streak when the site comes back", async () => {
    probeHost.mockResolvedValueOnce({
      ok: true,
      status: 404,
      check: "https",
      detail: "https answered 404",
    });
    const app = fakeFastify([
      record({ warning_count: 9, unreachable_notified_at: new Date() }),
    ]);

    await runPeriodicValidation(app);

    const write = app.writes.find((w) => /warning_count = 0/.test(w.sql));
    expect(write, "the streak should be reset").toBeTruthy();
    expect(write.sql).toMatch(/unreachable_notified_at = NULL/);
    expect(validateLines(app).pop()).toMatchObject({ result: "recovered", status: 404 });
  });
});

describe("telling the owner instead of taking the name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says nothing before the notice threshold", async () => {
    const app = fakeFastify([record({ warning_count: 2 })]);

    await runPeriodicValidation(app);

    expect(sendUnreachableNoticeEmail).not.toHaveBeenCalled();
  });

  it("says once that an agent record has nobody to write to", async () => {
    // Repeating that every night for months is noise. Its renewal settles it.
    const app = fakeFastify([
      record({ warning_count: 40, user_id: null, owner_type: "agent" }),
    ]);

    await runPeriodicValidation(app);

    expect(sendUnreachableNoticeEmail).not.toHaveBeenCalled();
    expect(validateLines(app).pop()).toMatchObject({ action: "no_address" });
  });

  it("writes the mail down but holds it while the flag is off", async () => {
    // Default is off until a test message has been seen to arrive.
    const app = fakeFastify([record({ warning_count: 13 })]);

    await runPeriodicValidation(app);

    expect(sendUnreachableNoticeEmail).not.toHaveBeenCalled();
    expect(validateLines(app).pop()).toMatchObject({
      action: "notice_withheld",
      failure: 14,
    });
  });
});
