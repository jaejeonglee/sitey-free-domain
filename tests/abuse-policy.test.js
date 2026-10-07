import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// What a caller with no account may not do (2026-10-07).
//
// 2026-10-06/07 an anonymous caller published a malware contact point through
// us — a TXT record on a name of its own, CNAMEs to a throwaway tunnel — and
// when its address was blocked it came back from another the next day. So the
// rules are about what is asked for, and the line is an account. Each block
// below is one line of the spec's acceptance list
// (scratchpad/security-batch-spec.md, «합격 기준»):
//
//   1. anonymous TXT → ACCOUNT_REQUIRED, REST and MCP; an API key succeeds
//   2. anonymous CNAME/REDIRECT to x.trycloudflare.com → refused; key succeeds
//   3. toss-login → refused for all; login-demo → anonymous refused, key ok
//   4. a blocklisted name / token / address → refused
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

const DOMAIN = "example.com";
const DOMAIN_ID = 1;
const USER_ID = 7;
const API_KEY = "styo_" + "a".repeat(32);

const createSubdomain = vi.fn(async (fastify, p) => ({
  name: `${p.subdomain}.${p.domain}`,
  type: p.recordType,
  expiresAt: new Date("2026-11-07T00:00:00Z"),
}));
const updateSubdomain = vi.fn(async () => {});

const stubbed = [
  stub("../services/subdomain.js", {
    createSubdomain,
    updateSubdomain,
    deleteSubdomain: vi.fn(async () => {}),
    txtPrefixFor: (type) => (type === "CNAME" ? "_vercel" : "@"),
  }),
  stub("../services/validation.js", {
    noteReachability: vi.fn(async () => ({ ok: true, note: null })),
    setLogger: () => {},
  }),
];
for (const spec of ["../routes/domain.js", "../routes/api-v1.js", "../plugins/mcp.js"]) {
  delete require2.cache[require2.resolve(spec)];
}

const Fastify = require2("fastify");
const config = require2("../configs/index.js");
const bindMod = require2("../services/bind.js");
const anonToken = require2("../services/anon-token.js");
const { isBlacklisted } = require2("../services/blacklist.js");
const { isTunnelHost, checkAnonTarget } = require2("../services/abuse-policy.js");
const domainRoutes = require2("../routes/domain.js");
const apiV1Routes = require2("../routes/api-v1.js");
const mcpPlugin = require2("../plugins/mcp.js");

afterAll(() => {
  for (const filename of stubbed) delete require2.cache[filename];
});

// ---------------------------------------------------------------------------
// A MySQL that keeps a blocklist and answers it the way the SQL in
// services/blocklist.js asks: a name row is found *inside* the subdomain, a
// token or address row must be equal.
// ---------------------------------------------------------------------------

/** rows of the `blocklist` table for the current test */
let blocklist = [];
/** record_type of the one record every ownership lookup finds */
let ownedType = "A";
let txtWrites = [];

function scriptedDb() {
  return vi.fn(async (sql, params = []) => {
    if (sql.includes("FROM blocklist")) {
      const [name, tokenHash, ip] = params;
      const hit = blocklist.find(
        (row) =>
          (row.kind === "name" && name !== "" && name.includes(row.value)) ||
          (row.kind === "token" && row.value === tokenHash) ||
          (row.kind === "ip" && row.value === ip)
      );
      return [hit ? [{ kind: hit.kind }] : []];
    }
    if (sql.includes("FROM managed_domains")) return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    if (sql.includes("FROM api_keys ak JOIN users u")) {
      return [[{ key_id: 1, user_id: USER_ID, email: "a@example.com", name: "A" }]];
    }
    if (sql.startsWith("UPDATE api_keys")) return [[]];
    if (sql.includes("subdomain_limit FROM users")) return [[{ subdomain_limit: null }]];
    if (sql.includes("FROM credit_entries")) return [[{ total: 0 }]];
    if (sql.includes("COUNT(*) AS held FROM subdomains")) return [[{ held: 0 }]];
    if (/^SELECT (s\.id, s\.record_type|id, record_type)/.test(sql)) {
      return [[{ id: 42, record_type: ownedType }]];
    }
    if (sql.includes("FROM subdomain_txt_records")) return [[]];
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

let origAdd;
let origDel;
let origFind;

beforeEach(() => {
  blocklist = [];
  ownedType = "A";
  txtWrites = [];
  createSubdomain.mockClear();
  updateSubdomain.mockClear();
  origAdd = bindMod.addTxtRecord;
  origDel = bindMod.deleteTxtRecord;
  origFind = bindMod.findDnsRecord;
  bindMod.addTxtRecord = vi.fn(async (subdomain, domain, hostPrefix, value) => {
    txtWrites.push({ subdomain, hostPrefix, value });
    return { name: `${hostPrefix}.${domain}`, content: value };
  });
  bindMod.deleteTxtRecord = vi.fn(async (subdomain, domain, hostPrefix) => ({
    name: `${hostPrefix}.${domain}`,
    deleted: true,
  }));
  bindMod.findDnsRecord = vi.fn(async () => false);
});

afterEach(() => {
  bindMod.addTxtRecord = origAdd;
  bindMod.deleteTxtRecord = origDel;
  bindMod.findDnsRecord = origFind;
});

function restApp() {
  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });
  app.decorate("mysql", { execute: scriptedDb() });
  app.register(apiV1Routes, { prefix: "/api/v1" });
  return app;
}

function webApp() {
  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute: scriptedDb() });
  app.decorate("authenticate", async (request) => {
    request.user = { id: USER_ID };
  });
  app.register(domainRoutes, { prefix: "/api" });
  return app;
}

function mcpApp() {
  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute: scriptedDb() });
  // inject()'s socket has no destroySoon; the SDK's drain timer would throw
  // later in another file. See tests/unreachable-create.test.js.
  app.addHook("onRequest", async (request) => {
    const socket = request.raw.socket;
    if (socket && typeof socket.destroySoon !== "function") {
      socket.destroySoon = () => socket.destroy?.();
    }
  });
  app.register(mcpPlugin);
  return app;
}

/** Every MCP case gets its own address: the anonymous limiter allows 3 a minute per address. */
let nextAddress = 10;
function freshAddress() {
  nextAddress += 1;
  return `198.51.100.${nextAddress}`;
}

async function callTool(app, name, args, { key = null, from = freshAddress() } = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: from,
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

function restCreate(app, { subdomain = "demo", type = "A", value = "203.0.113.10", key = null, token = null, from = "203.0.113.9" } = {}) {
  const bearer = key || token;
  return app.inject({
    method: "POST",
    url: "/api/v1/subdomains",
    remoteAddress: from,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: { subdomain, domain: DOMAIN, type, value },
  });
}

function restTxt(app, { key = null, token = null, from = "203.0.113.9", hostPrefix = "_vercel" } = {}) {
  const bearer = key || token;
  return app.inject({
    method: "POST",
    url: `/api/v1/subdomains/demo/${DOMAIN}/txt`,
    remoteAddress: from,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: { host_prefix: hostPrefix, value: "vc-domain-verify=demo.example.com,abc" },
  });
}

// ===========================================================================
// 1. TXT needs an account
// ===========================================================================

describe("1 — anonymous TXT is refused with ACCOUNT_REQUIRED", () => {
  it("REST: no header at all", async () => {
    const app = restApp();
    const res = await restTxt(app);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ACCOUNT_REQUIRED");
    // and it says how to get one
    expect(res.json().message).toMatch(/API key/);
    expect(res.json().message).toMatch(/dashboard/);
    expect(txtWrites).toHaveLength(0);
    await app.close();
  });

  it("REST: holding an owner token is still not an account", async () => {
    const app = restApp();
    const res = await restTxt(app, { token: anonToken.generateToken().token });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ACCOUNT_REQUIRED");
    expect(txtWrites).toHaveLength(0);
    await app.close();
  });

  it("REST: an API key writes it, as before", async () => {
    const app = restApp();
    const res = await restTxt(app, { key: API_KEY });

    expect(res.statusCode).toBe(200);
    expect(txtWrites).toHaveLength(1);
    await app.close();
  });

  // Only adding is closed. An owner who already has one must be able to take
  // it away — that is the direction we want.
  it("REST: an anonymous owner can still delete one", async () => {
    const app = restApp();
    app.mysql.execute.mockImplementation(async (sql) => {
      if (sql.includes("FROM managed_domains")) return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
      if (sql.startsWith("SELECT id, record_type FROM subdomains")) return [[{ id: 42, record_type: "A" }]];
      if (sql.includes("FROM subdomain_txt_records")) return [[{ txt_value: "old" }]];
      return [{ affectedRows: 1 }];
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt/_vercel`,
      remoteAddress: "203.0.113.9",
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("MCP: no key", async () => {
    const app = mcpApp();
    const { isError, data } = await callTool(app, "create_txt_record", {
      subdomain: "demo", domain: DOMAIN, host_prefix: "_vercel", value: "token",
    });

    expect(isError).toBe(true);
    expect(data.code).toBe("ACCOUNT_REQUIRED");
    expect(data.error).toMatch(/API key/);
    expect(txtWrites).toHaveLength(0);
    await app.close();
  });

  it("MCP: an owner_token is not an account either", async () => {
    const app = mcpApp();
    const { data } = await callTool(app, "create_txt_record", {
      subdomain: "demo", domain: DOMAIN, host_prefix: "_vercel", value: "token",
      owner_token: anonToken.generateToken().token,
    });

    expect(data.code).toBe("ACCOUNT_REQUIRED");
    await app.close();
  });

  it("MCP: an API key writes it", async () => {
    const app = mcpApp();
    const { isError, data } = await callTool(
      app,
      "create_txt_record",
      { subdomain: "demo", domain: DOMAIN, host_prefix: "_vercel", value: "token" },
      { key: API_KEY }
    );

    expect(isError).toBe(false);
    expect(data.success).toBe(true);
    expect(txtWrites).toHaveLength(1);
    await app.close();
  });

  it("MCP: the tool says so before anybody calls it", async () => {
    const app = mcpApp();
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const line = res.body.split("\n").find((l) => l.startsWith("data: "));
    const tools = JSON.parse(line.slice("data: ".length)).result.tools;
    const txt = tools.find((t) => t.name === "create_txt_record");

    expect(txt.description).toMatch(/Needs an account/);
    expect(txt.description).toContain("ACCOUNT_REQUIRED");
    await app.close();
  });
});

// ===========================================================================
// 2. Temporary tunnels need an account
// ===========================================================================

describe("2 — anonymous CNAME/REDIRECT to a temporary tunnel", () => {
  it("knows a tunnel by whole labels, from config", () => {
    expect(config.abuse.anonTunnelDomains).toContain("trycloudflare.com");
    expect(isTunnelHost("x.trycloudflare.com")).toBe(true);
    expect(isTunnelHost("a.b.ngrok-free.app")).toBe(true);
    expect(isTunnelHost("trycloudflare.com.")).toBe(true);
    expect(isTunnelHost("nottrycloudflare.com")).toBe(false);
    expect(isTunnelHost("vercel.app")).toBe(false);
    // A has no host to judge
    expect(checkAnonTarget("A", "203.0.113.10").ok).toBe(true);
  });

  it("REST: REDIRECT to https://x.trycloudflare.com is refused", async () => {
    const app = restApp();
    const res = await restCreate(app, { type: "REDIRECT", value: "https://x.trycloudflare.com/login" });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TUNNEL_TARGET_FORBIDDEN");
    expect(createSubdomain).not.toHaveBeenCalled();
    await app.close();
  });

  it("REST: CNAME to x.trycloudflare.com is refused", async () => {
    const app = restApp();
    const res = await restCreate(app, { type: "CNAME", value: "x.trycloudflare.com" });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TUNNEL_TARGET_FORBIDDEN");
    await app.close();
  });

  it("REST: with an owner token it is still refused", async () => {
    const app = restApp();
    const res = await restCreate(app, {
      type: "CNAME", value: "abc.ngrok-free.app", token: anonToken.generateToken().token,
    });

    expect(res.json().code).toBe("TUNNEL_TARGET_FORBIDDEN");
    await app.close();
  });

  it("REST: moving an existing record onto a tunnel is refused too", async () => {
    const app = restApp();
    ownedType = "CNAME";
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      remoteAddress: "203.0.113.9",
      payload: { value: "x.trycloudflare.com" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TUNNEL_TARGET_FORBIDDEN");
    expect(updateSubdomain).not.toHaveBeenCalled();
    await app.close();
  });

  it("REST: an API key may (ordinary development)", async () => {
    const app = restApp();
    const redirect = await restCreate(app, {
      type: "REDIRECT", value: "https://x.trycloudflare.com", key: API_KEY,
    });
    const cname = await restCreate(app, {
      subdomain: "demo2", type: "CNAME", value: "x.trycloudflare.com", key: API_KEY,
    });

    expect(redirect.statusCode).toBe(201);
    expect(cname.statusCode).toBe(201);
    await app.close();
  });

  it("MCP: refused without a key, created with one", async () => {
    const app = mcpApp();
    const anon = await callTool(app, "create_subdomain", {
      subdomain: "demo", domain: DOMAIN, type: "REDIRECT", value: "https://x.trycloudflare.com",
    });
    const withKey = await callTool(
      app,
      "create_subdomain",
      { subdomain: "demo", domain: DOMAIN, type: "CNAME", value: "x.trycloudflare.com" },
      { key: API_KEY }
    );

    expect(anon.isError).toBe(true);
    expect(anon.data.code).toBe("TUNNEL_TARGET_FORBIDDEN");
    expect(withKey.isError).toBe(false);
    await app.close();
  });

  it("MCP: update_subdomain onto a tunnel is refused without a key", async () => {
    const app = mcpApp();
    ownedType = "CNAME";
    const { isError, data } = await callTool(app, "update_subdomain", {
      subdomain: "demo", domain: DOMAIN, value: "x.loca.lt",
    });

    expect(isError).toBe(true);
    expect(data.code).toBe("TUNNEL_TARGET_FORBIDDEN");
    expect(updateSubdomain).not.toHaveBeenCalled();
    await app.close();
  });
});

// ===========================================================================
// 3. Phishing names, in two layers
// ===========================================================================

describe("3 — brand names for everyone, phishing words without an account", () => {
  it("layers: brand → all, word → anonymous only, reserved as before", () => {
    expect(isBlacklisted("toss-login").code).toBe("BLACKLISTED");
    expect(isBlacklisted("toss-login", { anonymous: true }).code).toBe("BLACKLISTED");
    expect(isBlacklisted("login-demo").blocked).toBe(false);
    expect(isBlacklisted("login-demo", { anonymous: true }).code).toBe("ACCOUNT_REQUIRED");
    expect(isBlacklisted("my-wallet", { anonymous: true }).code).toBe("ACCOUNT_REQUIRED");
    expect(isBlacklisted("admin").code).toBe("BLACKLISTED");
    expect(isBlacklisted("demo", { anonymous: true }).blocked).toBe(false);
    // the seven that blocked everyone before 2026-10-07 still do
    for (const old of ["paypal", "google-login", "facebook-auth", "bank", "secure-login", "signin", "account-verify"]) {
      expect(isBlacklisted(`x-${old}`).blocked, old).toBe(true);
    }
  });

  it("REST: toss-login is refused with and without a key", async () => {
    const app = restApp();
    const anon = await restCreate(app, { subdomain: "toss-login" });
    const keyed = await restCreate(app, { subdomain: "toss-login", key: API_KEY });

    expect(anon.statusCode).toBe(400);
    expect(anon.json().code).toBe("BLACKLISTED");
    expect(keyed.statusCode).toBe(400);
    expect(keyed.json().code).toBe("BLACKLISTED");
    expect(createSubdomain).not.toHaveBeenCalled();
    await app.close();
  });

  it("REST: login-demo is refused anonymously and created with a key", async () => {
    const app = restApp();
    const anon = await restCreate(app, { subdomain: "login-demo" });
    const keyed = await restCreate(app, { subdomain: "login-demo", key: API_KEY });

    expect(anon.statusCode).toBe(403);
    expect(anon.json().code).toBe("ACCOUNT_REQUIRED");
    expect(anon.json().message).toMatch(/API key/);
    expect(keyed.statusCode).toBe(201);
    await app.close();
  });

  it("MCP: the same two answers", async () => {
    const app = mcpApp();
    const brand = await callTool(
      app, "create_subdomain",
      { subdomain: "toss-login", domain: DOMAIN, type: "A", value: "203.0.113.10" },
      { key: API_KEY }
    );
    const word = await callTool(app, "create_subdomain", {
      subdomain: "login-demo", domain: DOMAIN, type: "A", value: "203.0.113.10",
    });
    const wordWithKey = await callTool(
      app, "create_subdomain",
      { subdomain: "login-demo", domain: DOMAIN, type: "A", value: "203.0.113.10" },
      { key: API_KEY }
    );

    expect(brand.data.code).toBe("BLACKLISTED");
    expect(word.data.code).toBe("ACCOUNT_REQUIRED");
    expect(wordWithKey.isError).toBe(false);
    await app.close();
  });

  it("dashboard: an account may take login-demo, not toss-login", async () => {
    const app = webApp();
    const word = await app.inject({
      method: "POST", url: "/api/subdomains",
      payload: { subdomain: "login-demo", domain: DOMAIN, recordType: "A", value: "203.0.113.10" },
    });
    const brand = await app.inject({
      method: "POST", url: "/api/subdomains",
      payload: { subdomain: "toss-login", domain: DOMAIN, recordType: "A", value: "203.0.113.10" },
    });

    expect(word.statusCode).toBe(201);
    expect(brand.statusCode).toBe(400);
    await app.close();
  });
});

// ===========================================================================
// 4. The blocklist
// ===========================================================================

describe("4 — a blocklisted name, token or address is refused", () => {
  it("REST: by name, including the name with something added", async () => {
    blocklist = [{ kind: "name", value: "catikteam" }];
    const app = restApp();
    const exact = await restCreate(app, { subdomain: "catikteam" });
    const added = await restCreate(app, { subdomain: "catikteam2", key: API_KEY });

    expect(exact.statusCode).toBe(403);
    expect(exact.json().code).toBe("BLOCKED");
    expect(added.json().code).toBe("BLOCKED");
    expect(createSubdomain).not.toHaveBeenCalled();
    // it does not say which of the three matched
    expect(exact.json().message).not.toMatch(/name|token|address|ip/i);
    await app.close();
  });

  it("REST: by owner token, from any address", async () => {
    const { token, hash } = anonToken.generateToken();
    blocklist = [{ kind: "token", value: hash }];
    const app = restApp();
    const res = await restCreate(app, { token, from: "192.0.2.200" });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("BLOCKED");
    await app.close();
  });

  it("REST: by address — the seeded ones, with or without a key", async () => {
    blocklist = [
      { kind: "ip", value: "31.76.1.17" },
      { kind: "ip", value: "94.156.115.193" },
    ];
    const app = restApp();
    const anon = await restCreate(app, { from: "94.156.115.193" });
    const keyed = await restCreate(app, { from: "31.76.1.17", key: API_KEY });
    const clean = await restCreate(app, { from: "203.0.113.50" });

    expect(anon.json().code).toBe("BLOCKED");
    expect(keyed.json().code).toBe("BLOCKED");
    expect(clean.statusCode).toBe(201);
    await app.close();
  });

  it("REST: on a value change and on a TXT write as well", async () => {
    blocklist = [{ kind: "ip", value: "31.76.1.17" }];
    const app = restApp();
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      remoteAddress: "31.76.1.17",
      payload: { value: "203.0.113.11" },
    });
    const txt = await restTxt(app, { key: API_KEY, from: "31.76.1.17" });

    expect(patch.json().code).toBe("BLOCKED");
    expect(txt.json().code).toBe("BLOCKED");
    expect(updateSubdomain).not.toHaveBeenCalled();
    expect(txtWrites).toHaveLength(0);
    await app.close();
  });

  it("MCP: create, update and TXT", async () => {
    blocklist = [{ kind: "ip", value: "31.76.1.17" }];
    const app = mcpApp();
    const create = await callTool(
      app, "create_subdomain",
      { subdomain: "demo", domain: DOMAIN, type: "A", value: "203.0.113.10" },
      { from: "31.76.1.17" }
    );
    const update = await callTool(
      app, "update_subdomain",
      { subdomain: "demo", domain: DOMAIN, value: "203.0.113.11" },
      { from: "31.76.1.17" }
    );
    const txt = await callTool(
      app, "create_txt_record",
      { subdomain: "demo", domain: DOMAIN, host_prefix: "_vercel", value: "t" },
      { from: "31.76.1.17", key: API_KEY }
    );

    expect(create.data.code).toBe("BLOCKED");
    expect(update.data.code).toBe("BLOCKED");
    expect(txt.data.code).toBe("BLOCKED");
    expect(createSubdomain).not.toHaveBeenCalled();
    expect(txtWrites).toHaveLength(0);
    await app.close();
  });

  it("dashboard: create, update and TXT by name", async () => {
    blocklist = [{ kind: "name", value: "catikteam" }];
    const app = webApp();
    const create = await app.inject({
      method: "POST", url: "/api/subdomains",
      payload: { subdomain: "catikteam", domain: DOMAIN, recordType: "A", value: "203.0.113.10" },
    });
    const update = await app.inject({
      method: "PUT", url: "/api/subdomains/catikteam",
      payload: { domain: DOMAIN, value: "203.0.113.11" },
    });
    const txt = await app.inject({
      method: "POST", url: "/api/subdomains/catikteam/txt",
      payload: { domain: DOMAIN, txtValue: "x", hostPrefix: "@" },
    });

    expect(create.statusCode).toBe(403);
    expect(update.statusCode).toBe(403);
    expect(txt.statusCode).toBe(403);
    expect(create.json().code).toBe("BLOCKED");
    expect(createSubdomain).not.toHaveBeenCalled();
    expect(updateSubdomain).not.toHaveBeenCalled();
    expect(txtWrites).toHaveLength(0);
    await app.close();
  });

  it("the migration seeds catikteam and both addresses", () => {
    const fs = require2("fs");
    const path = require2("path");
    const sql = fs.readFileSync(
      path.join(__dirname, "..", "deploy", "migrations", "010-blocklist-abuse-reports.sql"),
      "utf8"
    );
    expect(sql).toMatch(/\('name',\s*'catikteam'/);
    expect(sql).toMatch(/\('ip',\s*'31\.76\.1\.17'/);
    expect(sql).toMatch(/\('ip',\s*'94\.156\.115\.193'/);
  });
});

// The check SQL for item 3 is generated from the lists; if a list changes and
// the file does not, the number Jarvis reads off production is about a list
// that no longer exists.
describe("3 — scripts/010-blacklist-hits.sql follows the lists", () => {
  it("carries both lists as they are in services/blacklist.js", () => {
    const fs = require2("fs");
    const path = require2("path");
    const { BRAND_KEYWORDS, ANON_KEYWORDS } = require2("../services/blacklist.js");
    const sql = fs.readFileSync(path.join(__dirname, "..", "scripts", "010-blacklist-hits.sql"), "utf8");

    expect(sql).toContain(`'${BRAND_KEYWORDS.join("|")}'`);
    expect(sql).toContain(`'${ANON_KEYWORDS.join("|")}'`);
  });
});
