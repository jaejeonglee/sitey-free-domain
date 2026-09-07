import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// @fastify/mysql opens a real connection while booting, so swap plugins/db for
// a stub in the require cache *before* app.js pulls it in. Everything else —
// registration order in particular — stays exactly as production runs it.
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
      execute: async () => [[]],
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

// ---------------------------------------------------------------------------
// #4 — /mcp used to be registered before @fastify/rate-limit, and a global
// hook only applies to routes registered after it, so the MCP endpoint was
// reachable without any throttling at all.
// ---------------------------------------------------------------------------

describe("global rate limit covers every entry point", () => {
  let app;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete require2.cache[dbPath];
  });

  /** hammer a route until the global limiter (100/min per IP) kicks in */
  async function floodUntilLimited(url, method = "GET") {
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({ method, url });
      if (res.statusCode === 429) return { limitedAfter: i + 1 };
    }
    return { limitedAfter: null };
  }

  it("registers the MCP routes", () => {
    expect(app.hasRoute({ method: "POST", url: "/mcp" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/mcp" })).toBe(true);
  });

  it("throttles /mcp", async () => {
    const { limitedAfter } = await floodUntilLimited("/mcp");
    expect(limitedAfter).toBe(101);
  });
});
