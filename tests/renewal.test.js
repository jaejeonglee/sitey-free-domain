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

/** rows the stub database will answer with, keyed by id, and the writes it received */
const db = { rows: new Map(), writes: [] };

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
          const row = db.rows.get(params?.[0]);
          return [row ? [row] : []];
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

/** one row of the stub database, as a [key, value] pair for `new Map([...])` */
const row = (id, subdomain) => [
  id,
  { id, subdomain, owner_type: "user", domain_name: "sitey.my" },
];

describe("the renewal page", () => {
  let app;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    db.rows = new Map([row(42, "demo")]);
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
    db.rows = new Map();

    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign(999)}` });

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("no longer here");
  });

  it("keeps the page out of search results", async () => {
    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign(42)}` });

    expect(res.body).toContain('name="robots" content="noindex"');
  });
});

// ---------------------------------------------------------------------------
// One button for everything in the mail.
//
// The reminder is grouped per person now (services/expiry-job.js), so the link
// under it has to keep the whole list — otherwise somebody with 11 subdomains
// reads one mail, presses one button and still loses ten.
// ---------------------------------------------------------------------------
describe("a link that names several subdomains", () => {
  let app;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    db.rows = new Map([row(1, "one"), row(2, "two"), row(3, "three")]);
    db.writes = [];
  });

  const renewals = () =>
    db.writes.filter((w) => /UPDATE subdomains SET expires_at/.test(w.sql));

  it("renews every one of them from a single click", async () => {
    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign([1, 2, 3])}` });

    expect(res.statusCode).toBe(200);
    expect(renewals().map((w) => w.params[1])).toEqual([1, 2, 3]);
    for (const name of ["one.sitey.my", "two.sitey.my", "three.sitey.my"]) {
      expect(res.body).toContain(name);
    }
  });

  it("clears the reminder stage on all of them", async () => {
    await app.inject({ method: "GET", url: `/renew/${renewalToken.sign([1, 2, 3])}` });

    expect(renewals()).toHaveLength(3);
    for (const write of renewals()) expect(write.sql).toMatch(/renewal_notice_stage = NULL/);
  });

  it("keeps the ones that are still here when one has already gone", async () => {
    // All-or-nothing would mean a subdomain the owner released months ago
    // stops the other two from being renewed. Nothing ties these records
    // together, so there is no half-finished state to protect against.
    db.rows.delete(2);

    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign([1, 2, 3])}` });

    expect(res.statusCode).toBe(200);
    expect(renewals().map((w) => w.params[1])).toEqual([1, 3]);
  });

  it("says nothing is here only when none of them are", async () => {
    db.rows = new Map();

    const res = await app.inject({ method: "GET", url: `/renew/${renewalToken.sign([1, 2, 3])}` });

    expect(res.statusCode).toBe(404);
    expect(renewals()).toHaveLength(0);
  });

  afterAll(() => {
    // Last block in the file: the stub goes back so nothing after this test
    // run keeps a fake database in the require cache.
    delete require2.cache[dbPath];
  });

  it("touches no id the token does not name", async () => {
    db.rows.set(...row(99, "not-in-the-mail"));

    await app.inject({ method: "GET", url: `/renew/${renewalToken.sign([1, 2])}` });

    for (const write of db.writes) {
      if (/UPDATE|DELETE/i.test(write.sql)) {
        expect(write.sql).toMatch(/WHERE id = \?/);
        expect([1, 2]).toContain(write.params[write.params.length - 1]);
      }
    }
  });
});
