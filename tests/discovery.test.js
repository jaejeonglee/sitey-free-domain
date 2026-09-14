import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const fs = require2("fs");
const path = require2("path");
const fp = require2("fastify-plugin");

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Same trick as tests/app.test.js: @fastify/mysql dials a real server while
// booting, so plugins/db is swapped for a stub before app.js pulls it in. This
// one answers the managed_domains query, because the MCP manifest lists the
// domains a caller may create under and that list is a table, not a constant.
// ---------------------------------------------------------------------------
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
      execute: async (sql) =>
        /managed_domains/i.test(sql)
          ? [[
              { id: 1, domain_name: "sitey.my" },
              { id: 2, domain_name: "officials.one" },
            ]]
          : [[]],
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
const config = require2("../configs/index.js");
const expiry = require2("../services/expiry.js");
const discovery = require2("../services/discovery.js");

describe("/.well-known/mcp.json", () => {
  let app;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete require2.cache[dbPath];
  });

  it("is served as JSON, not as a file on disk", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/mcp.json" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);

    // The copy in public/ was a second source of truth and it was the stale
    // one: it named sitey.one, a limit of three and an unlimited API key.
    expect(fs.existsSync(path.join(ROOT, "public/.well-known/mcp.json"))).toBe(false);
  });

  it("names the canonical origin and the domains the database holds", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/mcp.json" });
    const body = res.json();

    expect(body.url).toBe(`${config.server.publicOrigin}/mcp`);
    expect(body.domains).toEqual(["sitey.my", "officials.one"]);
  });
});

describe("the manifest is built, not filed", () => {
  const built = discovery.mcpManifest({
    origin: "https://example.test",
    domains: ["example.test"],
  });
  const text = JSON.stringify(built);

  // Condition of the job: change PUBLIC_ORIGIN and every document follows.
  it("carries no origin of its own", () => {
    expect(text).not.toContain("sitey");
    expect(built.url).toBe("https://example.test/mcp");
    expect(built.documentation).toBe("https://example.test/docs");
  });

  // The old file said "3 subdomains max" and "With API key: unlimited". Both
  // were false: the default is five and an API key is an account with the
  // same allowance.
  it("states the limit and the lease the code actually applies", () => {
    expect(built.limits).toContain(String(config.quota.subdomainLimit));
    expect(built.limits).toContain(`${expiry.USER_MONTHS} months`);
    expect(built.limits).toContain(`${expiry.AGENT_MONTHS} month`);
    expect(built.limits).toContain(String(expiry.RENEWAL_WINDOW_DAYS));
    expect(built.limits).not.toMatch(/unlimited/i);
  });
});
