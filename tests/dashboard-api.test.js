import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// What the new dashboard (2026-11-11) asks of the server:
//   A-1  GET /api/subdomains carries the nightly verdict — warning_count and
//        last_checked_at — and /api/auth/me carries the account's limit
//   A-2  POST /api/subdomains/:subdomain/check — «지금 확인»
//   A-3  PUT  /api/subdomains/:subdomain accepts recordType (the zone side is
//        tests/record-type-change.test.js, against a real zone file)
//
// The app is the real one; the database is a stub keyed on SQL, and the probe
// is stood in for in the require cache so nothing leaves this machine.
// ---------------------------------------------------------------------------

const fp = require2("fastify-plugin");
const dbPath = require2.resolve("../plugins/db.js");
const validationPath = require2.resolve("../services/validation.js");
const subdomainPath = require2.resolve("../services/subdomain.js");

const db = { rows: [], writes: [], session: true };

require2.cache[dbPath] = {
  id: dbPath, filename: dbPath, path: dbPath, loaded: true, children: [], paths: [],
  exports: fp(async function stubDb(fastify) {
    fastify.decorate("mysql", {
      execute: async (sql, params = []) => {
        db.writes.push({ sql, params });
        if (/FROM user_sessions/.test(sql)) return [db.session ? [{ 1: 1 }] : []];
        if (/FROM managed_domains/.test(sql)) return [[{ id: 1, domain_name: "sitey.my" }]];
        if (/SELECT subdomain_limit FROM users/.test(sql)) return [[{ subdomain_limit: null }]];
        if (/FROM users WHERE id/.test(sql)) return [[{ id: 7, email: "a@example.com", name: "A", picture: null }]];
        if (/^SELECT s\.id, s\.subdomain, m\.domain_name/.test(sql)) {
          return [db.rows.filter((r) => r.user_id === params[0])];
        }
        if (/^SELECT id, record_type, record_value, warning_count, last_checked_at FROM subdomains/.test(sql)) {
          const [sub, , userId] = params;
          return [db.rows.filter((r) => r.subdomain === sub && r.user_id === userId)];
        }
        if (/^SELECT s\.id, s\.record_type FROM subdomains s WHERE s\.subdomain = \?/.test(sql)) {
          const [sub, , userId] = params;
          return [db.rows.filter((r) => r.subdomain === sub && r.user_id === userId)];
        }
        if (/^SELECT warning_count, last_checked_at FROM subdomains WHERE id = \?/.test(sql)) {
          const row = db.rows.find((r) => r.id === params[0]);
          return [[{ warning_count: row.warning_count, last_checked_at: row.last_checked_at }]];
        }
        if (/^UPDATE subdomains SET warning_count = 0/.test(sql)) {
          const row = db.rows.find((r) => r.id === params[0] && r.user_id === params[1]);
          if (row) Object.assign(row, { warning_count: 0, last_checked_at: new Date("2026-11-11T04:00:00Z") });
          return [{ affectedRows: row ? 1 : 0 }];
        }
        if (/^UPDATE subdomains SET last_checked_at = NOW\(\)/.test(sql)) {
          const row = db.rows.find((r) => r.id === params[0] && r.user_id === params[1]);
          if (row) row.last_checked_at = new Date("2026-11-11T04:00:00Z");
          return [{ affectedRows: row ? 1 : 0 }];
        }
        if (/FROM blocklist/.test(sql)) return [[]];
        if (/FROM redirect_hits/.test(sql)) return [[]];
        if (/FROM credit_entries/.test(sql)) return [[{ total: 0 }]];
        return [[]];
      },
      getConnection: async () => ({
        execute: async () => [[]],
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
      }),
    });
  }),
};

// The probe: the real module with probeRecord replaced, so the route asks
// this instead of the network.
const probe = { ok: true, calls: [] };
const realValidation = require2("../services/validation.js");
require2.cache[validationPath].exports = {
  ...realValidation,
  probeRecord: async (...args) => {
    probe.calls.push(args);
    return probe.ok
      ? { ok: true, check: "https", status: 200, detail: "https answered 200" }
      : { ok: false, check: "http", status: null, detail: "https failed: ECONNREFUSED" };
  },
  noteReachability: async () => ({ ok: true, check: "https", status: 200, detail: "ok", note: null }),
};

// updateSubdomain is the zone write — its own test drives the real one. Here
// only what the route hands it matters.
const updates = [];
const realSubdomain = require2("../services/subdomain.js");
require2.cache[subdomainPath].exports = {
  ...realSubdomain,
  updateSubdomain: async (_fastify, params) => {
    updates.push(params);
    if (params.recordType === "CNAME" && params.subdomain === "hastxt") {
      throw Object.assign(new Error("This name holds a TXT record of its own…"), {
        statusCode: 409, code: "CNAME_CANNOT_HOLD_TXT",
      });
    }
  },
};

for (const m of ["../routes/domain.js", "../routes/index.js", "../app.js"]) {
  delete require2.cache[require2.resolve(m)];
}
const { buildApp } = require2("../app.js");

const ROWS = () => [
  { id: 1, user_id: 7, subdomain: "jay", domain_name: "sitey.my", record_type: "CNAME", record_value: "cname.vercel-dns.com",
    expires_at: new Date("2026-12-07T00:00:00Z"), warning_count: 0, last_checked_at: new Date("2026-11-10T15:00:00Z"),
    host_prefix: null, txt_value: null },
  { id: 2, user_id: 7, subdomain: "portfolio", domain_name: "sitey.my", record_type: "A", record_value: "203.0.113.10",
    expires_at: new Date("2027-01-30T00:00:00Z"), warning_count: 3, last_checked_at: new Date("2026-11-10T15:00:00Z"),
    host_prefix: null, txt_value: null },
  { id: 3, user_id: 7, subdomain: "fresh", domain_name: "sitey.my", record_type: "A", record_value: "203.0.113.11",
    expires_at: new Date("2027-02-01T00:00:00Z"), warning_count: 0, last_checked_at: null,
    host_prefix: null, txt_value: null },
  { id: 4, user_id: 8, subdomain: "someoneelse", domain_name: "sitey.my", record_type: "A", record_value: "203.0.113.12",
    expires_at: new Date("2027-02-01T00:00:00Z"), warning_count: 0, last_checked_at: null,
    host_prefix: null, txt_value: null },
  { id: 5, user_id: 7, subdomain: "hastxt", domain_name: "sitey.my", record_type: "A", record_value: "203.0.113.13",
    expires_at: new Date("2027-02-01T00:00:00Z"), warning_count: 0, last_checked_at: null,
    host_prefix: null, txt_value: null },
];

let app;
let cookie;
let otherCookie;

beforeAll(async () => {
  app = buildApp({ logger: false });
  await app.ready();
  cookie = `__Host-sitey_token=${app.jwt.sign({ id: 7, email: "a@example.com", sessionId: "s7" })}`;
  otherCookie = `__Host-sitey_token=${app.jwt.sign({ id: 9, email: "b@example.com", sessionId: "s9" })}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.rows = ROWS();
  db.writes = [];
  db.session = true;
  probe.ok = true;
  probe.calls = [];
  updates.length = 0;
});

const writesMatching = (re) => db.writes.filter((w) => re.test(w.sql));

describe("A-1 — the list carries the nightly verdict", () => {
  it("adds warning_count and last_checked_at to each item, and keeps the array", async () => {
    const res = await app.inject({ method: "GET", url: "/api/subdomains", headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(Array.isArray(items)).toBe(true);
    const byName = Object.fromEntries(items.map((i) => [i.subdomain, i]));
    expect(byName.jay.warning_count).toBe(0);
    expect(byName.jay.last_checked_at).toBe("2026-11-10T15:00:00.000Z");
    expect(byName.portfolio.warning_count).toBe(3);
    // never checked yet — null, which the screen calls «확인 전»
    expect(byName.fresh.last_checked_at).toBeNull();
    expect(byName.someoneelse).toBeUndefined();
  });

  it("puts the account's limit on /api/auth/me", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 7, subdomainLimit: 5 });
    expect(typeof res.json().subdomainLimitEnforced).toBe("boolean");
  });
});

describe("A-2 — «지금 확인»", () => {
  const check = (sub, headers = { cookie }) =>
    app.inject({ method: "POST", url: `/api/subdomains/${sub}/check`, headers, payload: { domain: "sitey.my" } });

  it("an answer clears the run of failed days, the way the nightly job does", async () => {
    const res = await check("portfolio");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reachable: true, warning_count: 0, note: null });
    expect(res.json().last_checked_at).toBe("2026-11-11T04:00:00.000Z");
    const [reset] = writesMatching(/^UPDATE subdomains SET warning_count = 0/);
    expect(reset.sql).toContain("unreachable_notified_at = NULL");
    expect(reset.sql).toContain("last_warning_at = NULL");
    // the probe was asked the nightly question: the record's own name in Host/SNI
    expect(probe.calls[0]).toEqual(["A", "203.0.113.10", { fqdn: "portfolio.sitey.my" }]);
  });

  it("no answer on a record already down: the check time moves, the count does not", async () => {
    probe.ok = false;
    const res = await check("portfolio");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reachable: false, warning_count: 3 });
    expect(res.json().note).toMatch(/ECONNREFUSED/);
    expect(writesMatching(/^UPDATE subdomains SET warning_count/)).toHaveLength(0);
    expect(writesMatching(/^UPDATE subdomains SET last_checked_at = NOW\(\)/)).toHaveLength(1);
  });

  it("no answer on a record counted healthy: nothing is written — the night decides", async () => {
    probe.ok = false;
    const res = await check("jay");

    expect(res.json()).toMatchObject({ reachable: false, warning_count: 0 });
    expect(res.json().last_checked_at).toBe("2026-11-10T15:00:00.000Z");
    expect(writesMatching(/^UPDATE subdomains/)).toHaveLength(0);
  });

  it("someone else's address is the same 404 as one that does not exist", async () => {
    const res = await check("someoneelse");

    expect(res.statusCode).toBe(404);
    expect(probe.calls).toHaveLength(0);
    expect(writesMatching(/^UPDATE/)).toHaveLength(0);
  });

  it("needs a session", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/subdomains/jay/check", payload: { domain: "sitey.my" },
    });
    expect(res.statusCode).toBe(401);
    expect(probe.calls).toHaveLength(0);
  });

  it("is limited per person — six a minute, the seventh is 429", async () => {
    // another account so the earlier tests' presses do not count here
    const codes = [];
    for (let i = 0; i < 7; i += 1) {
      codes.push((await check("jay", { cookie: otherCookie })).statusCode);
    }
    // user 9 owns nothing, so the six allowed are 404s; the seventh never gets that far
    expect(codes.slice(0, 6)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(codes[6]).toBe(429);
    // and the limit is the person's, not the address's: user 7 from the same IP still gets through
    expect((await check("jay")).statusCode).toBe(200);
  });
});

describe("A-3 — PUT takes recordType", () => {
  const put = (sub, payload) =>
    app.inject({ method: "PUT", url: `/api/subdomains/${sub}`, headers: { cookie }, payload });

  it("hands the requested type to updateSubdomain, value checked as that type", async () => {
    const res = await put("portfolio", { domain: "sitey.my", value: "mysite.netlify.app", recordType: "cname" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, recordType: "CNAME" });
    expect(updates[0]).toMatchObject({ recordType: "CNAME", recordValue: "mysite.netlify.app", subdomain: "portfolio" });
  });

  it("without recordType keeps the record's own type", async () => {
    await put("portfolio", { domain: "sitey.my", value: "198.51.100.1" });
    expect(updates[0]).toMatchObject({ recordType: "A", recordValue: "198.51.100.1" });
  });

  it("checks the value against the new type before anything is written", async () => {
    const res = await put("portfolio", { domain: "sitey.my", value: "https://mysite.netlify.app", recordType: "CNAME" });
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("runs a new REDIRECT target through the redirect rules", async () => {
    const res = await put("portfolio", { domain: "sitey.my", value: "http://example.com", recordType: "REDIRECT" });
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);

    const loop = await put("portfolio", { domain: "sitey.my", value: "https://other.sitey.my/x", recordType: "REDIRECT" });
    expect(loop.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("refuses a type it does not know", async () => {
    const res = await put("portfolio", { domain: "sitey.my", value: "x", recordType: "MX" });
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("passes the TXT refusal through as 409 with its code", async () => {
    const res = await put("hastxt", { domain: "sitey.my", value: "mysite.netlify.app", recordType: "CNAME" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CNAME_CANNOT_HOLD_TXT");
  });

  it("someone else's address is a 404", async () => {
    const res = await put("someoneelse", { domain: "sitey.my", value: "mysite.netlify.app", recordType: "CNAME" });
    expect(res.statusCode).toBe(404);
    expect(updates).toHaveLength(0);
  });
});
