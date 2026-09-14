import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// A name you cannot get until the thing it points at already exists.
//
// Create and update asked the target for an HTTP response and refused the
// record when nothing answered. That makes "get the address, then deploy to
// it" impossible, which is the order an agent works in — and the order a
// person works in too, when the host they are about to use wants the DNS
// record before it will serve anything.
//
// The check is not the problem and is still run. What changed is what its
// verdict is used for: it is written down and handed back to the caller
// instead of closing the door. Three other things already cover an abandoned
// name — the nightly check and its notice, the lease, and the limit.
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
const DARK = "203.0.113.10";

/** What the probe will say. The default is the case this file is about. */
let probeAnswer = {
  ok: false,
  status: null,
  check: "https",
  detail: "https failed: ECONNREFUSED",
};

const probeHost = vi.fn(async () => probeAnswer);
const createSubdomain = vi.fn(async () => ({
  name: `demo.${DOMAIN}`,
  type: "A",
  expiresAt: new Date("2026-12-14T00:00:00Z"),
}));
const updateSubdomain = vi.fn(async () => {});
const deleteSubdomain = vi.fn(async () => {});

const stubbed = [
  stub("../services/reachability.js", {
    DEAD_STATUSES: new Set([502, 503, 504]),
    isAliveStatus: (status) => ![502, 503, 504].includes(status),
    probeOrigin: vi.fn(),
    probeHost,
  }),
  stub("../services/subdomain.js", { createSubdomain, updateSubdomain, deleteSubdomain }),
];

// Everything downstream of the two stubs has to be re-read, or it keeps the
// modules it closed over at first import.
for (const spec of [
  "../services/validation.js",
  "../routes/domain.js",
  "../routes/api-v1.js",
  "../plugins/mcp.js",
]) {
  delete require2.cache[require2.resolve(spec)];
}

const Fastify = require2("fastify");
const config = require2("../configs/index.js");
const domainRoutes = require2("../routes/domain.js");
const apiV1Routes = require2("../routes/api-v1.js");
const mcpPlugin = require2("../plugins/mcp.js");
const bindMod = require2("../services/bind.js");
const { probeRecord, handleValidationResult } = require2("../services/validation.js");

afterAll(() => {
  for (const filename of stubbed) delete require2.cache[filename];
});

beforeEach(() => {
  probeAnswer = { ok: false, status: null, check: "https", detail: "https failed: ECONNREFUSED" };
  probeHost.mockClear();
  createSubdomain.mockClear();
  updateSubdomain.mockClear();
  deleteSubdomain.mockClear();
});

/** A MySQL that answers the handful of questions these routes ask. */
function scriptedDb({ existingTxt = [] } = {}) {
  return vi.fn(async (sql) => {
    if (sql.includes("FROM managed_domains")) return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    if (sql.includes("COUNT(*) AS cnt FROM subdomains")) return [[{ cnt: 0 }]];
    // ownership lookups, for the update paths
    if (/^SELECT (s\.id, s\.record_type|id, record_type)/.test(sql)) {
      return [[{ id: 42, record_type: "A" }]];
    }
    if (sql.includes("FROM subdomain_txt_records")) return [existingTxt];
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

/** The browser-facing routes, with the auth guard already satisfied. */
function webApp() {
  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute: scriptedDb() });
  app.decorate("authenticate", async (request) => {
    request.user = { id: USER_ID };
  });
  app.register(domainRoutes, { prefix: "/api" });
  return app;
}

function restApp() {
  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });
  app.decorate("mysql", { execute: scriptedDb() });
  app.register(apiV1Routes, { prefix: "/api/v1" });
  return app;
}

function mcpApp() {
  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute: scriptedDb() });
  // The MCP SDK drains the request body and arms a timer to force the socket
  // shut if the drain never finishes. inject()'s socket is a stand-in and has
  // no destroySoon, so that timer throws minutes later, in whichever file
  // happens to be running. Nothing to do with the code under test.
  app.addHook("onRequest", async (request) => {
    const socket = request.raw.socket;
    if (socket && typeof socket.destroySoon !== "function") {
      socket.destroySoon = () => socket.destroy?.();
    }
  });
  app.register(mcpPlugin);
  return app;
}

/**
 * One JSON-RPC call over the streamable-HTTP transport, unwrapped.
 *
 * ⚠️ plugins/mcp.js allows an anonymous caller three creates a minute and the
 * counter is module-level, so it is shared by every test in this file. Three
 * create_subdomain calls is the ceiling; a fourth fails on the rate limit and
 * not on anything this file is about.
 */
async function callTool(app, name, args) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });

  const line = res.body.split("\n").find((l) => l.startsWith("data: "));
  const message = JSON.parse(line.slice("data: ".length));
  const result = message.result;
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

// ---------------------------------------------------------------------------
// 1. The name is issued
// ---------------------------------------------------------------------------

describe("creating a record whose target does not answer", () => {
  it("succeeds on the web route", async () => {
    const app = webApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/subdomains",
      payload: { subdomain: "demo", domain: DOMAIN, recordType: "A", value: DARK },
    });

    expect(res.statusCode).toBe(201);
    expect(createSubdomain).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("succeeds on the REST API", async () => {
    const app = restApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/subdomains",
      payload: { subdomain: "demo", domain: DOMAIN, type: "A", value: DARK },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.fqdn).toBe(`demo.${DOMAIN}`);
    await app.close();
  });

  it("succeeds over MCP", async () => {
    const app = mcpApp();

    const { isError, data } = await callTool(app, "create_subdomain", {
      subdomain: "demo", domain: DOMAIN, type: "A", value: DARK,
    });

    expect(isError).toBe(false);
    expect(data.fullSubdomain).toBe(`demo.${DOMAIN}`);
    await app.close();
  });

  // The check is the reason this is not simply "validation removed": it still
  // runs, on every one of the three, and its verdict is what the next block
  // hands back.
  it("still asks the target, on all three", async () => {
    for (const build of [webApp, restApp]) {
      probeHost.mockClear();
      const app = build();
      await app.inject({
        method: "POST",
        url: build === webApp ? "/api/subdomains" : "/api/v1/subdomains",
        payload: build === webApp
          ? { subdomain: "demo", domain: DOMAIN, recordType: "A", value: DARK }
          : { subdomain: "demo", domain: DOMAIN, type: "A", value: DARK },
      });
      expect(probeHost).toHaveBeenCalledTimes(1);
      await app.close();
    }

    probeHost.mockClear();
    const app = mcpApp();
    await callTool(app, "create_subdomain", {
      subdomain: "demo", domain: DOMAIN, type: "A", value: DARK,
    });
    expect(probeHost).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 2. …and the caller is told it points at nothing
// ---------------------------------------------------------------------------

describe("the answer says nothing is there yet", () => {
  it("marks the web response unreachable and says why", async () => {
    const app = webApp();

    const body = (await app.inject({
      method: "POST",
      url: "/api/subdomains",
      payload: { subdomain: "demo", domain: DOMAIN, recordType: "A", value: DARK },
    })).json();

    expect(body.reachable).toBe(false);
    expect(body.note).toContain(DARK);
    // the fields the dashboard already reads are untouched
    expect(body).toMatchObject({
      success: true,
      domain: `demo.${DOMAIN}`,
      value: DARK,
      recordType: "A",
    });
    await app.close();
  });

  it("marks the REST response unreachable and says why", async () => {
    const app = restApp();

    const { data } = (await app.inject({
      method: "POST",
      url: "/api/v1/subdomains",
      payload: { subdomain: "demo", domain: DOMAIN, type: "A", value: DARK },
    })).json();

    expect(data.reachable).toBe(false);
    expect(data.note).toContain(DARK);
    expect(data.expires_at).toBeTruthy();
    await app.close();
  });

  it("marks the MCP result unreachable and says why", async () => {
    const app = mcpApp();

    const { data } = await callTool(app, "create_subdomain", {
      subdomain: "demo", domain: DOMAIN, type: "A", value: DARK,
    });

    expect(data.reachable).toBe(false);
    expect(data.note).toContain(DARK);
    await app.close();
  });

  it("says so without a note when the target does answer", async () => {
    probeAnswer = { ok: true, status: 200, check: "https", detail: "https 200" };
    const app = restApp();

    const { data } = (await app.inject({
      method: "POST",
      url: "/api/v1/subdomains",
      payload: { subdomain: "demo", domain: DOMAIN, type: "A", value: DARK },
    })).json();

    expect(data.reachable).toBe(true);
    expect(data.note).toBeUndefined();
    await app.close();
  });

  it("writes the verdict to the log, with the check that produced it", async () => {
    const lines = [];
    const app = Fastify({ logger: false });
    app.decorate("mysql", { execute: scriptedDb() });
    app.decorate("authenticate", async (request) => {
      request.user = { id: USER_ID };
    });
    // The routes log through request.log, which inherits from the instance.
    for (const level of ["info", "warn"]) {
      app.log[level] = (obj, msg) => lines.push({ level, obj, msg });
    }
    app.register(domainRoutes, { prefix: "/api" });

    await app.inject({
      method: "POST",
      url: "/api/subdomains",
      payload: { subdomain: "demo", domain: DOMAIN, recordType: "A", value: DARK },
    });

    const line = lines.find((l) => l.obj?.evt === "validate");
    expect(line).toBeTruthy();
    expect(line.obj).toMatchObject({
      evt: "validate",
      phase: "create",
      subdomain: "demo",
      domain: DOMAIN,
      type: "A",
      value: DARK,
      check: "https",
      status: null,
      detail: "https failed: ECONNREFUSED",
      result: "unreachable",
    });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Update behaves like create
// ---------------------------------------------------------------------------

describe("pointing an existing name at something that does not answer", () => {
  it("succeeds on the web route and says the target is dark", async () => {
    const app = webApp();

    const res = await app.inject({
      method: "PUT",
      url: "/api/subdomains/demo",
      payload: { domain: DOMAIN, value: DARK },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSubdomain).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({ success: true, reachable: false });
    expect(res.json().note).toContain(DARK);
    await app.close();
  });

  it("succeeds on the REST API and says the target is dark", async () => {
    const app = restApp();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      payload: { value: DARK },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ reachable: false, value: DARK });
    await app.close();
  });

  it("succeeds over MCP and says the target is dark", async () => {
    const app = mcpApp();

    const { isError, data } = await callTool(app, "update_subdomain", {
      subdomain: "demo", domain: DOMAIN, value: DARK,
    });

    expect(isError).toBe(false);
    expect(data.reachable).toBe(false);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 4. TXT is not on this path and must not move
// ---------------------------------------------------------------------------

describe("the TXT route is untouched", () => {
  let origAdd;

  beforeEach(() => {
    origAdd = bindMod.addTxtRecord;
    bindMod.addTxtRecord = vi.fn(async (subdomain, domain, hostPrefix, value) => ({
      name: `${hostPrefix}.${domain}`,
      content: value,
    }));
  });

  afterAll(() => {
    if (origAdd) bindMod.addTxtRecord = origAdd;
  });

  it("writes a TXT record without probing anything", async () => {
    const app = restApp();
    const prefix = config.txt.apexPrefixes[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt`,
      payload: { host_prefix: prefix, value: "vc-domain-verify=demo,tok" },
    });

    expect(res.statusCode).toBe(200);
    expect(probeHost).not.toHaveBeenCalled();
    // exactly the shape it had before: no reachability fields bolted on
    expect(res.json().data).toEqual({
      fqdn: `${prefix}.${DOMAIN}`,
      type: "TXT",
      value: "vc-domain-verify=demo,tok",
    });
    await app.close();
  });

  // probeRecord answers for A and CNAME only. A record type it does not know
  // is reported reachable so that nothing downstream treats it as a failure.
  it("is not a record type the probe has an opinion about", async () => {
    const probe = await probeRecord("TXT", "vc-domain-verify=demo,tok");

    expect(probe.ok).toBe(true);
    expect(probe.check).toBe("none");
    expect(probeHost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. The nightly check still picks the record up
// ---------------------------------------------------------------------------

describe("a record created while dark is still caught at night", () => {
  const record = {
    id: 42,
    subdomain: "demo",
    domain_name: DOMAIN,
    record_type: "A",
    record_value: DARK,
    warning_count: 0,
    unreachable_notified_at: null,
    user_id: USER_ID,
  };

  function fakeFastify() {
    const statements = [];
    const lines = [];
    return {
      statements,
      lines,
      mysql: {
        execute: async (sql, params) => {
          statements.push({ sql, params });
          return [[{ email: "someone@example.com" }]];
        },
      },
      log: {
        info: (obj, msg) => lines.push({ level: "info", obj, msg }),
        warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
        error: (obj, msg) => lines.push({ level: "error", obj, msg }),
      },
    };
  }

  it("finds the same target dark", async () => {
    const probe = await probeRecord("A", DARK, { fqdn: `demo.${DOMAIN}` });

    expect(probe.ok).toBe(false);
    expect(probe.detail).toBe("https failed: ECONNREFUSED");
  });

  it("counts the day against it and deletes nothing", async () => {
    const fastify = fakeFastify();
    const probe = await probeRecord("A", DARK);

    await handleValidationResult(fastify, record, false, probe);

    const update = fastify.statements.find((s) => s.sql.startsWith("UPDATE subdomains"));
    expect(update.sql).toContain("warning_count = ?");
    expect(update.params[0]).toBe(1);
    expect(deleteSubdomain).not.toHaveBeenCalled();
  });

  it("reaches the notice decision once it has been dark long enough", async () => {
    const fastify = fakeFastify();
    const probe = await probeRecord("A", DARK);
    const onTheThreshold = {
      ...record,
      warning_count: config.validation.unreachableNoticeDays - 1,
    };

    await handleValidationResult(fastify, onTheThreshold, false, probe);

    const line = fastify.lines.at(-1);
    // The mail itself is behind UNREACHABLE_NOTICE_ENABLED, which is off until
    // one has been watched arriving; either way the record survives.
    expect(["notice", "notice_withheld"]).toContain(line.obj.action);
    expect(line.obj.check).toBe("https");
    expect(deleteSubdomain).not.toHaveBeenCalled();
  });
});
