import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Paying for a subdomain over HTTP.
//
// Off, and off is most of what is tested here: there is no wallet to be paid
// into, nobody has ever been charged, and the switch must not start doing
// anything by being deployed. The facilitator is faked at the HTTP layer —
// nothing in this file talks to a chain, a facilitator or a wallet.
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
  name: "demo.example.com", type: "A", expiresAt: new Date("2026-12-09T00:00:00Z"),
}));

const stubbed = [
  stub("../services/subdomain.js", {
    createSubdomain, updateSubdomain: vi.fn(), deleteSubdomain: vi.fn(),
  }),
  stub("../services/validation.js", {
    validateRecord: vi.fn(async () => true), setLogger: () => {},
  }),
];

const DOMAIN = "example.com";
const USER_ID = 7;
const API_KEY = "styo_0123456789abcdef0123456789abcdef";
const WALLET = "0x00000000000000000000000000000000000000a1";
const TOKEN = "0x00000000000000000000000000000000000000b2";
const FACILITATOR = "https://facilitator.example";

const savedEnv = {};
const ENV = [
  "SUBDOMAIN_LIMIT_ENFORCED", "X402_ENABLED", "X402_PAY_TO", "X402_ASSET",
  "X402_FACILITATOR_URL", "SUBDOMAIN_SLOT_PRICE_MICROS",
];
for (const key of ENV) savedEnv[key] = process.env[key];
const savedFetch = globalThis.fetch;

function loadRoutes() {
  for (const spec of [
    "../configs/index.js", "../services/access-log.js", "../services/credits.js",
    "../services/quota.js", "../services/x402.js", "../routes/api-v1.js",
  ]) {
    delete require2.cache[require2.resolve(spec)];
  }
  return require2("../routes/api-v1.js");
}

/** the switches in the state a server would be in once payment is wired up */
function switchEverythingOn() {
  process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
  process.env.X402_ENABLED = "true";
  process.env.X402_PAY_TO = WALLET;
  process.env.X402_ASSET = TOKEN;
  process.env.X402_FACILITATOR_URL = FACILITATOR;
}

function buildHarness({ held = 5, creditMicros = 0, insertFails = null } = {}) {
  const Fastify = require2("fastify");
  const apiV1Routes = loadRoutes();
  const x402 = require2("../services/x402.js");

  const lines = [];
  const queries = [];

  const execute = vi.fn(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM api_keys ak JOIN users u")) {
      return [[{ key_id: 1, user_id: USER_ID, email: "a@example.com", name: "A" }]];
    }
    if (sql.startsWith("UPDATE api_keys")) return [[]];
    if (sql.includes("FROM managed_domains")) return [[{ id: 1, domain_name: DOMAIN }]];
    if (sql.includes("subdomain_limit FROM users")) return [[{ subdomain_limit: null }]];
    if (sql.includes("COUNT(*) AS held FROM subdomains")) return [[{ held }]];
    if (sql.includes("FROM credit_entries")) return [[{ total: creditMicros }]];
    if (sql.startsWith("INSERT INTO credit_entries")) {
      if (insertFails) throw insertFails;
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });

  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute });
  app.log.warn = (obj) => lines.push(obj);
  app.log.info = (obj) => lines.push(obj);
  app.log.error = (obj) => lines.push(obj);
  // what app.js does at boot
  x402.setLogger(app.log);
  app.register(apiV1Routes, { prefix: "/api/v1" });

  return { app, lines, queries, x402 };
}

function create(app, headers = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/subdomains",
    headers: { authorization: `Bearer ${API_KEY}`, ...headers },
    payload: { subdomain: "demo", domain: DOMAIN, type: "A", value: "1.2.3.4" },
  });
}

const PROOF = Buffer.from(JSON.stringify({ scheme: "exact", payload: {} })).toString("base64");

/** a facilitator that answers whatever these say, and records what it was asked */
function fakeFacilitator({ verify, settle }) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const answer = String(url).endsWith("/verify") ? verify : settle;
    return { ok: true, status: 200, json: async () => answer };
  });
  return calls;
}

beforeEach(() => {
  createSubdomain.mockClear();
  for (const key of ENV) delete process.env[key];
  globalThis.fetch = savedFetch;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = savedFetch;
  for (const filename of stubbed) delete require2.cache[filename];
  loadRoutes();
});

// ---------------------------------------------------------------------------

describe("switched off", () => {
  it("never sends a 402, even to a caller who is being refused", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    const { app } = buildHarness({ held: 5 });

    const res = await create(app);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("LIMIT_REACHED");
    await app.close();
  });

  it("ignores a payment proof nobody asked for", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    globalThis.fetch = vi.fn();
    const { app } = buildHarness({ held: 5 });

    expect((await create(app, { "x-payment": PROOF })).statusCode).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("switched on with no wallet to be paid into", () => {
  it("stays off and names every setting that is missing", async () => {
    process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
    process.env.X402_ENABLED = "true";
    const { app, lines, x402 } = buildHarness({ held: 5 });

    const state = x402.status();
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("X402_PAY_TO");
    expect(state.reason).toContain("X402_ASSET");
    expect(state.reason).toContain("X402_FACILITATOR_URL");

    const said = lines.find((l) => l && l.evt === "x402" && l.action === "disabled");
    expect(said).toBeTruthy();
    expect(said.missing).toEqual(["X402_PAY_TO", "X402_ASSET", "X402_FACILITATOR_URL"]);

    // and it refuses rather than quietly letting the request through
    const res = await create(app);
    expect(res.statusCode).toBe(403);
    expect(createSubdomain).not.toHaveBeenCalled();
    await app.close();
  });

  it("stays off when only the wallet address is missing", async () => {
    switchEverythingOn();
    delete process.env.X402_PAY_TO;
    const { app, x402 } = buildHarness({ held: 5 });

    expect(x402.status()).toMatchObject({ enabled: false });
    expect(x402.status().reason).toContain("X402_PAY_TO");
    expect((await create(app)).statusCode).toBe(403);
    await app.close();
  });
});

describe("switched on and configured", () => {
  it("says what to pay and where", async () => {
    switchEverythingOn();
    const { app } = buildHarness({ held: 5 });

    const res = await create(app);

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base",
      payTo: WALLET,
      asset: TOKEN,
      maxAmountRequired: "1000000",
    });
    expect(body.accepts[0].resource).toContain("/api/v1/subdomains");
    expect(createSubdomain).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not let a proof the facilitator rejects through", async () => {
    switchEverythingOn();
    const calls = fakeFacilitator({
      verify: { isValid: false, invalidReason: "insufficient_funds" },
      settle: { success: true, transaction: "0xdead" },
    });
    const { app, queries } = buildHarness({ held: 5 });

    const res = await create(app, { "x-payment": PROOF });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toContain("insufficient_funds");
    expect(createSubdomain).not.toHaveBeenCalled();
    // nothing was settled and nothing was written down
    expect(calls.map((c) => c.url)).toEqual([`${FACILITATOR}/verify`]);
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO credit_entries"))).toBe(false);
    await app.close();
  });

  it("refuses a settlement it cannot name, however successful it claims to be", async () => {
    switchEverythingOn();
    fakeFacilitator({ verify: { isValid: true }, settle: { success: true } });
    const { app, queries } = buildHarness({ held: 5 });

    const res = await create(app, { "x-payment": PROOF });

    expect(res.statusCode).toBe(402);
    expect(createSubdomain).not.toHaveBeenCalled();
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO credit_entries"))).toBe(false);
    await app.close();
  });

  it("takes a settled payment, writes it down, and goes on", async () => {
    switchEverythingOn();
    fakeFacilitator({
      verify: { isValid: true, payer: WALLET },
      settle: { success: true, transaction: "0xfeed", payer: WALLET },
    });
    const { app, queries } = buildHarness({ held: 5 });

    const res = await create(app, { "x-payment": PROOF });

    expect(res.statusCode).toBe(201);
    expect(createSubdomain).toHaveBeenCalled();
    expect(res.headers["x-payment-response"]).toBeTruthy();

    const insert = queries.find((q) => q.sql.startsWith("INSERT INTO credit_entries"));
    expect(insert).toBeTruthy();
    // (user_id, payer, amount_micros, channel, reference)
    expect(insert.params).toEqual([USER_ID, WALLET, 1000000, "x402", "0xfeed"]);
    await app.close();
  });

  it("will not spend one settled payment twice", async () => {
    switchEverythingOn();
    fakeFacilitator({
      verify: { isValid: true },
      settle: { success: true, transaction: "0xfeed", payer: WALLET },
    });
    const { app } = buildHarness({
      held: 5,
      insertFails: Object.assign(new Error("Duplicate entry"), {
        code: "ER_DUP_ENTRY", errno: 1062,
      }),
    });

    const res = await create(app, { "x-payment": PROOF });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toContain("already been used");
    expect(createSubdomain).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("the balance behind both doors", () => {
  it("lets an account hold what it has paid for, without being asked again", async () => {
    switchEverythingOn();
    globalThis.fetch = vi.fn();
    // three included, one bought, three held
    const { app } = buildHarness({ held: 3, creditMicros: 1000000 });

    const res = await create(app);

    expect(res.statusCode).toBe(201);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("asks again once what was paid for is used up", async () => {
    switchEverythingOn();
    const { app } = buildHarness({ held: 4, creditMicros: 1000000 });

    expect((await create(app)).statusCode).toBe(402);
    await app.close();
  });
});
