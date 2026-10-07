import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The testnet batch (2026-10-07, scratchpad/agent-8004-spec.md):
//
//   1. /.well-known/agent-registration.json — the ERC-8004 card, from settings
//   2. the top of /llms.txt — identity, then MCP
//   3. ?via= on every address we hand out, and a `via` field in the access log
//   4. a paid year on an agent's record, over x402
//   5. the facilitator: none needed on testnet, a CDP JWT when a key is set
//   6. base-sepolia / base, and the token's EIP-712 domain
//   7. 🔴 with production's settings, none of it changes anything
//
// Settings are read when configs/index.js loads, so every case sets the
// environment and then reloads the project's modules. Nothing here talks to a
// chain or a facilitator: fetch is faked at the HTTP layer.
// ---------------------------------------------------------------------------

const crypto = require2("crypto");
const fs = require2("fs");
const path = require2("path");
const fp = require2("fastify-plugin");
const Fastify = require2("fastify");

const ROOT = path.join(__dirname, "..");
const DOMAIN = "example.com";
const DOMAIN_ID = 1;
const RECORD_ID = 42;
const API_KEY = "styo_" + "a".repeat(32);
const TOKEN = "anon_" + "b".repeat(32);

const PAYEE = "0x00000000000000000000000000000000000000a1";
const PAYER = "0x00000000000000000000000000000000000000d4";
// Circle's Base Sepolia USDC (developers.circle.com/stablecoins/usdc-contract-addresses).
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACILITATOR = "https://x402.org/facilitator";
// erc-8004/erc-8004-contracts README.
const SEPOLIA_REGISTRY = "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e";
const TX = "0x" + "f".repeat(64);

const DAY_MS = 24 * 60 * 60 * 1000;
// Every case reloads the project's modules (the MCP SDK among them), which is
// seconds, not milliseconds, when the whole suite runs in parallel.
const SLOW = 30000;

const ENV = [
  "X402_ENABLED", "X402_PAY_TO", "X402_NETWORK", "X402_USDC_ADDRESS", "X402_USDT_ADDRESS",
  "X402_USDC_NETWORK", "X402_FACILITATOR_URL", "X402_EXTEND_PRICE_MICROS",
  "X402_CDP_API_KEY_ID", "X402_CDP_API_KEY_SECRET",
  "AGENT_ID", "AGENT_REGISTRY", "AGENT_EMAIL", "AGENT_NAME", "SUBDOMAIN_LIMIT_ENFORCED",
];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const savedFetch = globalThis.fetch;

/** Empty, not deleted: dotenv never overrides a variable that is set. */
function productionDefaults() {
  for (const key of ENV) process.env[key] = "";
}

/** What the E2E server runs with: the public testnet facilitator, no key. */
function testnet(extra = {}) {
  Object.assign(process.env, {
    X402_ENABLED: "true",
    X402_PAY_TO: PAYEE,
    X402_NETWORK: "base-sepolia",
    X402_USDC_ADDRESS: USDC_SEPOLIA,
    X402_FACILITATOR_URL: FACILITATOR,
    ...extra,
  });
}

const dbPath = require2.resolve("../plugins/db.js");

/** Drop every project module so the next require reads the environment again. */
function fresh() {
  for (const key of Object.keys(require2.cache)) {
    if (key.startsWith(ROOT) && !key.includes("node_modules") && !key.includes(`${path.sep}tests${path.sep}`)) {
      delete require2.cache[key];
    }
  }
}

/**
 * The database, scripted. `expiresInDays` is how long the record has left;
 * `ownerType` whose it is; `insert` what writing the ledger row does.
 */
function scriptedDb({ expiresInDays = 10, ownerType = "agent", insert = null } = {}) {
  const queries = [];
  const execute = vi.fn(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM api_keys ak JOIN users u")) {
      return [[{ key_id: 1, user_id: 7, email: "a@example.com", name: "A" }]];
    }
    if (sql.startsWith("UPDATE api_keys")) return [[]];
    if (/managed_domains/i.test(sql) && !sql.includes("FROM subdomains s")) {
      return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    }
    if (sql.startsWith("SELECT id, record_type FROM subdomains")) {
      return [[{ id: RECORD_ID, record_type: "A" }]];
    }
    if (sql.startsWith("SELECT id, owner_type, expires_at FROM subdomains")) {
      return [[{
        id: RECORD_ID,
        owner_type: ownerType,
        expires_at: new Date(Date.now() + expiresInDays * DAY_MS + 3600 * 1000),
      }]];
    }
    // renewSubdomain's own lookup (the free door)
    if (sql.includes("FROM subdomains s") && sql.includes("WHERE s.id = ?")) {
      return [[{
        id: RECORD_ID, subdomain: "demo", owner_type: ownerType, domain_name: DOMAIN,
        expires_at: new Date(Date.now() + expiresInDays * DAY_MS + 3600 * 1000),
      }]];
    }
    if (sql.startsWith("INSERT INTO credit_entries")) {
      if (insert) throw insert;
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });
  return { execute, queries };
}

function restApp(db) {
  fresh();
  const apiV1Routes = require2("../routes/api-v1.js");
  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute: db.execute });
  app.register(apiV1Routes, { prefix: "/api/v1" });
  return app;
}

function mcpApp(db) {
  fresh();
  const mcpPlugin = require2("../plugins/mcp.js");
  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute: db.execute });
  // inject()'s socket has no destroySoon; see tests/abuse-policy.test.js.
  app.addHook("onRequest", async (request) => {
    const socket = request.raw.socket;
    if (socket && typeof socket.destroySoon !== "function") {
      socket.destroySoon = () => socket.destroy?.();
    }
  });
  app.register(mcpPlugin);
  return app;
}

/** The whole app, with plugins/db stubbed and every log line captured. */
async function wholeApp() {
  fresh();
  require2.cache[dbPath] = {
    id: dbPath, filename: dbPath, path: dbPath, loaded: true, children: [], paths: [],
    exports: fp(async (fastify) => {
      fastify.decorate("mysql", {
        execute: async (sql) => (/managed_domains/i.test(sql) ? [[{ id: 1, domain_name: "sitey.my" }]] : [[]]),
        getConnection: async () => ({
          execute: async () => [[]], beginTransaction: async () => {}, commit: async () => {},
          rollback: async () => {}, release: () => {},
        }),
      });
    }),
  };
  const { buildApp } = require2("../app.js");
  const logged = [];
  const capture = {
    info: (obj) => logged.push(obj), warn: () => {}, error: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, silent: () => {}, level: "info",
    child() { return this; },
  };
  const app = buildApp({ logger: undefined, loggerInstance: capture });
  app.addHook("onRequest", async (request) => {
    const socket = request.raw.socket;
    if (socket && typeof socket.destroySoon !== "function") {
      socket.destroySoon = () => socket.destroy?.();
    }
  });
  await app.ready();
  return { app, logged };
}

function extendRest(app, { token = TOKEN, key = null, payment = null, url } = {}) {
  const bearer = key || token;
  return app.inject({
    method: "POST",
    url: url || `/api/v1/subdomains/demo/${DOMAIN}/extend`,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(payment ? { "x-payment": payment } : {}),
    },
  });
}

async function callTool(app, name, args, { key = null } = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  const line = res.body.split("\n").find((l) => l.startsWith("data: "));
  const result = JSON.parse(line.slice("data: ".length)).result;
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

async function listTools(app) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  const line = res.body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice("data: ".length)).result.tools;
}

/** An x402 exact payment payload, as a client would put in X-PAYMENT. */
function proof(network = "base-sepolia") {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: "exact",
    network,
    payload: {
      signature: "0x" + "1".repeat(130),
      authorization: {
        from: PAYER, to: PAYEE, value: "1000000", validAfter: "0", validBefore: "9999999999",
        nonce: "0x" + "2".repeat(64),
      },
    },
  })).toString("base64");
}

/** A facilitator that answers these and records what it was asked, headers and all. */
function fakeFacilitator({
  verify = { isValid: true, payer: PAYER },
  settle = { success: true, transaction: TX, network: "base-sepolia", payer: PAYER },
} = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const answer = String(url).endsWith("/verify") ? verify : settle;
    return { ok: true, status: 200, json: async () => answer };
  });
  return calls;
}

function decodeJwt(jwt) {
  const [h, c, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()),
    input: Buffer.from(`${h}.${c}`),
    signature: Buffer.from(s, "base64url"),
  };
}

beforeEach(() => {
  productionDefaults();
  globalThis.fetch = savedFetch;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = savedFetch;
  delete require2.cache[dbPath];
  fresh();
});

// ===========================================================================
// 7. Production's settings change nothing
// ===========================================================================

describe("7 — with production's settings nothing moves", { timeout: SLOW }, () => {
  it("serves the card without payment, and the paid year answers «off», never 402", async () => {
    globalThis.fetch = vi.fn();

    // The card is there, and says payment is not supported.
    fresh();
    const discovery = require2("../services/discovery.js");
    const card = discovery.agentCard({ origin: "https://sitey.my" });
    expect(card.x402Support).toBe(false);
    expect(card.registrations).toEqual([]);
    expect(card.description).not.toMatch(/USDC/);
    expect(discovery.llmsTxt({ origin: "https://sitey.my", domains: ["sitey.my"] }))
      .toMatch(/Paying for a year is switched off/);

    // REST: off, not a price — even with a proof attached.
    const rest = restApp(scriptedDb());
    const res = await extendRest(rest, { payment: proof() });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("PAYMENT_DISABLED");
    await rest.close();

    // MCP: the same.
    const mcp = mcpApp(scriptedDb());
    const tool = await callTool(mcp, "extend_subdomain", { subdomain: "demo", domain: DOMAIN, owner_token: TOKEN });
    expect(tool.isError).toBe(true);
    expect(tool.data.code).toBe("PAYMENT_DISABLED");
    const described = (await listTools(mcp)).find((t) => t.name === "extend_subdomain");
    expect(described.description).toMatch(/switched off/);
    await mcp.close();

    // The free monthly renewal is exactly as it was.
    const db = scriptedDb({ expiresInDays: 3 });
    const renewApp = restApp(db);
    const renewed = await renewApp.inject({
      method: "POST",
      url: `/api/v1/subdomains/demo/${DOMAIN}/renew`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(renewed.statusCode).toBe(200);
    const days = (new Date(renewed.json().data.expires_at) - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(25);
    expect(days).toBeLessThan(35);
    await renewApp.close();

    // Nobody was asked anything.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 1. The card
// ===========================================================================

describe("1 — /.well-known/agent-registration.json", { timeout: SLOW }, () => {
  it("is served as JSON, in the EIP's shape, with MCP tagged ?via=8004", async () => {
    const { app } = await wholeApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/agent-registration.json" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const card = res.json();
    expect(card.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(card.name).toBe("sitey");
    expect(card.image).toMatch(/^https:\/\/.+\.png$/);
    expect(card.active).toBe(true);
    expect(card.supportedTrust).toEqual(["reputation"]);
    expect(card.services).toContainEqual({ name: "web", endpoint: "https://sitey.my" });
    const mcp = card.services.find((s) => s.name === "MCP");
    expect(mcp.endpoint).toBe("https://sitey.my/mcp?via=8004");
    expect(mcp.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No contact address set, so no email service promised.
    expect(card.services.find((s) => s.name === "email")).toBeUndefined();
    await app.close();
  });

  it("fills registrations from AGENT_ID and AGENT_REGISTRY, and only from both", () => {
    process.env.AGENT_ID = "12";
    fresh();
    expect(require2("../services/discovery.js").agentCard({ origin: "https://x.test" }).registrations).toEqual([]);

    process.env.AGENT_REGISTRY = SEPOLIA_REGISTRY;
    fresh();
    expect(require2("../services/discovery.js").agentCard({ origin: "https://x.test" }).registrations).toEqual([
      { agentId: 12, agentRegistry: SEPOLIA_REGISTRY },
    ]);
  });

  it("refuses to boot on a registry that does not parse", async () => {
    process.env.AGENT_ID = "12";
    process.env.AGENT_REGISTRY = "base-sepolia:0x8004";
    await expect(wholeApp()).rejects.toThrow(/AGENT_REGISTRY/);
  });

  it("says x402Support only when paying would actually work", () => {
    process.env.X402_ENABLED = "true"; // on, but nowhere to be paid
    fresh();
    expect(require2("../services/discovery.js").agentCard({ origin: "https://x.test" }).x402Support).toBe(false);

    testnet();
    fresh();
    const card = require2("../services/discovery.js").agentCard({ origin: "https://x.test" });
    expect(card.x402Support).toBe(true);
    expect(card.description).toContain("1.00 USDC");
  });

  it("lists an email service when AGENT_EMAIL is set", () => {
    process.env.AGENT_EMAIL = "agent@example.test";
    fresh();
    const card = require2("../services/discovery.js").agentCard({ origin: "https://x.test" });
    expect(card.services).toContainEqual({ name: "email", endpoint: "agent@example.test" });
  });

  it("is not blocked by robots.txt", () => {
    const robots = fs.readFileSync(path.join(ROOT, "public/robots.txt"), "utf8");
    const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gim)].map((m) => m[1]);
    for (const prefix of disallowed) {
      expect("/.well-known/agent-registration.json".startsWith(prefix)).toBe(false);
    }
  });
});

// ===========================================================================
// 2. llms.txt
// ===========================================================================

describe("2 — the top of /llms.txt", { timeout: SLOW }, () => {
  it("without an agentId: the card's address only, then MCP with no account needed", () => {
    fresh();
    const lines = require2("../services/discovery.js")
      .llmsTxt({ origin: "https://x.test", domains: ["x.test"] })
      .split("\n");

    expect(lines[0]).toBe("# x.test");
    expect(lines[2]).toMatch(/^> Put your AI-built site on your own address/);
    expect(lines[4]).toBe("Identity: ERC-8004 agent card — https://x.test/.well-known/agent-registration.json");
    expect(lines[5]).toBe("MCP: https://x.test/mcp?via=llms (no account needed)");
  });

  it("with one: the number and the chain", () => {
    process.env.AGENT_ID = "12";
    process.env.AGENT_REGISTRY = SEPOLIA_REGISTRY;
    fresh();
    const text = require2("../services/discovery.js").llmsTxt({ origin: "https://x.test", domains: ["x.test"] });

    expect(text).toContain(
      "Identity: ERC-8004 agent #12 on Base Sepolia — https://x.test/.well-known/agent-registration.json"
    );
  });

  it("keeps the old body underneath", () => {
    fresh();
    const discovery = require2("../services/discovery.js");
    const text = discovery.llmsTxt({ origin: "https://x.test", domains: ["x.test"] });

    expect(text.indexOf("MCP: https://x.test/mcp?via=llms")).toBeLessThan(text.indexOf(discovery.SUMMARY));
    expect(text).toContain("## Calling it");
    expect(text).toContain("## Limits");
  });
});

// ===========================================================================
// 3. Which door
// ===========================================================================

describe("3 — ?via= reaches the access log", { timeout: SLOW }, () => {
  it("logs via on MCP and REST requests, null when absent, «other» when odd", async () => {
    const { app, logged } = await wholeApp();
    const http = () => logged.filter((l) => l && l.evt === "http").pop();

    await app.inject({
      method: "POST",
      url: "/mcp?via=8004",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(http()).toMatchObject({ p: "/mcp", via: "8004" });

    await app.inject({ method: "GET", url: "/api/v1/domains?via=llms" });
    expect(http()).toMatchObject({ p: "/api/v1/domains", via: "llms" });

    await app.inject({ method: "GET", url: "/api/v1/domains" });
    expect(http().via).toBeNull();

    await app.inject({ method: "GET", url: "/api/v1/domains?via=%22%3E%3Cscript%3E" });
    expect(http().via).toBe("other");
    await app.close();
  });

  it("server.json hands the registry an address tagged ?via=registry", () => {
    const server = JSON.parse(fs.readFileSync(path.join(ROOT, "server.json"), "utf8"));
    expect(server.remotes[0].url).toMatch(/\/mcp\?via=registry$/);
  });
});

// ===========================================================================
// 4. A paid year
// ===========================================================================

describe("4 — a year for 1 USDC (REST)", { timeout: SLOW }, () => {
  it("asks for 1 USDC first, in Base Sepolia USDC, for this record", async () => {
    testnet();
    const db = scriptedDb();
    const app = restApp(db);
    globalThis.fetch = vi.fn();

    const res = await extendRest(app);

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000000",
      payTo: PAYEE,
      asset: USDC_SEPOLIA,
      resource: `https://sitey.my/api/v1/subdomains/demo/${DOMAIN}/extend`,
      extra: { name: "USDC", version: "2" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith("UPDATE subdomains"))).toBe(false);
    await app.close();
  });

  it("verifies, settles, then sets expires_at a year out and returns the transaction", async () => {
    testnet();
    const db = scriptedDb();
    const app = restApp(db);
    const calls = fakeFacilitator();

    const res = await extendRest(app, { payment: proof() });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.transaction).toBe(TX);
    expect(data.network).toBe("base-sepolia");
    expect(data.payer).toBe(PAYER);
    const days = (new Date(data.expires_at) - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(363);
    expect(days).toBeLessThan(367);
    expect(res.headers["x-payment-response"]).toBeTruthy();

    // verify before settle, against the same requirement
    expect(calls.map((c) => c.url)).toEqual([`${FACILITATOR}/verify`, `${FACILITATOR}/settle`]);
    expect(calls[0].body.paymentRequirements.maxAmountRequired).toBe("1000000");
    // testnet: no key, no Authorization header
    expect(calls[0].headers.Authorization).toBeUndefined();

    // the ledger row has no account, so it buys no subdomain slots
    const insert = db.queries.find((q) => q.sql.startsWith("INSERT INTO credit_entries"));
    expect(insert.params.slice(0, 5)).toEqual([null, PAYER, 1000000, "x402", TX]);
    // and the date moved only after
    const update = db.queries.find((q) => q.sql.startsWith("UPDATE subdomains SET expires_at"));
    expect(update.params[1]).toBe(RECORD_ID);
    expect(db.queries.indexOf(update)).toBeGreaterThan(db.queries.indexOf(insert));
    await app.close();
  });

  it("takes its price from X402_EXTEND_PRICE_MICROS", async () => {
    testnet({ X402_EXTEND_PRICE_MICROS: "2500000" });
    const app = restApp(scriptedDb());
    const res = await extendRest(app);
    expect(res.json().accepts[0].maxAmountRequired).toBe("2500000");
    await app.close();
  });

  it("moves nothing when the facilitator will not verify — and never settles", async () => {
    testnet();
    const db = scriptedDb();
    const app = restApp(db);
    const calls = fakeFacilitator({ verify: { isValid: false, invalidReason: "invalid_signature" } });

    const res = await extendRest(app, { payment: proof() });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("invalid_signature");
    expect(calls.map((c) => c.url)).toEqual([`${FACILITATOR}/verify`]);
    expect(db.queries.some((q) => q.sql.startsWith("UPDATE subdomains"))).toBe(false);
    await app.close();
  });

  it("moves nothing when settlement fails", async () => {
    testnet();
    const db = scriptedDb();
    const app = restApp(db);
    fakeFacilitator({ settle: { success: false, errorReason: "insufficient_funds", transaction: "" } });

    const res = await extendRest(app, { payment: proof() });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("insufficient_funds");
    expect(db.queries.some((q) => q.sql.startsWith("UPDATE subdomains"))).toBe(false);
    await app.close();
  });

  it("refuses a settlement that has already bought something", async () => {
    testnet();
    const db = scriptedDb({ insert: Object.assign(new Error("dup"), { errno: 1062 }) });
    const app = restApp(db);
    fakeFacilitator();

    const res = await extendRest(app, { payment: proof() });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("this payment has already been used");
    expect(db.queries.some((q) => q.sql.startsWith("UPDATE subdomains"))).toBe(false);
    await app.close();
  });

  it("does not ask for money while a paid year still runs", async () => {
    testnet();
    const app = restApp(scriptedDb({ expiresInDays: 200 }));
    globalThis.fetch = vi.fn();

    const res = await extendRest(app, { payment: proof() });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("EXTENSION_NOT_DUE");
    expect(res.json().message).toMatch(/opens again on \d{4}-\d{2}-\d{2}/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("is for owner-token records only", async () => {
    testnet();
    globalThis.fetch = vi.fn();
    const keyed = restApp(scriptedDb({ ownerType: "user" }));
    const res = await extendRest(keyed, { key: API_KEY, token: null });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("OWNER_TOKEN_REQUIRED");
    await keyed.close();

    const anonymous = restApp(scriptedDb());
    const bare = await extendRest(anonymous, { token: null });
    expect(bare.json().code).toBe("OWNER_TOKEN_REQUIRED");
    await anonymous.close();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("leaves the free renew route answering exactly as before", async () => {
    testnet();
    const app = restApp(scriptedDb({ expiresInDays: 20 }));
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/subdomains/demo/${DOMAIN}/renew`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("RENEWAL_NOT_DUE");
    await app.close();
  });
});

describe("4 — the same door over MCP", { timeout: SLOW }, () => {
  it("states the price in the tool description", async () => {
    testnet();
    const app = mcpApp(scriptedDb());
    const tool = (await listTools(app)).find((t) => t.name === "extend_subdomain");
    expect(tool.description).toContain("1.00 USDC");
    expect(tool.description).toMatch(/12 months/);
    await app.close();
  });

  it("answers with the requirement, then extends on a payment argument", async () => {
    testnet();
    const db = scriptedDb();
    const app = mcpApp(db);
    globalThis.fetch = vi.fn();

    const asked = await callTool(app, "extend_subdomain", { subdomain: "demo", domain: DOMAIN, owner_token: TOKEN });
    expect(asked.isError).toBe(true);
    expect(asked.data.code).toBe("PAYMENT_REQUIRED");
    expect(asked.data.accepts[0].maxAmountRequired).toBe("1000000");

    fakeFacilitator();
    const paid = await callTool(app, "extend_subdomain", {
      subdomain: "demo", domain: DOMAIN, owner_token: TOKEN, payment: proof(),
    });
    expect(paid.isError).toBe(false);
    expect(paid.data.transaction).toBe(TX);
    expect((new Date(paid.data.expires_at) - Date.now()) / DAY_MS).toBeGreaterThan(363);
    await app.close();
  });
});

// ===========================================================================
// 5. The facilitator, and CDP's key
// ===========================================================================

describe("5 — CDP authentication", { timeout: SLOW }, () => {
  function ed25519Secret() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const raw = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]);
    return { value: raw.toString("base64"), publicKey };
  }

  it("signs an Ed25519 JWT in CDP's shape", () => {
    fresh();
    const x402 = require2("../services/x402.js");
    const key = ed25519Secret();
    const jwt = x402.cdpJwt({
      keyId: "kid-1",
      keySecret: key.value,
      method: "POST",
      url: "https://api.cdp.coinbase.com/platform/v2/x402/verify",
    });
    const { header, claims, input, signature } = decodeJwt(jwt);

    expect(header).toMatchObject({ alg: "EdDSA", kid: "kid-1", typ: "JWT" });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(claims).toMatchObject({
      sub: "kid-1",
      iss: "cdp",
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/verify",
      uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"],
    });
    expect(claims.exp - claims.nbf).toBe(120);
    expect(crypto.verify(null, input, key.publicKey, signature)).toBe(true);
  });

  it("signs an ES256 JWT from a legacy EC key", () => {
    fresh();
    const x402 = require2("../services/x402.js");
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ format: "pem", type: "sec1" });
    const jwt = x402.cdpJwt({ keyId: "kid-2", keySecret: pem, method: "POST", url: "https://h.test/p" });
    const { header, input, signature } = decodeJwt(jwt);

    expect(header.alg).toBe("ES256");
    expect(crypto.verify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("sends Authorization: Bearer on every facilitator call once a key is set", async () => {
    const key = ed25519Secret();
    testnet({ X402_CDP_API_KEY_ID: "kid-1", X402_CDP_API_KEY_SECRET: key.value });
    const app = restApp(scriptedDb());
    const calls = fakeFacilitator();

    expect((await extendRest(app, { payment: proof() })).statusCode).toBe(200);
    for (const call of calls) {
      const { claims } = decodeJwt(call.headers.Authorization.replace(/^Bearer /, ""));
      expect(claims.uri).toBe(`POST ${new URL(call.url).host}${new URL(call.url).pathname}`);
    }
    await app.close();
  });

  it("asks nobody with half a key", async () => {
    testnet({ X402_CDP_API_KEY_ID: "kid-1" });
    const db = scriptedDb();
    const app = restApp(db);
    globalThis.fetch = vi.fn();

    const res = await extendRest(app, { payment: proof() });

    expect(res.statusCode).toBe(402);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith("UPDATE subdomains"))).toBe(false);
    await app.close();
  });
});

// ===========================================================================
// 6. Which chain
// ===========================================================================

describe("6 — network and the token's signing domain", { timeout: SLOW }, () => {
  it("base names USDC «USD Coin»; base-sepolia names it «USDC»", async () => {
    testnet({ X402_NETWORK: "base", X402_USDC_ADDRESS: USDC_BASE });
    const app = restApp(scriptedDb());
    const body = (await extendRest(app)).json();
    expect(body.accepts[0]).toMatchObject({
      network: "base",
      asset: USDC_BASE,
      extra: { name: "USD Coin", version: "2" },
    });
    await app.close();
  });

  it("refuses a payment made on the other chain before asking anybody", async () => {
    testnet();
    const app = restApp(scriptedDb());
    globalThis.fetch = vi.fn();

    const res = await extendRest(app, { payment: proof("base") });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatch(/did not ask for/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });
});
