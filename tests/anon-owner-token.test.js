import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Who owns a record made without an account.
//
// It used to be the client IP, and the case that matters is not the agent
// whose address moved — it is two strangers whose addresses are the same. A
// company, a school and a mobile carrier all put unrelated callers behind one
// exit address, and every one of them could list, repoint and delete the
// others' records. Nobody had to attack anything; it was the ordinary result
// of sharing a network.
//
// So the tests below are about three things at once, and the third is the one
// that can be broken silently by a well-meaning change:
//
//   1. creating still works with no account, no key, and nothing fetched first
//   2. a token reaches its own records from anywhere
//   3. 🔴 nothing else reaches them, however familiar its address looks
//
// Plus the fourth that has no glory in it: the 41 records that predate tokens
// are still proved by the address that made them, because their owners have
// nothing else and taking them away would be the same bug pointed inwards.
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
const TOKEN_SHAPE = /^anon_[0-9a-f]{32}$/;

/** The subdomains table, as far as these cases are concerned. */
const store = { rows: [], nextId: 1 };

const stubbed = [
  stub("../services/subdomain.js", {
    createSubdomain: vi.fn(async (fastify, p) => {
      const row = {
        id: store.nextId++,
        subdomain: p.subdomain,
        domain_id: p.domainId,
        record_type: p.recordType,
        record_value: p.recordValue,
        user_id: p.userId ?? null,
        owner_type: p.ownerType,
        owner_ip: p.ownerIp ?? null,
        owner_token_hash: p.ownerTokenHash ?? null,
        created_at: new Date("2026-09-15T00:00:00Z"),
        expires_at: new Date("2026-10-15T00:00:00Z"),
      };
      store.rows.push(row);
      return { name: `${p.subdomain}.${p.domain}`, type: p.recordType, expiresAt: row.expires_at };
    }),
    updateSubdomain: vi.fn(async () => {}),
    deleteSubdomain: vi.fn(async (fastify, { recordId }) => {
      store.rows = store.rows.filter((r) => r.id !== recordId);
    }),
  }),
  // The real one asks the target for an HTTP response. Reachability decides
  // nothing on create (tests/unreachable-create.test.js owns that), so the stub
  // just says the target answered.
  stub("../services/validation.js", {
    noteReachability: vi.fn(async () => ({
      ok: true, check: "https", status: 200, detail: "https 200", note: null,
    })),
    setLogger: () => {},
  }),
];

const anonToken = require2("../services/anon-token.js");
const Fastify = require2("fastify");
const config = require2("../configs/index.js");

// ---------------------------------------------------------------------------
// A MySQL that knows what a row is.
//
// It reads the ownership predicate out of the SQL rather than being told which
// case it is in, which is the whole reason it is written this way: if the
// `owner_token_hash IS NULL` guard ever falls out of
// services/anon-token.js, this fake stops applying it too, and the NAT cases
// below go red instead of quietly passing.
// ---------------------------------------------------------------------------

function ownerMatches(sql, ownerParams, row) {
  if (/user_id = \?/.test(sql)) return row.user_id === ownerParams[0];
  if (/owner_token_hash = \?/.test(sql)) {
    return row.owner_token_hash === ownerParams[0] && row.owner_type === "agent";
  }
  const sameAddress = row.owner_ip === ownerParams[0] && row.owner_type === "agent";
  return /owner_token_hash IS NULL/.test(sql)
    ? sameAddress && row.owner_token_hash === null
    : sameAddress;
}

function scriptedDb() {
  return vi.fn(async (sql, params = []) => {
    if (sql.includes("FROM managed_domains")) {
      return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    }
    if (sql.includes("FROM api_keys ak JOIN users u")) {
      return [[{ key_id: 1, user_id: 7, email: "a@example.com", name: "A" }]];
    }
    if (sql.startsWith("UPDATE api_keys")) return [[]];
    if (sql.includes("subdomain_limit FROM users")) return [[{ subdomain_limit: null }]];
    if (sql.includes("FROM credit_entries")) return [[{ total: 0 }]];

    if (sql.includes("COUNT(*) AS held FROM subdomains")) {
      const held = store.rows.filter((row) => ownerMatches(sql, params, row)).length;
      return [[{ held }]];
    }
    if (sql.startsWith("SELECT id, record_type FROM subdomains")) {
      const [subdomain, domainId, ...owner] = params;
      return [
        store.rows
          .filter(
            (row) =>
              row.subdomain === subdomain &&
              row.domain_id === domainId &&
              ownerMatches(sql, owner, row)
          )
          .map((row) => ({ id: row.id, record_type: row.record_type })),
      ];
    }
    if (sql.includes("FROM subdomains s JOIN managed_domains")) {
      return [
        store.rows
          .filter((row) => ownerMatches(sql, params, row))
          .map((row) => ({
            subdomain: row.subdomain,
            domain: DOMAIN,
            type: row.record_type,
            value: row.record_value,
            created_at: row.created_at,
            expires_at: row.expires_at,
          })),
      ];
    }
    if (sql.includes("FROM subdomain_txt_records")) return [[]];
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

/** Put a record in the table directly, without going through a route. */
function seed(row) {
  const full = {
    id: store.nextId++,
    domain_id: DOMAIN_ID,
    record_type: "A",
    record_value: "203.0.113.10",
    user_id: null,
    owner_type: "agent",
    owner_ip: null,
    owner_token_hash: null,
    created_at: new Date("2026-08-01T00:00:00Z"),
    expires_at: new Date("2026-10-15T00:00:00Z"),
    ...row,
  };
  store.rows.push(full);
  return full;
}

beforeEach(() => {
  store.rows = [];
  store.nextId = 1;
});

afterAll(() => {
  for (const filename of stubbed) delete require2.cache[filename];
});

// ===========================================================================
// REST — the token travels in the Authorization header
// ===========================================================================

const apiV1Routes = require2("../routes/api-v1.js");

function restApp() {
  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });
  app.decorate("mysql", { execute: scriptedDb() });
  app.register(apiV1Routes, { prefix: "/api/v1" });
  return app;
}

/** @param token pass null for a caller presenting nothing at all */
function auth(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function create(app, { from, token = null, subdomain = "demo" }) {
  return app.inject({
    method: "POST",
    url: "/api/v1/subdomains",
    remoteAddress: from,
    headers: { ...auth(token) },
    payload: { subdomain, domain: DOMAIN, type: "A", value: "203.0.113.10" },
  });
}

describe("REST: creating with nothing at all", () => {
  // 🔴 The one that must never go red. If holding a token ever becomes a
  // precondition for creating, the token has to be fetched, fetching means a
  // signup page and a signup page means a person — and an agent working alone
  // stops at the door, which is the only reason anybody picks this service
  // over the ones in the registry that ask for a key first.
  it("succeeds with no account, no key and no token", async () => {
    const app = restApp();

    const res = await create(app, { from: "198.51.100.1" });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.fqdn).toBe(`demo.${DOMAIN}`);
    await app.close();
  });

  it("hands back a token, once, and says it cannot be fetched again", async () => {
    const app = restApp();

    const first = await create(app, { from: "198.51.100.1", subdomain: "one" });
    const token = first.json().data.owner_token;

    expect(token).toMatch(TOKEN_SHAPE);
    expect(first.json().data.owner_token_note).toMatch(/shown once/i);

    // The second create presents it, so there is nothing new to hand over —
    // a token in every response would be a different token every time.
    const second = await create(app, {
      from: "198.51.100.1", token, subdomain: "two",
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().data.owner_token).toBeUndefined();
    await app.close();
  });

  it("stores the hash and never the token", async () => {
    const app = restApp();

    const token = (await create(app, { from: "198.51.100.1" })).json().data.owner_token;

    expect(store.rows[0].owner_token_hash).toBe(anonToken.hashToken(token));
    expect(JSON.stringify(store.rows)).not.toContain(token);
    await app.close();
  });
});

describe("REST: the token is the owner, the address is not", () => {
  it("reaches its own records from an address it has never used", async () => {
    const app = restApp();
    const token = (await create(app, { from: "198.51.100.1" })).json().data.owner_token;

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      remoteAddress: "203.0.113.77", // a different network entirely
      headers: auth(token),
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      remoteAddress: "203.0.113.77",
      headers: auth(token),
    });

    expect(listed.json().data.subdomains.map((s) => s.subdomain)).toEqual(["demo"]);
    expect(deleted.statusCode).toBe(200);
    expect(store.rows).toHaveLength(0);
    await app.close();
  });

  // 🔴 The bug this whole change is for. Both callers are behind one NAT, so
  // `request.ip` is identical and always was — the only thing telling them
  // apart is what they hold.
  it("keeps a stranger on the same address out, token or no token", async () => {
    const app = restApp();
    const SHARED = "198.51.100.1";

    const mine = (await create(app, { from: SHARED })).json().data.owner_token;
    const theirs = anonToken.generateToken().token;

    const withOtherToken = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      remoteAddress: SHARED,
      headers: auth(theirs),
    });
    // And the plain case: somebody who simply sends nothing, which is what a
    // second agent behind the same router looks like.
    const withNothing = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      remoteAddress: SHARED,
    });
    const listedByAddress = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      remoteAddress: SHARED,
    });

    expect(withOtherToken.statusCode).toBe(403);
    expect(withNothing.statusCode).toBe(403);
    // Not even visible: a listing that showed it would be a way to find out
    // what the neighbours hold.
    expect(listedByAddress.json().data.subdomains).toEqual([]);
    expect(store.rows).toHaveLength(1);

    // The owner is unaffected by any of it.
    const own = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      remoteAddress: SHARED,
      headers: auth(mine),
    });
    expect(own.statusCode).toBe(200);
    await app.close();
  });

  // The 41 rows that were here first. They have no token and never will —
  // one could only be invented by writing a hash nobody would ever be told,
  // which is locking somebody out of their own record and calling it a
  // migration. The address still proves them.
  it("still lets the address prove a record made before tokens existed", async () => {
    const app = restApp();
    const OLD = "198.51.100.9";
    seed({ subdomain: "legacy", owner_ip: OLD, owner_token_hash: null });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      remoteAddress: OLD,
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/legacy/${DOMAIN}`,
      remoteAddress: OLD,
    });

    expect(listed.json().data.subdomains.map((s) => s.subdomain)).toEqual(["legacy"]);
    expect(deleted.statusCode).toBe(200);
    await app.close();
  });

  it("refuses a mistyped token instead of quietly demoting it to the address", async () => {
    const app = restApp();
    const OLD = "198.51.100.9";
    seed({ subdomain: "legacy", owner_ip: OLD, owner_token_hash: null });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      remoteAddress: OLD,
      headers: auth("anon_deadbeef"), // right prefix, wrong shape
    });

    // Falling back to the address here would be worse than it looks: the
    // caller would silently be somebody else for that request.
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("leaves the API key path exactly as it was", async () => {
    const app = restApp();
    seed({ subdomain: "mine", user_id: 7, owner_type: "user" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      headers: auth("styo_0123456789abcdef0123456789abcdef"),
    });

    expect(res.json().data.subdomains.map((s) => s.subdomain)).toEqual(["mine"]);
    await app.close();
  });
});

describe("REST: the allowance follows the token", () => {
  const LIMIT = config.quota.subdomainLimit;
  const SHARED = "198.51.100.1";

  it("does not let one token spend another's, even on one address", async () => {
    const app = restApp();
    const full = anonToken.generateToken();
    const spare = anonToken.generateToken();

    for (let i = 0; i < LIMIT; i++) {
      seed({ subdomain: `full${i}`, owner_ip: SHARED, owner_token_hash: full.hash });
    }
    seed({ subdomain: "spare0", owner_ip: SHARED, owner_token_hash: spare.hash });

    const refused = await create(app, { from: SHARED, token: full.token, subdomain: "more" });
    const allowed = await create(app, { from: SHARED, token: spare.token, subdomain: "another" });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("LIMIT_REACHED");
    expect(refused.json().message).toMatch(/owner token/i);
    // The address is holding LIMIT + 1 by now and it makes no difference to a
    // caller that is not the one who put them there.
    expect(allowed.statusCode).toBe(201);
    await app.close();
  });

  // 🔴 The other half of the same rule, and the one that keeps it honest: a
  // token is free to invent, so if a brand-new one had an allowance of its
  // own, the anonymous ceiling would bound nothing at all. One that owns
  // nothing yet is counted against the address it arrived from.
  it("does not let a freshly invented token reset the ceiling", async () => {
    const app = restApp();
    const held = anonToken.generateToken();
    for (let i = 0; i < LIMIT; i++) {
      seed({ subdomain: `held${i}`, owner_ip: SHARED, owner_token_hash: held.hash });
    }

    const madeUp = anonToken.generateToken().token;
    const res = await create(app, { from: SHARED, token: madeUp, subdomain: "sneak" });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("LIMIT_REACHED");

    // Nor does presenting nothing, which is the same trick with less typing.
    const bare = await create(app, { from: SHARED, subdomain: "sneak2" });
    expect(bare.statusCode).toBe(403);
    await app.close();
  });
});

// ===========================================================================
// MCP — the token travels as a tool argument
//
// One HTTP POST may carry a batch of JSON-RPC calls, so there is nowhere to
// hang a per-call header; the argument is the delivery path.
// ===========================================================================

const LIMITER = "../services/anon-create-rate.js";
const PLUGIN = "../plugins/mcp.js";

let limiter;

beforeEach(() => {
  // The plugin goes with the limiter, so the app built below closes over the
  // same fresh module this file is holding.
  for (const spec of [LIMITER, PLUGIN]) delete require2.cache[require2.resolve(spec)];
  limiter = require2(LIMITER);
});

afterEach(() => {
  for (const spec of [LIMITER, PLUGIN]) delete require2.cache[require2.resolve(spec)];
});

function mcpApp() {
  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });
  app.decorate("mysql", { execute: scriptedDb() });
  // The MCP SDK arms a timer to force the socket shut if draining the body
  // never finishes, and inject()'s socket has no destroySoon. Nothing to do
  // with the code under test — see tests/anon-create-rate.test.js.
  app.addHook("onRequest", async (request) => {
    const socket = request.raw.socket;
    if (socket && typeof socket.destroySoon !== "function") {
      socket.destroySoon = () => socket.destroy?.();
    }
  });
  app.register(require2(PLUGIN));
  return app;
}

/** One tool call over the streamable-HTTP transport. */
async function callTool(app, { name, args, from, apiKey = null }) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: from,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });

  const line = res.body.split("\n").find((l) => l.startsWith("data: "));
  const result = JSON.parse(line.slice("data: ".length)).result;
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

function mcpCreate(app, { from, token, subdomain = "demo" }) {
  return callTool(app, {
    name: "create_subdomain",
    from,
    args: {
      subdomain, domain: DOMAIN, type: "A", value: "203.0.113.10",
      ...(token ? { owner_token: token } : {}),
    },
  });
}

describe("MCP: the same three rules, through tool arguments", () => {
  it("creates with no arguments beyond the record, and returns a token once", async () => {
    const app = mcpApp();

    const created = await mcpCreate(app, { from: "198.51.100.1" });

    expect(created.isError).toBe(false);
    expect(created.data.owner_token).toMatch(TOKEN_SHAPE);
    expect(created.data.owner_token_note).toMatch(/shown once/i);

    const again = await mcpCreate(app, {
      from: "198.51.100.1", token: created.data.owner_token, subdomain: "two",
    });
    expect(again.data.owner_token).toBeUndefined();
    await app.close();
  });

  it("lists and deletes its own records from a different address", async () => {
    const app = mcpApp();
    const token = (await mcpCreate(app, { from: "198.51.100.1" })).data.owner_token;

    const listed = await callTool(app, {
      name: "list_subdomains", from: "203.0.113.77", args: { owner_token: token },
    });
    const deleted = await callTool(app, {
      name: "delete_subdomain",
      from: "203.0.113.77",
      args: { subdomain: "demo", domain: DOMAIN, owner_token: token },
    });

    expect(listed.data.subdomains.map((s) => s.subdomain)).toEqual(["demo"]);
    expect(deleted.isError).toBe(false);
    expect(store.rows).toHaveLength(0);
    await app.close();
  });

  // 🔴 The same NAT case as over REST. update_subdomain is the tool that used
  // to answer "If your IP has changed, sign up at sitey.my to manage it" —
  // which was the service admitting, in a string, that it had the wrong owner.
  it("keeps a stranger on the same address out", async () => {
    const app = mcpApp();
    const SHARED = "198.51.100.1";
    await mcpCreate(app, { from: SHARED });
    const theirs = anonToken.generateToken().token;

    const repoint = await callTool(app, {
      name: "update_subdomain",
      from: SHARED,
      args: { subdomain: "demo", domain: DOMAIN, value: "203.0.113.99", owner_token: theirs },
    });
    const bare = await callTool(app, {
      name: "delete_subdomain",
      from: SHARED,
      args: { subdomain: "demo", domain: DOMAIN },
    });
    const listed = await callTool(app, { name: "list_subdomains", from: SHARED, args: {} });

    expect(repoint.isError).toBe(true);
    expect(repoint.data.error).toMatch(/not found/i);
    // 🔴 And it must not tell them to go and sign up: that was advice for a
    // person who had lost an address, and it is now the wrong diagnosis too.
    expect(repoint.data.error).not.toMatch(/sign up/i);
    expect(bare.isError).toBe(true);
    expect(listed.data.subdomains).toEqual([]);
    expect(store.rows).toHaveLength(1);
    await app.close();
  });

  it("still lets the address prove a record made before tokens existed", async () => {
    const app = mcpApp();
    const OLD = "198.51.100.9";
    seed({ subdomain: "legacy", owner_ip: OLD });

    const listed = await callTool(app, { name: "list_subdomains", from: OLD, args: {} });
    const renamed = await callTool(app, {
      name: "update_subdomain",
      from: OLD,
      args: { subdomain: "legacy", domain: DOMAIN, value: "203.0.113.55" },
    });

    expect(listed.data.subdomains.map((s) => s.subdomain)).toEqual(["legacy"]);
    expect(renamed.isError).toBe(false);
    await app.close();
  });

  it("refuses a mistyped token rather than treating it as absent", async () => {
    const app = mcpApp();

    const res = await mcpCreate(app, { from: "198.51.100.1", token: "anon_nope" });

    expect(res.isError).toBe(true);
    expect(res.data.error).toMatch(/owner_token/);
    expect(store.rows).toHaveLength(0);
    await app.close();
  });

  it("refuses an API key and a token together rather than picking one", async () => {
    const app = mcpApp();

    const res = await callTool(app, {
      name: "list_subdomains",
      from: "198.51.100.1",
      apiKey: "styo_0123456789abcdef0123456789abcdef",
      args: { owner_token: anonToken.generateToken().token },
    });

    expect(res.isError).toBe(true);
    expect(res.data.error).toMatch(/two different owners/i);
    await app.close();
  });
});

describe("MCP: the create limiter counts per token", () => {
  // Same address throughout: before tokens, these two callers shared one
  // bucket of three a minute, so whichever asked first spent the other's.
  const SHARED = "198.51.100.1";

  it("gives two tokens on one address their own allowances", async () => {
    const app = mcpApp();
    const mine = anonToken.generateToken().token;
    const theirs = anonToken.generateToken().token;

    for (let i = 0; i < limiter.MAX_PER_WINDOW; i++) {
      expect((await mcpCreate(app, { from: SHARED, token: mine, subdomain: `a${i}` })).isError)
        .toBe(false);
    }
    const spent = await mcpCreate(app, { from: SHARED, token: mine, subdomain: "a9" });
    const stranger = await mcpCreate(app, { from: SHARED, token: theirs, subdomain: "b0" });

    expect(spent.isError).toBe(true);
    expect(spent.data.error).toMatch(/Too many anonymous create requests/);
    expect(stranger.isError).toBe(false);
    await app.close();
  });

  // A caller with no token is still counted by address, which is what the
  // rows that predate tokens — and every first call — rely on.
  it("still counts a caller with no token by its address", async () => {
    const app = mcpApp();

    for (let i = 0; i < limiter.MAX_PER_WINDOW; i++) {
      expect((await mcpCreate(app, { from: SHARED, subdomain: `c${i}` })).isError).toBe(false);
    }
    const spent = await mcpCreate(app, { from: SHARED, subdomain: "c9" });
    const elsewhere = await mcpCreate(app, { from: "198.51.100.2", subdomain: "d0" });

    expect(spent.isError).toBe(true);
    expect(elsewhere.isError).toBe(false);
    await app.close();
  });
});
