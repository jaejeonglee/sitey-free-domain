import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// "Three creates a minute" used to mean three a minute for every anonymous
// caller put together: four agents arriving at once and the fourth was refused
// for what the other three did, and one caller spending its three shut the
// rest out until the minute was up. These cases are about who gets counted.
//
// The module keeps its state in module scope, so each case gets a fresh copy
// out of the require cache rather than a reset hatch that only tests use.
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

const LIMITER = "../services/anon-create-rate.js";
const PLUGIN = "../plugins/mcp.js";

const DOMAIN = "example.com";
const DOMAIN_ID = 1;

const createSubdomain = vi.fn(async () => ({
  name: `demo.${DOMAIN}`,
  type: "A",
  expiresAt: new Date("2026-12-15T00:00:00Z"),
}));

const stubbed = [
  stub("../services/subdomain.js", {
    createSubdomain, updateSubdomain: vi.fn(), deleteSubdomain: vi.fn(),
  }),
  // The real one asks the record's target for an HTTP response. The verdict no
  // longer decides anything on create — tests/unreachable-create.test.js is
  // where that is checked — so the stub just says the target answered.
  stub("../services/validation.js", {
    noteReachability: vi.fn(async () => ({
      ok: true, check: "https", status: 200, detail: "https 200", note: null,
    })),
    setLogger: () => {},
  }),
];

let limiter;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
  createSubdomain.mockClear();
  // The plugin goes too, so the app built below closes over the same fresh
  // limiter this file is holding.
  for (const spec of [LIMITER, PLUGIN]) delete require2.cache[require2.resolve(spec)];
  limiter = require2(LIMITER);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  for (const filename of stubbed) delete require2.cache[filename];
  for (const spec of [LIMITER, PLUGIN]) delete require2.cache[require2.resolve(spec)];
});

// Two subjects. What the hash is does not matter here — the limiter is handed
// a subject, and plugins/mcp.js is what decides it is the hashed client IP.
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("anonymous create limit", () => {
  it("does not let one caller spend another's allowance", () => {
    for (let i = 0; i < limiter.MAX_PER_WINDOW; i++) {
      expect(limiter.check(A).ok).toBe(true);
    }
    expect(limiter.check(A).ok).toBe(false);

    // B has done nothing, and gets its whole allowance while A is shut out.
    for (let i = 0; i < limiter.MAX_PER_WINDOW; i++) {
      expect(limiter.check(B).ok).toBe(true);
    }
    expect(limiter.check(A).ok).toBe(false);
  });

  it("refuses the same caller past the limit", () => {
    for (let i = 0; i < limiter.MAX_PER_WINDOW; i++) {
      expect(limiter.check(A).ok).toBe(true);
    }

    expect(limiter.check(A)).toEqual({ ok: false, reason: "rate" });
  });

  it("lets the same caller back in once the window has passed", () => {
    for (let i = 0; i < limiter.MAX_PER_WINDOW; i++) limiter.check(A);
    expect(limiter.check(A).ok).toBe(false);

    vi.advanceTimersByTime(limiter.WINDOW_MS + 1);

    expect(limiter.check(A).ok).toBe(true);
  });

  it("forgets callers that have gone quiet", () => {
    limiter.check(A);
    limiter.check(B);
    expect(limiter.subjectCount()).toBe(2);

    vi.advanceTimersByTime(limiter.WINDOW_MS + 1);
    limiter.check(B);

    // A is gone and B was put back by the call that swept: the map holds the
    // callers of the last minute, not every caller there has ever been.
    expect(limiter.subjectCount()).toBe(1);
  });

  // The ceiling on how many callers are remembered must not turn the limit off
  // when it is reached.
  it("refuses new callers when it is full rather than waving them through", () => {
    for (let i = 0; i < limiter.MAX_SUBJECTS; i++) {
      expect(limiter.check(`subject-${i}`).ok).toBe(true);
    }
    expect(limiter.subjectCount()).toBe(limiter.MAX_SUBJECTS);

    expect(limiter.check("one-too-many")).toEqual({ ok: false, reason: "capacity" });

    // Callers already known are still counted normally while it is full.
    expect(limiter.check("subject-0").ok).toBe(true);
  });

  it("makes room again once the crowd ages out", () => {
    for (let i = 0; i < limiter.MAX_SUBJECTS; i++) limiter.check(`subject-${i}`);
    expect(limiter.check("one-too-many").ok).toBe(false);

    vi.advanceTimersByTime(limiter.WINDOW_MS + 1);

    expect(limiter.check("one-too-many").ok).toBe(true);
    expect(limiter.subjectCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The wiring. A limiter that counts per subject is no use if the endpoint
// hands it the same subject every time, and that is the shape the bug had.
// ---------------------------------------------------------------------------

/** A MySQL that answers the few questions the create path asks. */
function scriptedDb() {
  return vi.fn(async (sql) => {
    if (sql.includes("FROM managed_domains")) return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    if (sql.includes("COUNT(*) AS held FROM subdomains")) return [[{ held: 0 }]];
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

function mcpApp() {
  const Fastify = require2("fastify");
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
  app.register(require2(PLUGIN));
  return app;
}

/** One create over the streamable-HTTP transport, from a given address. */
async function createFrom(app, remoteAddress, subdomain) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_subdomain",
        arguments: { subdomain, domain: DOMAIN, type: "A", value: "203.0.113.10" },
      },
    },
  });

  const line = res.body.split("\n").find((l) => l.startsWith("data: "));
  const result = JSON.parse(line.slice("data: ".length)).result;
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

describe("over MCP, the limit follows the address", () => {
  // The transport is async I/O the fake clock has no part in.
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("gives every address its own allowance", async () => {
    const app = mcpApp();

    for (let i = 0; i < limiter.MAX_PER_WINDOW; i++) {
      expect((await createFrom(app, "198.51.100.1", `one${i}`)).isError).toBe(false);
    }
    const spent = await createFrom(app, "198.51.100.1", "one3");
    const stranger = await createFrom(app, "198.51.100.2", "two0");

    expect(spent.isError).toBe(true);
    expect(spent.data.error).toMatch(/Too many anonymous create requests/);
    // The one that had nothing to do with it still gets through.
    expect(stranger.isError).toBe(false);
    expect(limiter.subjectCount()).toBe(2);

    await app.close();
  });
});
