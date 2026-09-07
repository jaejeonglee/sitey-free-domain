import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Same stub as app.test.js: @fastify/mysql opens a real connection at boot.
// The routes under test only need execute() to answer.
// ---------------------------------------------------------------------------

const fp = require2("fastify-plugin");
const dbPath = require2.resolve("../plugins/db.js");

require2.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  path: dbPath,
  loaded: true,
  children: [],
  paths: [],
  exports: fp(async function stubDb(fastify) {
    fastify.decorate("mysql", {
      execute: async (sql) => {
        if (sql.includes("FROM managed_domains")) {
          return [[{ id: 1, domain_name: "example.com" }]];
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
const accessLog = require2("../services/access-log.js");

describe("access log", () => {
  let app;
  /** every object handed to logger.info, in order */
  let logged;

  beforeAll(async () => {
    logged = [];
    const capture = {
      info: (obj) => logged.push(obj),
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      silent: () => {},
      level: "info",
      child() {
        return this;
      },
    };
    // buildApp always sets `logger`; Fastify refuses both at once.
    app = buildApp({ logger: undefined, loggerInstance: capture });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete require2.cache[dbPath];
  });

  function lastLine() {
    return logged.filter((l) => l && l.evt === "http").pop();
  }

  // A funnel step that names a route that no longer exists would be logged as
  // null forever, and nobody would notice until the numbers were read.
  it("maps every funnel step onto a route that exists", () => {
    for (const key of accessLog.STEPS.keys()) {
      const [method, url] = key.split(" ");
      expect(app.hasRoute({ method, url }), `no route for ${key}`).toBe(true);
    }
  });

  it("records the landing page as the first funnel step", async () => {
    await app.inject({ method: "GET", url: "/" });

    expect(lastLine()).toMatchObject({
      evt: "http",
      m: "GET",
      p: "/",
      step: "landing",
      st: 200,
      code: "OK",
    });
    expect(typeof lastLine().ms).toBe("number");
  });

  // The whole point: a 400 from an unreachable target and a 400 from a name
  // that is already taken need different work, and the status code is the same.
  it("names the reason a request failed, not just the status", async () => {
    await app.inject({
      method: "POST",
      url: "/api/check-availability",
      payload: { subdomain: "not a valid name" },
    });

    expect(lastLine()).toMatchObject({
      p: "/api/check-availability",
      step: "name_check",
      st: 400,
      code: "INVALID_SUBDOMAIN",
    });
  });

  it("carries the v1 error code through to the log", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/subdomains/demo/example.com/txt",
      payload: { host_prefix: "_vercel", value: "token", root_level: true },
    });

    expect(lastLine()).toMatchObject({
      step: "connect",
      st: 400,
      code: "ROOT_LEVEL_FORBIDDEN",
    });
  });

  it("logs the route pattern, so the names people tried stay out of it", async () => {
    await app.inject({ method: "GET", url: "/api/v1/check/secretproject/example.com" });

    const line = lastLine();
    expect(line.p).toBe("/api/v1/check/:subdomain/:domain");
    expect(JSON.stringify(line)).not.toContain("secretproject");
  });

  it("never writes a raw IP", async () => {
    await app.inject({
      method: "GET",
      url: "/api/managed-domains",
      remoteAddress: "203.0.113.9",
    });

    const line = lastLine();
    expect(line.iph).toBeTruthy();
    expect(line.iph).not.toContain("203.0.113.9");
    expect(JSON.stringify(line)).not.toContain("203.0.113.9");
    // ...but the same caller is still recognisable across requests
    expect(line.iph).toBe(accessLog.hashIp("203.0.113.9"));
    expect(accessLog.hashIp("203.0.113.10")).not.toBe(line.iph);
  });

  it("says nothing about static assets", async () => {
    const before = logged.length;
    await app.inject({ method: "GET", url: "/style.css" });
    expect(logged.filter((l) => l && l.evt === "http")).toHaveLength(
      logged.slice(0, before).filter((l) => l && l.evt === "http").length
    );
  });
});
