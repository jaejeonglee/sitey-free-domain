import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The link in the renewal mail. It takes no session — a renewal that needs a
// sign-in is a renewal most people never finish — so the token is the entire
// authorisation and the page is the only thing standing behind it.
// ---------------------------------------------------------------------------

const fp = require2("fastify-plugin");
const dbPath = require2.resolve("../plugins/db.js");

/** rows the stub database will answer with, and the writes it received */
const db = { row: null, writes: [] };

require2.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  path: dbPath,
  loaded: true,
  children: [],
  paths: [],
  exports: fp(async function stubDb(fastify) {
    fastify.decorate("mysql", {
      execute: async (sql, params) => {
        db.writes.push({ sql, params });
        if (/FROM subdomains s/i.test(sql) && /WHERE s\.id = \?/.test(sql)) {
          return [db.row ? [db.row] : []];
        }
        return [[]];
      },
      getConnection: async () => ({
        execute: async () => [[]],
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      }),
    });
  }),
};

delete require2.cache[require2.resolve("../app.js")];
const { buildApp } = require2("../app.js");
const renewalToken = require2("../services/renewal-token.js");

describe("the renewal page", () => {
  let app;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete require2.cache[dbPath];
  });

  beforeEach(() => {
    db.row = { id: 42, subdomain: "demo", owner_type: "user", domain_name: "sitey.my" };
    db.writes = [];
  });

  it("renews on a plain GET, with no session", async () => {
    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign(42)}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("demo.sitey.my");

    const write = db.writes.find((w) => /UPDATE subdomains SET expires_at/.test(w.sql));
    expect(write, "the expiry should have moved").toBeTruthy();
    expect(write.params[1]).toBe(42);
  });

  it("clears the reminder stage so the next period starts fresh", async () => {
    await app.inject({ method: "GET", url: `/renew/${renewalToken.sign(42)}` });

    const write = db.writes.find((w) => /UPDATE subdomains SET expires_at/.test(w.sql));
    expect(write.sql).toMatch(/renewal_notice_stage = NULL/);
  });

  it("moves the expiry of the subdomain the token names and no other", async () => {
    await app.inject({ method: "GET", url: `/renew/${renewalToken.sign(42)}` });

    for (const write of db.writes) {
      // Every statement this route runs is scoped to one id.
      if (/UPDATE|DELETE/i.test(write.sql)) {
        expect(write.sql).toMatch(/WHERE id = \?/);
        expect(write.params[write.params.length - 1]).toBe(42);
      }
    }
  });

  it("writes nothing at all when the token is not valid", async () => {
    const res = await app.inject({ method: "GET", url: "/renew/not-a-real-token" });

    expect(res.statusCode).toBe(400);
    expect(db.writes.filter((w) => /UPDATE|DELETE/i.test(w.sql))).toHaveLength(0);
  });

  it("turns an expired link away", async () => {
    const old = renewalToken.sign(42, Date.now() - renewalToken.TTL_MS - 1000);

    const res = await app.inject({ method: "GET", url: `/renew/${old}` });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("expired");
    expect(db.writes.filter((w) => /UPDATE/i.test(w.sql))).toHaveLength(0);
  });

  it("says the same thing whether the row is gone or never existed", async () => {
    db.row = null;

    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign(999)}` });

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("no longer here");
  });

  it("keeps the page out of search results", async () => {
    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign(42)}` });

    expect(res.body).toContain('name="robots" content="noindex"');
  });
});
