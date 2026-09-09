import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// How many subdomains one account may hold.
//
// The switch is off by default and that is what most of this file is about:
// nobody has ever been refused a subdomain for holding too many, there is no
// evidence that anyone wants more than three, and a limit switched on before
// that evidence exists would cost real users for a demand we cannot show. So
// the default has to allow the request and write down the refusal it would
// have been — the log line is the deliverable, not the block.
//
// Fakes go into the require cache; vi.mock cannot reach through createRequire.
// ---------------------------------------------------------------------------

function stub(specifier, exports) {
  const filename = require2.resolve(specifier);
  require2.cache[filename] = {
    id: filename, filename, path: filename, loaded: true,
    children: [], paths: [], exports,
  };
  return filename;
}

const createSubdomain = vi.fn(async () => ({
  name: "demo.example.com",
  type: "A",
  expiresAt: new Date("2026-12-09T00:00:00Z"),
}));
const deleteSubdomain = vi.fn(async () => {});

const stubbed = [
  stub("../services/subdomain.js", {
    createSubdomain, updateSubdomain: vi.fn(), deleteSubdomain,
  }),
  // The real one makes an HTTP request to the record's target.
  stub("../services/validation.js", {
    validateRecord: vi.fn(async () => true),
    setLogger: () => {},
  }),
];

const savedEnv = {};
const ENV = ["SUBDOMAIN_LIMIT_ENFORCED", "SUBDOMAIN_LIMIT_DEFAULT", "X402_ENABLED"];
for (const key of ENV) savedEnv[key] = process.env[key];

const DOMAIN = "example.com";
const DOMAIN_ID = 1;
const USER_ID = 7;
const API_KEY = "styo_0123456789abcdef0123456789abcdef";

/** reload configs and everything that reads them, with whatever the env says */
function loadRoutes() {
  for (const spec of [
    "../configs/index.js",
    "../services/access-log.js",
    "../services/credits.js",
    "../services/quota.js",
    "../services/x402.js",
    "../routes/api-v1.js",
  ]) {
    const resolved = (() => { try { return require2.resolve(spec); } catch { return null; } })();
    if (resolved) delete require2.cache[resolved];
  }
  return require2("../routes/api-v1.js");
}

/**
 * @param held        how many subdomains the account already has
 * @param limitColumn users.subdomain_limit — null means "use the default"
 * @param noColumn    the migration has not been applied on this database yet
 * @param creditRows  bundles on the account, each with the day it lapses
 */
function buildHarness({ held = 0, limitColumn = null, noColumn = false, creditRows = [] } = {}) {
  const Fastify = require2("fastify");
  const apiV1Routes = loadRoutes();

  const lines = [];
  const owned = Array.from({ length: held }, (_, i) => ({
    subdomain: `held${i}`, domain: DOMAIN, type: "A", value: "1.2.3.4",
  }));

  const execute = vi.fn(async (sql, params = []) => {
    if (sql.includes("FROM api_keys ak JOIN users u")) {
      return [[{ key_id: 1, user_id: USER_ID, email: "a@example.com", name: "A" }]];
    }
    if (sql.startsWith("UPDATE api_keys")) return [[]];
    if (sql.includes("FROM managed_domains")) {
      return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    }
    if (sql.includes("subdomain_limit FROM users")) {
      if (noColumn) {
        throw Object.assign(new Error("Unknown column 'subdomain_limit' in 'field list'"), {
          code: "ER_BAD_FIELD_ERROR", errno: 1054,
        });
      }
      return [[{ subdomain_limit: limitColumn }]];
    }
    if (sql.includes("COUNT(*) AS held FROM subdomains")) return [[{ held }]];
    if (sql.includes("FROM credit_entries")) {
      // The fake honours the expiry the service asks for rather than assuming
      // it: a lapsed bundle is not in the total, which is the only thing the
      // end of a bundle does. tests/credits.test.js checks the query itself.
      const live = creditRows.filter((row) => !row.expiresAt || row.expiresAt > new Date());
      return [[{ total: live.reduce((sum, row) => sum + row.amountMicros, 0) }]];
    }
    if (sql.startsWith("SELECT id, record_type FROM subdomains")) {
      return [[{ id: 42, record_type: "A" }]];
    }
    if (sql.includes("FROM subdomains s JOIN managed_domains")) return [owned];
    if (sql.includes("FROM subdomain_txt_records")) return [[]];
    return [[]];
  });

  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute });
  // buildApp's logger is not in play here; the quota line is what we read.
  app.log.warn = (obj, msg) => lines.push(obj);
  app.log.info = (obj) => lines.push(obj);
  app.log.error = (obj) => lines.push(obj);
  app.register(apiV1Routes, { prefix: "/api/v1" });

  return { app, lines, execute };
}

function create(app) {
  return app.inject({
    method: "POST",
    url: "/api/v1/subdomains",
    headers: { authorization: `Bearer ${API_KEY}` },
    payload: { subdomain: "demo", domain: DOMAIN, type: "A", value: "1.2.3.4" },
  });
}

function quotaLine(lines) {
  return lines.filter((l) => l && l.evt === "quota").pop();
}

beforeEach(() => {
  createSubdomain.mockClear();
  deleteSubdomain.mockClear();
  delete process.env.SUBDOMAIN_LIMIT_ENFORCED;
  delete process.env.SUBDOMAIN_LIMIT_DEFAULT;
  delete process.env.X402_ENABLED;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const filename of stubbed) delete require2.cache[filename];
  loadRoutes();
});

// ---------------------------------------------------------------------------

describe("observe mode (the default)", () => {
  it("refuses nobody", async () => {
    const { app } = buildHarness({ held: 9 });

    const res = await create(app);

    expect(res.statusCode).toBe(201);
    expect(createSubdomain).toHaveBeenCalled();
    await app.close();
  });

  // The point of the whole change: there is no data on whether anybody wants
  // a fourth subdomain, and this line is how that question gets answered.
  it("writes down the refusal it would have made", async () => {
    const { app, lines } = buildHarness({ held: 5 });

    await create(app);

    expect(quotaLine(lines)).toMatchObject({
      evt: "quota",
      action: "withheld",
      scope: "account",
      held: 5,
      limit: 3,
      sub: `k:${USER_ID}`,
    });
    await app.close();
  });

  it("says nothing about an account that is under its limit", async () => {
    const { app, lines } = buildHarness({ held: 1 });

    await create(app);

    expect(quotaLine(lines)).toBeUndefined();
    await app.close();
  });
});

describe("enforcement, once switched on", () => {
  it("refuses a new subdomain and names the reason", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app, lines } = buildHarness({ held: 3 });

    const res = await create(app);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("LIMIT_REACHED");
    expect(createSubdomain).not.toHaveBeenCalled();
    expect(quotaLine(lines)).toMatchObject({ action: "blocked", held: 3, limit: 3 });
    await app.close();
  });

  // Three accounts are over three subdomains today. Taking names away from
  // them is exactly the thing this service did once already, by accident, and
  // will not do again: the limit applies to the next one, never the last one.
  it("leaves what an over-limit account already holds alone", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app } = buildHarness({ held: 11 });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.subdomains).toHaveLength(11);

    // and they can still change and remove what they have
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/subdomains/held0/${DOMAIN}`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { value: "5.6.7.8" },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/held0/${DOMAIN}`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(del.statusCode).toBe(200);

    // only a new one is refused
    expect((await create(app)).statusCode).toBe(403);
    await app.close();
  });

  it("takes the account's own number over the default", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app, lines } = buildHarness({ held: 5, limitColumn: 20 });

    const res = await create(app);

    expect(res.statusCode).toBe(201);
    expect(quotaLine(lines)).toBeUndefined();
    await app.close();
  });

  it("keeps working on a database where the column is not there yet", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app } = buildHarness({ held: 1, noColumn: true });

    // the migration is applied by hand, so the code may well arrive first —
    // and a hard failure there would stop everybody creating anything
    expect((await create(app)).statusCode).toBe(201);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// What is sold is a bundle: five more names for a year. 🔴 The end of a bundle
// is deliberately not a new rule — the limit has always been asked about the
// next subdomain and never about the last one, so a lapsed bundle lowers the
// limit and takes nothing.
// ---------------------------------------------------------------------------

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const BUNDLE_MICROS = 1000000;

function bundle(expiresAt) {
  return { amountMicros: BUNDLE_MICROS, expiresAt };
}

describe("a bundle, while it is running", () => {
  it("lifts the limit by five", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app, lines } = buildHarness({
      held: 7,
      creditRows: [bundle(new Date(Date.now() + YEAR_MS))],
    });

    expect((await create(app)).statusCode).toBe(201);
    expect(quotaLine(lines)).toBeUndefined();
    await app.close();
  });

  it("lifts it by ten when it was bought twice", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app } = buildHarness({
      held: 12,
      creditRows: [
        bundle(new Date(Date.now() + YEAR_MS)),
        // bought a month later, so it runs a month longer — they stack, and
        // neither one moves the other
        bundle(new Date(Date.now() + YEAR_MS + 30 * 24 * 60 * 60 * 1000)),
      ],
    });

    expect((await create(app)).statusCode).toBe(201);
    await app.close();
  });
});

describe("a bundle that has run out", () => {
  it("is not counted", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app, lines } = buildHarness({
      held: 7,
      creditRows: [bundle(new Date(Date.now() - 1000))],
    });

    expect((await create(app)).statusCode).toBe(403);
    expect(quotaLine(lines)).toMatchObject({ held: 7, limit: 3, paid_for: 0 });
    await app.close();
  });

  // 🔴 The whole of the answer to "what happens when the year is up". An
  // account holding eight keeps all eight; only the ninth is refused. Taking
  // names back is the one thing this service has done by accident before.
  it("leaves every name already held alone, and refuses only a new one", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app } = buildHarness({
      held: 8,
      creditRows: [bundle(new Date(Date.now() - 1000))],
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.subdomains).toHaveLength(8);

    // and they can still change, renew and remove what they have
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/subdomains/held0/${DOMAIN}`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { value: "5.6.7.8" },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/held0/${DOMAIN}`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(del.statusCode).toBe(200);

    // only the ninth is refused
    const res = await create(app);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("LIMIT_REACHED");
    expect(createSubdomain).not.toHaveBeenCalled();
    await app.close();
  });

  // A lapsed bundle is not half-counted and does not stay on the account: an
  // account with one dead bundle and one live one is on eight, the same as an
  // account that only ever bought the live one.
  it("adds nothing next to one that is still running", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const rows = [bundle(new Date(Date.now() - 1000)), bundle(new Date(Date.now() + YEAR_MS))];

    const seven = buildHarness({ held: 7, creditRows: rows });
    expect((await create(seven.app)).statusCode).toBe(201);
    await seven.app.close();

    createSubdomain.mockClear();
    const eight = buildHarness({ held: 8, creditRows: rows });
    expect((await create(eight.app)).statusCode).toBe(403);
    await eight.app.close();
  });
});

// ---------------------------------------------------------------------------
// Neither switch may start doing anything by being deployed.
// ---------------------------------------------------------------------------

describe("the switches ship off", () => {
  it("enforces nothing and asks nobody for money with no environment set", () => {
    loadRoutes();
    const config = require2("../configs/index.js");

    expect(config.quota.enforced).toBe(false);
    expect(config.x402.enabled).toBe(false);
    // and the price of a bundle is what was decided: five names, a year, 1.00
    expect(config.quota.bundle).toMatchObject({ size: 5, priceMicros: 1000000, days: 365 });
  });
});
