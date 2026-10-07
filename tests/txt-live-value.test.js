import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// «The previous value» of a TXT record is the newest row, not whichever row
// MySQL hands back first.
//
// Production's unique key is (subdomain_id, host_prefix, txt_value) — 005 —
// so a changed value is a new row and a record can have several. Every
// writer read the previous value with no ORDER BY; InnoDB answered in index
// order, which is by value, which for catikteam's timestamped values was the
// oldest. Each rewrite then removed a line that was already gone and left the
// real previous one in the zone (tests/reconciler.test.js has the other half).
//
// The fake below answers the way InnoDB did — sorted by value — unless the SQL
// asks for the newest id, so a lookup without ORDER BY goes red here.
// ---------------------------------------------------------------------------

const fs = require2("fs");
const path = require2("path");
const Fastify = require2("fastify");
const config = require2("../configs/index.js");
const bindMod = require2("../services/bind.js");
const apiV1Routes = require2("../routes/api-v1.js");

const ROOT = path.join(__dirname, "..");
const DOMAIN = "example.com";
const API_KEY = "styo_" + "b".repeat(32);

// ids say which is newer; values sort the other way round on purpose
const ROWS = [
  { id: 1, txt_value: "a-oldest" },
  { id: 2, txt_value: "m-middle" },
  { id: 3, txt_value: "z-newest" },
];

function db() {
  return vi.fn(async (sql) => {
    if (sql.includes("FROM managed_domains")) return [[{ id: 1, domain_name: DOMAIN }]];
    if (sql.includes("FROM api_keys ak JOIN users u")) {
      return [[{ key_id: 1, user_id: 7, email: "a@example.com", name: "A" }]];
    }
    if (sql.startsWith("SELECT id, record_type FROM subdomains")) return [[{ id: 42, record_type: "A" }]];
    if (sql.includes("FROM subdomain_txt_records")) {
      if (/ORDER BY id DESC LIMIT 1/.test(sql)) {
        return [[...ROWS].sort((a, b) => b.id - a.id).slice(0, 1)];
      }
      return [[...ROWS].sort((a, b) => a.txt_value.localeCompare(b.txt_value))];
    }
    if (/^(INSERT|DELETE|UPDATE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

let calls;
let origAdd;
let origDel;

beforeEach(() => {
  calls = [];
  origAdd = bindMod.addTxtRecord;
  origDel = bindMod.deleteTxtRecord;
  bindMod.addTxtRecord = vi.fn(async (sub, domain, prefix, value, previous) => {
    calls.push({ op: "add", value, previous });
    return { name: sub, content: value };
  });
  bindMod.deleteTxtRecord = vi.fn(async (sub, domain, prefix, value) => {
    calls.push({ op: "delete", value });
    return { name: sub, deleted: true };
  });
});

afterEach(() => {
  bindMod.addTxtRecord = origAdd;
  bindMod.deleteTxtRecord = origDel;
});

function app() {
  const a = Fastify({ logger: false, trustProxy: config.server.trustProxy });
  a.decorate("mysql", { execute: db() });
  a.register(apiV1Routes, { prefix: "/api/v1" });
  return a;
}

describe("the previous TXT value is the newest row", () => {
  it("a rewrite removes the value in use, not the oldest one", async () => {
    const a = app();
    const res = await a.inject({
      method: "POST",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { host_prefix: "@", value: "b-next" },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ op: "add", value: "b-next", previous: "z-newest" }]);
    await a.close();
  });

  it("a delete removes the value in use", async () => {
    const a = app();
    const res = await a.inject({
      method: "DELETE",
      url: `/api/v1/subdomains/demo/${DOMAIN}/txt/%40`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ op: "delete", value: "z-newest" }]);
    await a.close();
  });

  // The REST case above is one of six places that ask. The rest — MCP twice,
  // the dashboard route, services/subdomain.js — have to ask the same
  // question the same way, so none of them may carry its own copy of the SQL.
  it("no writer carries its own unordered lookup", () => {
    const bare = /SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = \? AND host_prefix = \?"/;
    for (const file of ["routes/api-v1.js", "routes/domain.js", "plugins/mcp.js", "services/subdomain.js"]) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(source, file).not.toMatch(bare);
      expect(source, file).toContain("LIVE_TXT_VALUE_SQL");
    }
  });
});
