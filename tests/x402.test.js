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
const USDC = "0x00000000000000000000000000000000000000b2";
const USDT = "0x00000000000000000000000000000000000000c3";
const FACILITATOR = "https://facilitator.example";
const BUNDLE_MICROS = 1000000;

const savedEnv = {};
const ENV = [
  "SUBDOMAIN_LIMIT_ENFORCED", "X402_ENABLED", "X402_PAY_TO",
  "X402_USDC_ADDRESS", "X402_USDT_ADDRESS", "X402_USDT_NETWORK",
  "X402_USDT_DECIMALS", "X402_FACILITATOR_URL",
  "SUBDOMAIN_BUNDLE_PRICE_MICROS", "SUBDOMAIN_BUNDLE_SIZE",
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

/**
 * The switches in the state a server would be in once payment is wired up.
 *
 * One token, because that is the state we could actually reach today: USDC has
 * an address to point at and USDT has not been confirmed with any facilitator.
 * The tests that need both say so.
 */
function switchEverythingOn() {
  process.env.SUBDOMAIN_LIMIT_ENFORCED = "true";
  process.env.X402_ENABLED = "true";
  process.env.X402_PAY_TO = WALLET;
  process.env.X402_USDC_ADDRESS = USDC;
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

/** an X-PAYMENT header. `asset` is what the payer says they paid in. */
function proofFor(extra = {}) {
  return Buffer.from(JSON.stringify({ scheme: "exact", payload: {}, ...extra })).toString("base64");
}

const PROOF = proofFor();

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
    expect(state.reason).toContain("X402_USDC_ADDRESS");
    expect(state.reason).toContain("X402_FACILITATOR_URL");

    const said = lines.find((l) => l && l.evt === "x402" && l.action === "disabled");
    expect(said).toBeTruthy();
    // One entry for the tokens, because any one address is enough.
    expect(said.missing).toEqual([
      "X402_PAY_TO",
      "X402_USDC_ADDRESS or X402_USDT_ADDRESS",
      "X402_FACILITATOR_URL",
    ]);

    // and it refuses rather than quietly letting the request through
    const res = await create(app);
    expect(res.statusCode).toBe(403);
    expect(createSubdomain).not.toHaveBeenCalled();
    await app.close();
  });

  it("stays off when every token is listed but none has an address", async () => {
    switchEverythingOn();
    delete process.env.X402_USDC_ADDRESS;
    const { app, x402 } = buildHarness({ held: 5 });

    expect(x402.status()).toMatchObject({ enabled: false });
    expect(x402.status().reason).toContain("X402_USDC_ADDRESS or X402_USDT_ADDRESS");
    expect((await create(app)).statusCode).toBe(403);
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
      asset: USDC,
      maxAmountRequired: String(BUNDLE_MICROS),
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
    // (user_id, payer, amount_micros, channel, reference, expires_at)
    expect(insert.params.slice(0, 5)).toEqual([USER_ID, WALLET, BUNDLE_MICROS, "x402", "0xfeed"]);
    expect(insert.params[5]).toBeInstanceOf(Date);
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
  // What is sold is a bundle: one payment, five more names, for a year.
  it("lets an account hold what it has paid for, without being asked again", async () => {
    switchEverythingOn();
    globalThis.fetch = vi.fn();
    // three included, five bought, seven held
    const { app } = buildHarness({ held: 7, creditMicros: BUNDLE_MICROS });

    const res = await create(app);

    expect(res.statusCode).toBe(201);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("asks again once the bundle is used up", async () => {
    switchEverythingOn();
    // three included, five bought, all eight held
    const { app } = buildHarness({ held: 8, creditMicros: BUNDLE_MICROS });

    expect((await create(app)).statusCode).toBe(402);
    await app.close();
  });

  // Bundles stack rather than extend: pay twice and it is ten more, not five
  // more for two years.
  it("counts a second bundle as five more again", async () => {
    switchEverythingOn();
    globalThis.fetch = vi.fn();
    const { app } = buildHarness({ held: 12, creditMicros: BUNDLE_MICROS * 2 });

    expect((await create(app)).statusCode).toBe(201);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("stops at thirteen with two bundles, as it stops at eight with one", async () => {
    switchEverythingOn();
    const { app } = buildHarness({ held: 13, creditMicros: BUNDLE_MICROS * 2 });

    expect((await create(app)).statusCode).toBe(402);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 🔴 Two tokens were named and only one of them is confirmed. A token with no
// address configured is not offered at all, and a payment in something that
// was never offered does not buy anything.
// ---------------------------------------------------------------------------

describe("what we are willing to be paid in", () => {
  it("offers every token that has an address", async () => {
    switchEverythingOn();
    process.env.X402_USDT_ADDRESS = USDT;
    const { app } = buildHarness({ held: 5 });

    const body = (await create(app)).json();

    expect(body.accepts).toHaveLength(2);
    expect(body.accepts.map((a) => a.asset)).toEqual([USDC, USDT]);
    await app.close();
  });

  it("does not offer a token whose address is not set, and says so once", async () => {
    switchEverythingOn();
    const { app, lines } = buildHarness({ held: 5 });

    const body = (await create(app)).json();

    expect(body.accepts.map((a) => a.asset)).toEqual([USDC]);
    const said = lines.filter((l) => l && l.evt === "x402" && l.action === "asset_unset");
    expect(said).toHaveLength(1);
    expect(said[0].symbol).toBe("USDT");
    await app.close();
  });

  it("asks for a token's own smallest unit, not ours", async () => {
    switchEverythingOn();
    process.env.X402_USDT_ADDRESS = USDT;
    process.env.X402_USDT_DECIMALS = "18";
    process.env.X402_USDT_NETWORK = "ethereum";
    const { app } = buildHarness({ held: 5 });

    const body = (await create(app)).json();

    const usdt = body.accepts.find((a) => a.asset === USDT);
    expect(usdt.maxAmountRequired).toBe("1000000000000000000");
    expect(usdt.network).toBe("ethereum");
    await app.close();
  });

  it("does not accept a payment in a token it never asked for", async () => {
    switchEverythingOn();
    globalThis.fetch = vi.fn();
    const { app, queries } = buildHarness({ held: 5 });

    // USDT has no address here, so it was not among the accepts
    const res = await create(app, { "x-payment": proofFor({ asset: USDT }) });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toContain("did not ask for");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO credit_entries"))).toBe(false);
    await app.close();
  });

  it("settles against the token the payment names, not the first one offered", async () => {
    switchEverythingOn();
    process.env.X402_USDT_ADDRESS = USDT;
    const calls = fakeFacilitator({
      verify: { isValid: true },
      settle: { success: true, transaction: "0xfeed", payer: WALLET },
    });
    const { app } = buildHarness({ held: 5 });

    const res = await create(app, { "x-payment": proofFor({ asset: USDT }) });

    expect(res.statusCode).toBe(201);
    expect(calls[0].body.paymentRequirements.asset).toBe(USDT);
    await app.close();
  });

  it("will not guess which of two tokens a silent payment is in", async () => {
    switchEverythingOn();
    process.env.X402_USDT_ADDRESS = USDT;
    globalThis.fetch = vi.fn();
    const { app } = buildHarness({ held: 5 });

    const res = await create(app, { "x-payment": PROOF });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toContain("does not say which");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });
});
