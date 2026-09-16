import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import http from "http";

const require2 = createRequire(import.meta.url);

const config = require2("../configs/index.js");
const { checkRedirectTarget, isOwnHost } = require2("../services/redirect-safety.js");
const { validateRecordValue } = require2("../utils/validators.js");
const bind = require2("../services/bind.js");
const { diffRecords } = require2("../plugins/reconciler.js");
const { isRedirectTargetAlive, probeUrl } = require2("../services/reachability.js");
const { probeRecord } = require2("../services/validation.js");
const discovery = require2("../services/discovery.js");
const Fastify = require2("fastify");
const redirectPlugin = require2("../plugins/redirect.js");

const IP = config.redirect.targetIp;

// ---------------------------------------------------------------------------
// REDIRECT is a record type the database has and DNS does not. Four things
// have to agree for it to work, and each is pinned here: what a target may be
// (services/redirect-safety.js), what the zone gets instead of a URL
// (bind.zoneRecordFor), that the nightly reconciler reads that A line as the
// row it belongs to, and the 301 the visitor actually receives
// (plugins/redirect.js).
// ---------------------------------------------------------------------------

describe("what a REDIRECT may point at", () => {
  it("accepts an absolute https URL and hands back the parsed form", () => {
    const result = checkRedirectTarget("  https://GitHub.com/jay/myapp?tab=readme ");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("https://github.com/jay/myapp?tab=readme");
  });

  it("refuses http://", () => {
    const result = checkRedirectTarget("http://example.com/page");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_REDIRECT_URL");
    expect(result.message).toMatch(/https:\/\//);
  });

  it("refuses anything that is not an absolute URL", () => {
    for (const raw of ["", "   ", "example.com/page", "/relative", "ftp://x.example", "javascript:alert(1)"]) {
      const result = checkRedirectTarget(raw);
      expect(result.valid, raw).toBe(false);
      expect(result.code, raw).toBe("INVALID_REDIRECT_URL");
    }
  });

  it("refuses a URL over the length limit", () => {
    const long = `https://example.com/${"a".repeat(config.redirect.maxUrlLength)}`;
    const result = checkRedirectTarget(long);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_REDIRECT_URL");
    expect(result.message).toContain(String(config.redirect.maxUrlLength));
  });

  it("refuses user:pass@ in the URL", () => {
    const result = checkRedirectTarget("https://bank.example@evil.example/");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_REDIRECT_URL");
  });

  // a.sitey.my → b.sitey.my → a.sitey.my would chase itself; the roots are
  // read from config so the list is the same one the service issues under.
  it("refuses a target under one of our own roots", () => {
    for (const root of config.redirect.ownDomains) {
      for (const url of [`https://${root}/`, `https://other.${root}/x`, `https://${root.toUpperCase()}`]) {
        const result = checkRedirectTarget(url);
        expect(result.valid, url).toBe(false);
        expect(result.code, url).toBe("REDIRECT_LOOP");
      }
    }
  });

  it("does not mistake a longer name for one of ours", () => {
    expect(isOwnHost("notsitey.my")).toBe(false);
    expect(isOwnHost("sitey.my.example.com")).toBe(false);
    expect(isOwnHost("sitey.my")).toBe(true);
    expect(isOwnHost("x.sitey.my.")).toBe(true);
  });

  // REST and MCP both reach the rules through this one function, and the
  // code travels with the refusal so the API can name it.
  it("is what validateRecordValue applies for REDIRECT", () => {
    const bad = validateRecordValue("REDIRECT", "http://example.com", { subdomain: "a", domain: "sitey.my" });
    expect(bad.valid).toBe(false);
    expect(bad.code).toBe("INVALID_REDIRECT_URL");

    const loop = validateRecordValue("REDIRECT", "https://b.sitey.my", { subdomain: "a", domain: "sitey.my" });
    expect(loop.code).toBe("REDIRECT_LOOP");

    const good = validateRecordValue("REDIRECT", "https://example.com/p", { subdomain: "a", domain: "sitey.my" });
    expect(good).toEqual({ valid: true, value: "https://example.com/p" });

    // A and CNAME carry no code — INVALID_INPUT stays the API's word for them.
    expect(validateRecordValue("A", "nope", { subdomain: "a", domain: "sitey.my" }).code).toBeUndefined();
  });
});

describe("what the zone gets", () => {
  it("normalizes REDIRECT like the other two", () => {
    expect(bind.normalizeRecordType("redirect")).toBe("REDIRECT");
    expect(bind.RECORD_TYPES).toEqual(["A", "CNAME", "REDIRECT"]);
  });

  it("writes a REDIRECT as an A record for this server, whatever the URL", () => {
    expect(bind.zoneRecordFor("REDIRECT", "https://example.com/anything")).toEqual({
      type: "A",
      value: IP,
    });
    // ...and leaves the other two exactly as before.
    expect(bind.zoneRecordFor("A", " 203.0.113.10 ")).toEqual({ type: "A", value: "203.0.113.10" });
    expect(bind.zoneRecordFor("CNAME", "app.example.com")).toEqual({ type: "CNAME", value: "app.example.com." });
    expect(bind.zoneRecordFor("CNAME", "app.example.com.")).toEqual({ type: "CNAME", value: "app.example.com." });
  });

  it("reports the requested type and the zone content separately", async () => {
    // BIND_DEV_MODE in vitest: no file is touched, the shape is what matters.
    const created = await bind.createDnsRecord("myapp", "https://example.com/x", "sitey.my", "REDIRECT");
    expect(created).toEqual({ name: "myapp.sitey.my", content: IP, type: "REDIRECT" });

    const updated = await bind.updateDnsRecord("myapp", "https://example.com/y", "sitey.my", "REDIRECT");
    expect(updated).toEqual({ name: "myapp.sitey.my", content: IP, type: "REDIRECT" });

    // Delete addresses the A line, because that is what is there.
    const deleted = await bind.deleteDnsRecord("myapp", "sitey.my", "REDIRECT");
    expect(deleted.type).toBe("A");
  });

  it("reads from the config, not a constant", () => {
    expect(IP).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("the nightly reconciler", () => {
  const diff = (zoneRecords, dbRows) =>
    diffRecords({ zoneRecords, zoneTxtLines: [], dbRows, dbTxtRows: [] });

  it("reads a REDIRECT row's A line as the row, not as drift", () => {
    const issues = diff(
      [{ name: "myapp", type: "A", value: IP }],
      [{ subdomain: "myapp", record_type: "REDIRECT", record_value: "https://example.com/x" }]
    );
    expect(issues).toEqual([]);
  });

  it("still notices when the A line points somewhere else", () => {
    const issues = diff(
      [{ name: "myapp", type: "A", value: "203.0.113.99" }],
      [{ subdomain: "myapp", record_type: "REDIRECT", record_value: "https://example.com/x" }]
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: "value-drift", name: "myapp", zoneValue: "203.0.113.99", dbValue: IP });
  });

  it("still notices a REDIRECT row with no line at all", () => {
    const issues = diff(
      [],
      [{ subdomain: "myapp", record_type: "REDIRECT", record_value: "https://example.com/x" }]
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: "db-only", name: "myapp" });
  });

  it("keeps CNAME comparison as it was, with or without the trailing dot", () => {
    expect(
      diff(
        [{ name: "a", type: "CNAME", value: "x.example.com." }],
        [{ subdomain: "a", record_type: "CNAME", record_value: "x.example.com" }]
      )
    ).toEqual([]);
    expect(
      diff(
        [{ name: "a", type: "CNAME", value: "x.example.com." }],
        [{ subdomain: "a", record_type: "CNAME", record_value: "x.example.com." }]
      )
    ).toEqual([]);
  });
});

describe("probing the destination instead of ourselves", () => {
  let server;
  let port;
  /** the path the last request asked for */
  let seenPath;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenPath = req.url;
      if (req.url.startsWith("/gone")) {
        res.writeHead(404);
      } else if (req.url.startsWith("/moved")) {
        res.writeHead(302, { location: "https://elsewhere.example/" });
      } else {
        res.writeHead(200);
      }
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("counts 2xx and 3xx as a page, and 4xx/5xx as not one", () => {
    for (const status of [200, 204, 301, 302, 308]) expect(isRedirectTargetAlive(status), `${status}`).toBe(true);
    for (const status of [400, 404, 500, 502, null]) expect(isRedirectTargetAlive(status), `${status}`).toBe(false);
  });

  it("asks for the URL's own path and does not follow a redirect", async () => {
    // http here only because the test server has no certificate; the
    // validator refuses http for real records.
    const ok = await probeUrl({ url: `http://127.0.0.1:${port}/repo?x=1`, timeoutMs: 2000 });
    expect(seenPath).toBe("/repo?x=1");
    expect(ok).toMatchObject({ ok: true, status: 200, check: "redirect" });

    const moved = await probeUrl({ url: `http://127.0.0.1:${port}/moved`, timeoutMs: 2000 });
    expect(moved).toMatchObject({ ok: true, status: 302 });

    const gone = await probeUrl({ url: `http://127.0.0.1:${port}/gone`, timeoutMs: 2000 });
    expect(gone).toMatchObject({ ok: false, status: 404 });
    expect(gone.detail).toMatch(/404/);
  });

  it("is the check probeRecord runs for REDIRECT", async () => {
    const probe = await probeRecord("REDIRECT", `http://127.0.0.1:${port}/`);
    expect(probe).toMatchObject({ ok: true, status: 200, check: "redirect" });
  });
});

describe("the 301 a visitor gets", () => {
  let app;
  const TARGET = "https://github.com/jay/myapp";
  const canonicalHost = config.redirect.canonicalHosts[0];

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorate("mysql", {
      execute: async (sql, params = []) => {
        if (/managed_domains/i.test(sql)) {
          return [[{ id: 1, domain_name: "sitey.my" }, { id: 2, domain_name: "officials.one" }]];
        }
        if (/record_type = 'REDIRECT'/.test(sql)) {
          const [subdomain, domainId] = params;
          return [subdomain === "myapp" && domainId === 1 ? [{ record_value: TARGET }] : []];
        }
        return [[]];
      },
    });
    await app.register(redirectPlugin);
    app.get("/", async () => ({ home: true }));
    app.get("/api/v1/domains", async () => ({ api: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers 301 with the URL, uncached", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: { host: "myapp.sitey.my" } });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(TARGET);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("matches the Host without its port or case", async () => {
    const res = await app.inject({ method: "GET", url: "/any/path", headers: { host: "MyApp.Sitey.my:443" } });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(TARGET);
  });

  it("leaves the site itself alone", async () => {
    const home = await app.inject({ method: "GET", url: "/", headers: { host: canonicalHost } });
    expect(home.statusCode).toBe(200);
    expect(home.json()).toEqual({ home: true });

    const api = await app.inject({ method: "GET", url: "/api/v1/domains", headers: { host: `${canonicalHost}:443` } });
    expect(api.json()).toEqual({ api: true });

    // inject()'s default Host is localhost — the canonical list carries it so
    // every other test in this repository keeps reaching its routes.
    const plain = await app.inject({ method: "GET", url: "/" });
    expect(plain.statusCode).toBe(200);
  });

  it("answers 404 for a name with no REDIRECT record", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: { host: "nobody.sitey.my" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("answers 404 for a nested label or an unmanaged root", async () => {
    for (const host of ["a.myapp.sitey.my", "myapp.example.com", "sitey.my.evil.example"]) {
      const res = await app.inject({ method: "GET", url: "/", headers: { host } });
      expect(res.statusCode, host).toBe(404);
    }
  });

  it("does not turn an A or CNAME name into a redirect", async () => {
    // The stub only answers the REDIRECT-typed query; a row of another type
    // under the same name is invisible to it, which is what the WHERE does.
    const res = await app.inject({ method: "GET", url: "/", headers: { host: "myapp.officials.one" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("the documents say so", () => {
  it("lists REDIRECT in the OpenAPI record type and names its two refusals", () => {
    const doc = discovery.openApi({ origin: "https://example.test" });
    const post = doc.paths["/api/v1/subdomains"].post;
    const schema = post.requestBody.content["application/json"].schema;
    expect(schema.properties.type.enum).toEqual(["A", "CNAME", "REDIRECT"]);
    expect(post.responses[400].description).toContain("INVALID_REDIRECT_URL");
    expect(post.responses[400].description).toContain("REDIRECT_LOOP");
    expect(doc.components.schemas.Subdomain.properties.type.enum).toContain("REDIRECT");
  });

  it("tells an agent in llms.txt and the manifest", () => {
    const llms = discovery.llmsTxt({ origin: "https://example.test", domains: ["example.test"] });
    expect(llms).toContain("REDIRECT");
    expect(llms).toMatch(/301/);
    const manifest = discovery.mcpManifest({ origin: "https://example.test", domains: ["example.test"] });
    expect(manifest.description).toContain("REDIRECT");
  });
});
