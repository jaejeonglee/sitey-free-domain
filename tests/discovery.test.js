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
// roots a caller may create under and that list is a table, not a constant.
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

let app;
/** Every route the real app registers, collected while it boots. */
const registered = [];

beforeAll(async () => {
  app = buildApp({ logger: false });
  // Added before ready(), so it sees the routes every plugin registers —
  // including the ones inside /api/v1, which is the list this file checks the
  // OpenAPI document against.
  app.addHook("onRoute", (route) => {
    for (const method of [].concat(route.method)) {
      registered.push(`${method} ${route.url}`);
    }
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete require2.cache[dbPath];
});

describe("/.well-known/mcp.json", () => {
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

describe("/openapi.json", () => {
  it("answers as JSON at a path robots.txt allows", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json().openapi).toMatch(/^3\./);
  });

  it("takes its origin from config", async () => {
    const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    expect(doc.servers).toEqual([{ url: config.server.publicOrigin }]);
    expect(JSON.stringify(discovery.openApi({ origin: "https://example.test" }))).not.toContain(
      "sitey"
    );
  });

  // The point of generating this rather than writing it: a route added to
  // routes/api-v1.js without a line here is a route no agent will ever call,
  // and an entry here for a route that has gone is worse than nothing.
  it("documents every /api/v1 route and no others", async () => {
    const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json();

    const live = registered
      .filter((entry) => entry.includes(" /api/v1/") && !entry.startsWith("HEAD "))
      // Fastify writes a path parameter as :name, OpenAPI as {name}.
      .map((entry) => entry.replace(/:([a-zA-Z]+)/g, "{$1}"))
      .sort();

    const documented = Object.entries(doc.paths)
      .flatMap(([url, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${url}`)
      )
      .sort();

    expect(live.length).toBeGreaterThan(5);
    expect(documented).toEqual(live);
  });

  // An error code is the interface an agent branches on, so a new one that
  // never reaches the document is a silent gap. Only this direction is
  // checked: the document also names RATE_LIMITED and INTERNAL_ERROR, which
  // the error handler produces without naming them at a call site.
  it("names every error code routes/api-v1.js can return", async () => {
    const doc = JSON.stringify((await app.inject({ method: "GET", url: "/openapi.json" })).json());
    const source = fs.readFileSync(path.join(ROOT, "routes/api-v1.js"), "utf8");

    const codes = new Set([
      ...[...source.matchAll(/apiError\(\s*\d{3},[\s\S]*?"([A-Z][A-Z_]+)"\s*\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/\bcode:\s*"([A-Z][A-Z_]+)"/g)].map((m) => m[1]),
    ]);

    expect(codes.size).toBeGreaterThan(8);
    for (const code of codes) {
      expect(doc, `${code} is not in the OpenAPI document`).toContain(code);
    }
  });

  // In the delivered HTML, not just in the browser: the reader most likely to
  // want a machine-readable spec is the one that does not run JavaScript.
  // services/page-body.js ships the docs sidebar, so the link has to be there.
  it("is linked from /docs without JavaScript", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    const appRoot = res.body.match(/<main id="app-root">([\s\S]*?)<\/main>/)[1];

    expect(appRoot).toContain('href="/openapi.json"');
  });

  it("keeps the prefixes a TXT record may use in step with config", async () => {
    const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    const schema =
      doc.paths["/api/v1/subdomains/{subdomain}/{domain}/txt"].post.requestBody.content[
        "application/json"
      ].schema;

    expect(schema.properties.host_prefix.enum).toEqual(config.txt.apexPrefixes);
  });
});

describe("/llms.txt", () => {
  it("answers as plain text a browser will show", async () => {
    const res = await app.inject({ method: "GET", url: "/llms.txt" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("points at the two documents that hold the detail", async () => {
    const body = (await app.inject({ method: "GET", url: "/llms.txt" })).body;
    const origin = config.server.publicOrigin;

    expect(body).toContain(`${origin}/openapi.json`);
    expect(body).toContain(`${origin}/mcp`);
    expect(body).toContain(`${origin}/.well-known/mcp.json`);
    // The roots come from the database, like everywhere else.
    expect(body).toContain("sitey.my, officials.one");
  });

  it("carries no origin of its own and the limits the code applies", () => {
    const built = discovery.llmsTxt({
      origin: "https://example.test",
      domains: ["example.test"],
    });

    expect(built).not.toContain("sitey");
    expect(built).toContain("https://example.test/openapi.json");
    for (const note of discovery.limitNotes()) {
      expect(built).toContain(note);
    }
  });

  it("is linked from /docs without JavaScript", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    const appRoot = res.body.match(/<main id="app-root">([\s\S]*?)<\/main>/)[1];

    expect(appRoot).toContain('href="/llms.txt"');
  });
});

// robots.txt disallows /api/, which is why none of these live under it. A
// document a crawler is told not to read is no use for being found.
describe("robots.txt lets the readers in", () => {
  it("blocks none of the three", () => {
    const robots = fs.readFileSync(path.join(ROOT, "public/robots.txt"), "utf8");
    const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gim)].map((m) => m[1]);

    expect(disallowed.length).toBeGreaterThan(0);
    for (const url of ["/.well-known/mcp.json", "/openapi.json", "/llms.txt"]) {
      for (const prefix of disallowed) {
        expect(url.startsWith(prefix), `${prefix} blocks ${url}`).toBe(false);
      }
    }
  });
});
