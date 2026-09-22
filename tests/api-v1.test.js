import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const Fastify = require2("fastify");
const config = require2("../configs/index.js");
const apiV1Routes = require2("../routes/api-v1.js");
const bindMod = require2("../services/bind.js");

const DOMAIN = "example.com";
const DOMAIN_ID = 1;

// ---------------------------------------------------------------------------
// Harness — a bare Fastify with only the v1 routes and a scripted MySQL.
// BIND_DEV_MODE=true (vitest env) keeps services/bind.js from touching a disk.
// ---------------------------------------------------------------------------

function buildHarness({ ownedBy = null, existingTxt = [], recordType = "CNAME" } = {}) {
  const queries = [];

  const execute = vi.fn(async (sql, params = []) => {
    queries.push({ sql, params });

    if (sql.includes("FROM managed_domains")) {
      return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    }
    if (sql.includes("COUNT(*) AS cnt FROM subdomains")) {
      return [[{ cnt: 0 }]];
    }
    if (sql.startsWith("SELECT id, record_type FROM subdomains")) {
      // ownership lookup: anonymous mode matches on owner_ip (last param)
      const owner = params[2];
      return [owner === ownedBy ? [{ id: 42, record_type: recordType }] : []];
    }
    if (sql.includes("FROM subdomains s JOIN managed_domains")) {
      return [[]];
    }
    if (sql.includes("FROM subdomain_txt_records")) {
      return [existingTxt];
    }
    if (sql.startsWith("INSERT INTO") || sql.startsWith("DELETE FROM")) {
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });

  const app = Fastify({
    logger: false,
    // the whole point of fix #2: only these peers may set X-Forwarded-For
    trustProxy: config.server.trustProxy,
  });
  app.decorate("mysql", { execute });
  app.register(apiV1Routes, { prefix: "/api/v1" });

  return { app, execute, queries };
}

/** params of the first query whose SQL matches */
function paramsOf(queries, needle) {
  return queries.find((q) => q.sql.includes(needle))?.params;
}

let origCreateTxt;
let origDeleteTxt;
let txtCalls;

beforeEach(() => {
  origCreateTxt = bindMod.addTxtRecord;
  origDeleteTxt = bindMod.deleteTxtRecord;
  txtCalls = [];
  bindMod.addTxtRecord = vi.fn(async (subdomain, domain, hostPrefix, value, previousValue = null) => {
    txtCalls.push({ op: "add", subdomain, domain, hostPrefix, value, previousValue });
    return { name: `${hostPrefix}.${domain}`, content: value };
  });
  bindMod.deleteTxtRecord = vi.fn(async (subdomain, domain, hostPrefix, value) => {
    txtCalls.push({ op: "delete", subdomain, domain, hostPrefix, value });
    return { name: `${hostPrefix}.${domain}`, deleted: true };
  });
});

afterEach(() => {
  bindMod.addTxtRecord = origCreateTxt;
  bindMod.deleteTxtRecord = origDeleteTxt;
});

// ---------------------------------------------------------------------------
// #2 — anonymous ownership comes from the socket, not from a header
// ---------------------------------------------------------------------------

describe("anonymous identity (trusted proxy)", () => {
  const VICTIM_IP = "203.0.113.9";
  const ATTACKER_IP = "198.51.100.7";

  it("ignores cf-connecting-ip and x-forwarded-for from an untrusted peer", async () => {
    const { app, queries } = buildHarness();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      remoteAddress: ATTACKER_IP,
      headers: {
        "cf-connecting-ip": VICTIM_IP,
        "x-forwarded-for": VICTIM_IP,
      },
    });

    expect(res.statusCode).toBe(200);
    // the listing is scoped to who actually connected
    expect(paramsOf(queries, "s.owner_ip = ?")).toEqual([ATTACKER_IP]);
    await app.close();
  });

  it("blocks deleting someone else's subdomain via a spoofed header", async () => {
    // the record belongs to the victim's IP
    const { app, queries } = buildHarness({ ownedBy: VICTIM_IP });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}`,
      remoteAddress: ATTACKER_IP,
      headers: { "cf-connecting-ip": VICTIM_IP },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
    expect(paramsOf(queries, "SELECT id, record_type FROM subdomains")).toEqual([
      "demo",
      DOMAIN_ID,
      ATTACKER_IP,
    ]);
    await app.close();
  });

  it("still honours x-forwarded-for from the local reverse proxy", async () => {
    const { app, queries } = buildHarness();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/subdomains",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": VICTIM_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(paramsOf(queries, "s.owner_ip = ?")).toEqual([VICTIM_IP]);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// #1 / #3 — TXT records
// ---------------------------------------------------------------------------

describe("POST /subdomains/:subdomain/:domain/txt", () => {
  const OWNER_IP = "203.0.113.9";

  function post(app, body) {
    return app.inject({
      method: "POST",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt`,
      remoteAddress: OWNER_IP,
      payload: body,
    });
  }

  it("refuses root_level, which wrote to the shared zone apex", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP });

    const res = await post(app, {
      host_prefix: "_vercel",
      value: "vc-domain-verify=attacker",
      root_level: true,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("ROOT_LEVEL_FORBIDDEN");
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it.each([
    ["a name that appends its own records", "_vercel\tIN\tA\t1.2.3.4\n@"],
    ["a newline", "_vercel\n@ IN A 6.6.6.6"],
    ["a zone directive", "$ORIGIN evil.com."],
    // "the apex", "@" was here until 2026-09-22: it now names the subdomain
    // itself rather than the zone apex, and has its own tests below.
    ["a wildcard", "*"],
    ["a space", "_vercel ; x"],
  ])("rejects %s as host_prefix", async (_label, hostPrefix) => {
    const { app } = buildHarness({ ownedBy: OWNER_IP });

    const res = await post(app, { host_prefix: hostPrefix, value: "token" });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_HOST_PREFIX");
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("writes the value at the root domain under the prefix", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP });

    const res = await post(app, { host_prefix: "_VERCEL", value: "vc-domain-verify=mine" });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.fqdn).toBe(`_vercel.${DOMAIN}`);
    expect(txtCalls).toEqual([
      {
        op: "add",
        subdomain: "demo",
        domain: DOMAIN,
        hostPrefix: "_vercel",
        value: "vc-domain-verify=mine",
        previousValue: null,
      },
    ]);
    await app.close();
  });

  // The name is shared by the whole domain, so the caller's stored value is the
  // only thing that says which line under it is theirs to replace.
  it("hands the caller's stored value to the zone write", async () => {
    const { app } = buildHarness({
      ownedBy: OWNER_IP,
      existingTxt: [{ txt_value: "vc-domain-verify=old" }],
    });

    const res = await post(app, { host_prefix: "_vercel", value: "vc-domain-verify=new" });

    expect(res.statusCode).toBe(200);
    expect(txtCalls[0].previousValue).toBe("vc-domain-verify=old");
    await app.close();
  });

  // Every TXT record lands on the root name, so the prefix is a claim about the
  // root domain: _acme-challenge there would get the caller a certificate for
  // sitey.my itself.
  it("refuses a prefix that would claim the root domain", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP });

    const res = await post(app, { host_prefix: "_acme-challenge", value: "token" });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_HOST_PREFIX");
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  // -------------------------------------------------------------------------
  // "@" — the TXT goes on the subdomain's own name (2026-09-22)
  // -------------------------------------------------------------------------

  it("writes @ on the subdomain's own name, not at the root", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP, recordType: "A" });

    const res = await post(app, {
      host_prefix: "@",
      value: "v=MCPv1; k=ed25519; p=G72mfmBr3XwUBjR0G3ehT4un5XxkVO9gnaMHTr3Kpnk=",
    });

    expect(res.statusCode).toBe(200);
    expect(txtCalls).toEqual([
      {
        op: "add",
        subdomain: "demo",
        domain: DOMAIN,
        hostPrefix: "@",
        value: "v=MCPv1; k=ed25519; p=G72mfmBr3XwUBjR0G3ehT4un5XxkVO9gnaMHTr3Kpnk=",
        previousValue: null,
      },
    ]);
    await app.close();
  });

  it("stores @ as the host_prefix so the record can be found again", async () => {
    const { app, queries } = buildHarness({ ownedBy: OWNER_IP, recordType: "A" });

    await post(app, { host_prefix: "@", value: "token" });

    expect(paramsOf(queries, "INSERT INTO subdomain_txt_records")).toEqual([42, "@", "token"]);
    await app.close();
  });

  // 🔴 The one that matters. DNS allows no other data beside a CNAME, and BIND
  // refuses the *whole zone* over it — named-checkzone says "CNAME and other
  // data" and every name in the file stops resolving. bind.js validates before
  // it swaps the file in so the live zone survives, but the caller would get a
  // 500 with nothing in it. 23 of the 32 records in the live zone are CNAME.
  it("refuses @ on a CNAME record, before anything is written", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP, recordType: "CNAME" });

    const res = await post(app, { host_prefix: "@", value: "token" });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("CNAME_CANNOT_HOLD_TXT");
    expect(res.json().message).toMatch(/A record/);
    // nothing reached the zone
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("still takes an apex prefix on a CNAME record", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP, recordType: "CNAME" });

    const res = await post(app, { host_prefix: "_vercel", value: "vc-domain-verify=mine" });

    expect(res.statusCode).toBe(200);
    expect(txtCalls[0].hostPrefix).toBe("_vercel");
    await app.close();
  });

  it("accepts @ on a REDIRECT, whose zone line is an A record", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP, recordType: "REDIRECT" });

    const res = await post(app, { host_prefix: "@", value: "token" });

    expect(res.statusCode).toBe(200);
    expect(txtCalls[0].hostPrefix).toBe("@");
    await app.close();
  });

  it("deletes a self-named record addressed as %40", async () => {
    const { app } = buildHarness({
      ownedBy: OWNER_IP,
      recordType: "A",
      existingTxt: [{ txt_value: "token" }],
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt/%40`,
      remoteAddress: OWNER_IP,
    });

    expect(res.statusCode).toBe(200);
    expect(txtCalls).toEqual([
      { op: "delete", subdomain: "demo", domain: DOMAIN, hostPrefix: "@", value: "token" },
    ]);
    await app.close();
  });

  it("still requires ownership of the parent subdomain", async () => {
    const { app } = buildHarness({ ownedBy: "10.0.0.1" });

    const res = await post(app, { host_prefix: "_vercel", value: "token" });

    expect(res.statusCode).toBe(403);
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("rejects a TXT value that would break out of the quoted field", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP });

    const res = await post(app, { host_prefix: "_vercel", value: 'a"\n@ IN A 6.6.6.6' });

    expect(res.statusCode).toBe(400);
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });
});

describe("DELETE /subdomains/:subdomain/:domain/txt/:hostPrefix", () => {
  const OWNER_IP = "203.0.113.9";

  it("rejects an injected prefix", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt/${encodeURIComponent("$ORIGIN evil.")}`,
      remoteAddress: OWNER_IP,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_HOST_PREFIX");
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("deletes by value, so the other owners' lines survive", async () => {
    const { app } = buildHarness({
      ownedBy: OWNER_IP,
      existingTxt: [{ txt_value: "vc-domain-verify=mine" }],
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt/_vercel`,
      remoteAddress: OWNER_IP,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.fqdn).toBe(`_vercel.${DOMAIN}`);
    expect(txtCalls).toEqual([
      {
        op: "delete",
        subdomain: "demo",
        domain: DOMAIN,
        hostPrefix: "_vercel",
        value: "vc-domain-verify=mine",
      },
    ]);
    await app.close();
  });

  it("404s instead of guessing when nothing is recorded for that prefix", async () => {
    const { app } = buildHarness({ ownedBy: OWNER_IP });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt/_vercel`,
      remoteAddress: OWNER_IP,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("TXT_NOT_FOUND");
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });
});
