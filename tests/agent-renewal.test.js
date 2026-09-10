import { describe, it, expect, vi } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const Fastify = require2("fastify");
const config = require2("../configs/index.js");
const apiV1Routes = require2("../routes/api-v1.js");

const DOMAIN = "example.com";
const DOMAIN_ID = 1;
const AGENT_IP = "127.0.0.1";

// ---------------------------------------------------------------------------
// An agent-created record has no mailbox behind it, so none of the three
// reminders a person gets can reach it. Its whole notice is the date in the
// responses it already reads, and its whole button is this endpoint. If either
// half is missing the one-month lifetime becomes a silent expiry.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function buildHarness({ daysLeft = 3 } = {}) {
  const queries = [];
  // Plus an hour, so the floor in daysUntil lands on the number this names
  // rather than one below it — the request runs a few milliseconds after the
  // date is built.
  const expiresAt = new Date(Date.now() + daysLeft * DAY_MS + 60 * 60 * 1000);

  const execute = vi.fn(async (sql, params = []) => {
    queries.push({ sql, params });

    if (sql.includes("FROM managed_domains")) {
      return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    }
    if (sql.startsWith("SELECT id, record_type FROM subdomains")) {
      return [[{ id: 42, record_type: "CNAME" }]];
    }
    // renewSubdomain's own lookup. The date is inside the renewal window —
    // an agent reads expires_at from the list response and calls this when it
    // is close, and only then is it allowed (services/expiry.js).
    if (sql.includes("FROM subdomains s") && sql.includes("WHERE s.id = ?")) {
      return [[{
        id: 42,
        subdomain: "demo",
        owner_type: "agent",
        domain_name: DOMAIN,
        expires_at: expiresAt,
      }]];
    }
    if (sql.includes("FROM subdomains s JOIN managed_domains")) {
      return [[{
        subdomain: "demo",
        domain: DOMAIN,
        type: "CNAME",
        value: "target.example.net",
        created_at: new Date("2026-09-01T00:00:00Z"),
        expires_at: new Date("2026-10-01T00:00:00Z"),
      }]];
    }
    return [[]];
  });

  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });
  app.decorate("mysql", { execute });
  app.register(apiV1Routes, { prefix: "/api/v1" });

  return { app, queries };
}

describe("an agent can see when its record runs out", () => {
  it("carries expires_at in the list response", async () => {
    const { app } = buildHarness();

    const res = await app.inject({ method: "GET", url: "/api/v1/subdomains" });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.subdomains[0]).toHaveProperty("expires_at");
  });

  it("selects the column, rather than leaving it to a JOIN by accident", async () => {
    const { app, queries } = buildHarness();

    await app.inject({ method: "GET", url: "/api/v1/subdomains" });

    const list = queries.find((q) => q.sql.includes("FROM subdomains s JOIN managed_domains"));
    expect(list.sql).toMatch(/s\.expires_at/);
  });
});

describe("an agent can renew without a mailbox", () => {
  it("resets the clock and says the new date", async () => {
    const { app, queries } = buildHarness();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/subdomains/demo/${DOMAIN}/renew`,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.fqdn).toBe(`demo.${DOMAIN}`);
    // one month out for an agent-owned record
    const expires = new Date(data.expires_at);
    expect(expires.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * 3600 * 1000);
    expect(expires.getTime()).toBeLessThan(Date.now() + 40 * 24 * 3600 * 1000);

    const write = queries.find((q) => /UPDATE subdomains SET expires_at/.test(q.sql));
    expect(write.params[1]).toBe(42);
    expect(write.sql).toMatch(/renewal_notice_stage = NULL/);
  });

  it("refuses one that is not due yet, and names the date it can be", async () => {
    // An agent has no mailbox, so the refusal is the only place it can learn
    // when to come back. Without the date it can only poll.
    const { app, queries } = buildHarness({ daysLeft: 15 });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/subdomains/demo/${DOMAIN}/renew`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("RENEWAL_NOT_DUE");
    expect(res.json().message).toMatch(/Renewal opens 14 days before expiry, on \d{4}-\d{2}-\d{2}/);
    expect(queries.filter((q) => /UPDATE subdomains SET expires_at/.test(q.sql))).toHaveLength(0);
  });

  it("refuses to renew a record the caller does not own", async () => {
    const { app } = buildHarness();
    // ownership lookup returns nothing for this one
    app.mysql.execute = vi.fn(async (sql) => {
      if (sql.includes("FROM managed_domains")) return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
      return [[]];
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/subdomains/someone-elses/${DOMAIN}/renew`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });
});
