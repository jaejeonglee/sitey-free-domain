import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import http from "http";

const require2 = createRequire(import.meta.url);

const {
  isAliveStatus,
  probeOrigin,
  probeHost,
} = require2("../services/reachability.js");

// ---------------------------------------------------------------------------
// The verdict table is the policy. It decides who gets told their site is down
// and, in deploy/cleanup-unreachable.js, which records end up on a delete list
// a human approves. Both halves are pinned here: the table on its own, and the
// table applied to a real HTTP response off a local server — no network.
// ---------------------------------------------------------------------------

describe("the verdict table", () => {
  it("counts 404 as alive", () => {
    // Decided 2026-09-08: a site that serves nothing at "/" and everything
    // under a path is a working site.
    expect(isAliveStatus(404)).toBe(true);
  });

  it("counts 401 and 403 as alive", () => {
    // A server is there and chose not to let us in.
    expect(isAliveStatus(401)).toBe(true);
    expect(isAliveStatus(403)).toBe(true);
  });

  it("counts 2xx and 3xx as alive", () => {
    for (const status of [200, 204, 301, 302, 308]) {
      expect(isAliveStatus(status), `${status}`).toBe(true);
    }
  });

  it("counts 502, 503 and 504 as dead", () => {
    for (const status of [502, 503, 504]) {
      expect(isAliveStatus(status), `${status}`).toBe(false);
    }
  });

  it("counts 500 as alive — an application is there and it crashed", () => {
    expect(isAliveStatus(500)).toBe(true);
  });
});

describe("probing a real server", () => {
  let server;
  let port;
  /** the Host header the last request arrived with */
  let seenHost;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200);
      res.end("body");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("reports the status a server answered with", async () => {
    const result = await probeOrigin({
      protocol: "http",
      host: "127.0.0.1",
      port,
      hostname: "demo.sitey.my",
      timeoutMs: 2000,
    });

    expect(result).toMatchObject({ ok: true, status: 200, check: "http" });
    expect(result.detail).toContain("200");
  });

  it("presents the subdomain's own name, not the address it dialled", async () => {
    // A CDN routes on this header. Dialling the CNAME target and asking for
    // the CDN's own name tells us nothing about the user's deployment.
    await probeOrigin({
      protocol: "http",
      host: "127.0.0.1",
      port,
      hostname: "demo.sitey.my",
      timeoutMs: 2000,
    });

    expect(seenHost).toBe("demo.sitey.my");
  });

  it("says a refused connection is dead, with no status", async () => {
    // Port 1 on loopback: nothing listens, and the refusal is immediate.
    const result = await probeOrigin({
      protocol: "http",
      host: "127.0.0.1",
      port: 1,
      hostname: "demo.sitey.my",
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    // null status is how probeHost tells "nothing answered" from "answered 502"
    expect(result.status).toBe(null);
    expect(result.detail).toMatch(/failed: ECONN/);
  });

  it("falls back to HTTP only when HTTPS could not be connected to", async () => {
    // Nothing is listening on 443 here, so the fallback is the only way this
    // host can be seen at all. It answers on the plain port.
    const result = await probeHost({
      host: "127.0.0.1",
      hostname: "demo.sitey.my",
      timeoutMs: 2000,
    });

    // 443 refused, then port 80 — also refused here, since the stub is on a
    // random port. What matters is that both were tried and neither answered.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(null);
    expect(result.detail).toContain("https failed");
    expect(result.detail).toContain("http failed");
  });
});

describe("the table applied to live responses", () => {
  let server;
  let port;
  let nextStatus = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(nextStatus);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function verdictFor(status) {
    nextStatus = status;
    const result = await probeOrigin({
      protocol: "http",
      host: "127.0.0.1",
      port,
      hostname: "demo.sitey.my",
      timeoutMs: 2000,
    });
    return result.ok;
  }

  it("a 404 response is alive", async () => {
    expect(await verdictFor(404)).toBe(true);
  });

  it("a 403 response is alive", async () => {
    expect(await verdictFor(403)).toBe(true);
  });

  it("a 502 response is dead", async () => {
    expect(await verdictFor(502)).toBe(false);
  });
});
