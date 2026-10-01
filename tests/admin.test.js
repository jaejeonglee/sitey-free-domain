import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const Fastify = require2("fastify");
const config = require2("../configs/index.js");
const { renewalOutlook } = require2("../services/admin-stats.js");

// ---------------------------------------------------------------------------
// /admin answers ADMIN_EMAILS and nobody else — and "nobody else" gets the
// same 404 page an unknown URL gets, so the page does not admit it exists.
// ---------------------------------------------------------------------------

const ADMIN = { id: 1, email: "ljj5256@gmail.com" };
const STRANGER = { id: 2, email: "someone@example.com" };
const USERS = { 1: ADMIN, 2: STRANGER };

function execute(sql, params = []) {
  if (sql.includes("FROM user_sessions")) return [[{ 1: 1 }]];
  if (sql.includes("FROM users WHERE id")) return [[USERS[params[0]]].filter(Boolean)];
  if (sql.includes("COUNT(*) AS total")) {
    return [[{ total: 3, d30: 1, d7: 1, accountless: 1, accountless30: 1, accountless7: 0 }]];
  }
  return [[]];
}

let app;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.decorate("mysql", { execute: vi.fn(async (sql, params) => execute(sql, params)) });
  app.register(require2("../plugins/auth.js"));
  app.register(require2("../routes/pages.js"));
  app.register(require2("../routes/admin.js"));
  app.setNotFoundHandler((request, reply) => app.sendPageNotFound(reply));
  await app.ready();
});

afterAll(() => app.close());

const cookieFor = (user) =>
  `sitey_token=${app.jwt.sign({ id: user.id, email: user.email, sessionId: "s1" })}`;

describe("who may see /admin", () => {
  it("is on the list by default — Jay's account", () => {
    expect(config.admin.emails).toContain(ADMIN.email);
  });

  for (const url of ["/admin", "/admin/api/stats"]) {
    it(`${url}: signed out is the same 404 as a page that does not exist`, async () => {
      const res = await app.inject({ method: "GET", url });
      const unknown = await app.inject({ method: "GET", url: "/no-such-page" });

      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toBe(unknown.headers["content-type"]);
      expect(res.body).toBe(unknown.body);
    });

    it(`${url}: signed in but not an admin is 404`, async () => {
      const res = await app.inject({ method: "GET", url, headers: { cookie: cookieFor(STRANGER) } });
      expect(res.statusCode).toBe(404);
    });

    it(`${url}: a forged token is 404`, async () => {
      const res = await app.inject({ method: "GET", url, headers: { cookie: "sitey_token=not.a.jwt" } });
      expect(res.statusCode).toBe(404);
    });
  }

  it("the admin gets the page, not indexed", async () => {
    const res = await app.inject({ method: "GET", url: "/admin", headers: { cookie: cookieFor(ADMIN) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="template-admin"');
    expect(res.body).toContain('content="noindex, follow"');
  });

  it("the admin gets every panel the page draws", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/stats",
      headers: { cookie: cookieFor(ADMIN) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const key of ["summary", "daily", "recordTypes", "recent", "renewal", "unreachable", "topRedirects"]) {
      expect(body, key).toHaveProperty(key);
    }
    expect(body.summary.users).toEqual({ total: 3, last30: 1 });
    expect(body.summary.subdomains).toHaveProperty("accountlessLast7");
    expect(body.daily).toHaveLength(30);
    expect(body.renewal).toHaveProperty("earliestNoticeAt");
  });
});

// ---------------------------------------------------------------------------
// The renewal panel says who will get a mail. services/expiry-job.js reaches
// its rows through `JOIN users`, so a record without an account is never
// mailed — counting by expires_at alone overstates the list.
// ---------------------------------------------------------------------------
describe("renewal outlook", () => {
  const now = new Date("2026-10-01T03:00:00Z");
  const inDays = (d) => new Date(now.getTime() + d * 864e5);
  const base = { domain_name: "sitey.my", renewal_notice_stage: null };

  it("lists only records that have an account, and counts the rest apart", () => {
    const outlook = renewalOutlook(
      [
        { ...base, subdomain: "mine", expires_at: inDays(5), user_id: 1, email: "a@example.com" },
        { ...base, subdomain: "agentmade", expires_at: inDays(4), user_id: null, email: null },
        { ...base, subdomain: "later", expires_at: inDays(40), user_id: 1, email: "a@example.com" },
      ],
      now
    );

    expect(outlook.items.map((item) => item.name)).toEqual(["mine.sitey.my"]);
    expect(outlook.count).toBe(1);
    expect(outlook.accountlessInWindow).toBe(1);
  });

  it("takes the earliest mail from accounts only — an accountless record due today does not count", () => {
    const outlook = renewalOutlook(
      [
        { ...base, subdomain: "anon", expires_at: inDays(2), user_id: null, email: null },
        // The 14-day notice for this one opens in 6 days.
        { ...base, subdomain: "mine", expires_at: inDays(20), user_id: 1, email: "a@example.com" },
      ],
      now
    );

    expect(outlook.count).toBe(0);
    expect(outlook.earliestNoticeAt).toBe(inDays(6).toISOString());
  });

  it("an unsent notice whose day has passed goes at the next run, not in the past", () => {
    const outlook = renewalOutlook(
      [{ ...base, subdomain: "mine", expires_at: inDays(2), user_id: 1, email: "a@example.com", renewal_notice_stage: 14 }],
      now
    );
    // 14 was sent; 3 opened yesterday and has not gone yet.
    expect(outlook.earliestNoticeAt).toBe(now.toISOString());
  });
});
