import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const fs = require2("fs");
const os = require2("os");
const path = require2("path");
const { execFileSync } = require2("child_process");

// ---------------------------------------------------------------------------
// «레코드 유형 변경» (2026-11-11) — a record turned into another type in place.
//
// The real functions, end to end: services/subdomain.js updateSubdomain over
// services/bind.js, a real zone file in a temp directory and the real
// `named-checkzone`. Only the database is a stand-in (in memory, with a
// transaction that really rolls back), and `systemctl reload` is stubbed.
//
// What has to hold:
//   - the name never leaves the zone (one line rewritten, not delete + create)
//   - a TXT on the name itself blocks becoming a CNAME — refused before any
//     write, DB and zone both untouched
//   - when anything fails, the zone ends up saying what it said before
// ---------------------------------------------------------------------------

function findCheckzone() {
  for (const candidate of [
    "/opt/homebrew/bin/named-checkzone",
    "/opt/homebrew/sbin/named-checkzone",
    "/usr/sbin/named-checkzone",
    "/usr/bin/named-checkzone",
    "/usr/local/sbin/named-checkzone",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const CHECKZONE = findCheckzone();
const DOMAIN = "example.com";
const SERVER_IP = "139.59.126.52"; // config.redirect.targetIp default

const ZONE = [
  "$TTL 3600",
  `@  IN  SOA  ns1.${DOMAIN}. admin.${DOMAIN}. (`,
  "    2024010101  ; Serial",
  "    3600        ; Refresh",
  "    900         ; Retry",
  "    604800      ; Expire",
  "    86400 )     ; Minimum TTL",
  `@          IN  NS     ns1.${DOMAIN}.`,
  "ns1        IN  A      139.59.126.52",
  "site\tIN\tA\t203.0.113.10",
  "app\tIN\tCNAME\tcname.vercel-dns.com.",
  `_vercel    IN  TXT    "vc-domain-verify=app.${DOMAIN},tok"`,
  "",
].join("\n");

/** Everything but the serial line — the serial moves on every write. */
const withoutSerial = (text) => text.split("\n").filter((l) => !/; Serial/.test(l)).join("\n");

/**
 * subdomains + subdomain_txt_records, in memory. A transaction snapshots the
 * state on begin and puts it back on rollback, so «DB untouched» is checkable.
 */
function makeDb(seed) {
  let state = structuredClone(seed);
  let snapshot = null;
  const log = [];
  const failOn = { commit: false };

  const execute = vi.fn(async (sql, params = []) => {
    log.push(sql);
    if (/^SELECT record_value, record_type FROM subdomains WHERE id = \? FOR UPDATE/.test(sql)) {
      const row = state.subdomains.find((r) => r.id === params[0]);
      return [row ? [{ record_value: row.record_value, record_type: row.record_type }] : []];
    }
    if (/^SELECT 1 FROM subdomain_txt_records WHERE subdomain_id = \? AND host_prefix = \?/.test(sql)) {
      return [state.txt.filter((t) => t.subdomain_id === params[0] && t.host_prefix === params[1]).slice(0, 1).map(() => ({ 1: 1 }))];
    }
    if (/^SELECT txt_value FROM subdomain_txt_records/.test(sql)) {
      const rows = state.txt.filter((t) => t.subdomain_id === params[0] && t.host_prefix === params[1]);
      return [rows.slice(-1).map((t) => ({ txt_value: t.txt_value }))];
    }
    if (/^UPDATE subdomains SET record_value = \?, record_type = \? WHERE id = \?/.test(sql)) {
      const row = state.subdomains.find((r) => r.id === params[2]);
      row.record_value = params[0];
      row.record_type = params[1];
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE subdomains SET record_value = \? WHERE id = \?/.test(sql)) {
      state.subdomains.find((r) => r.id === params[1]).record_value = params[0];
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO subdomain_txt_records/.test(sql)) {
      const existing = state.txt.find((t) => t.subdomain_id === params[0] && t.host_prefix === params[1]);
      if (existing) existing.txt_value = params[2];
      else state.txt.push({ subdomain_id: params[0], host_prefix: params[1], txt_value: params[2] });
      return [{ affectedRows: 1 }];
    }
    if (/^DELETE FROM subdomain_txt_records WHERE subdomain_id = \? AND host_prefix = \?/.test(sql)) {
      state.txt = state.txt.filter((t) => !(t.subdomain_id === params[0] && t.host_prefix === params[1]));
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  });

  const connection = {
    execute,
    beginTransaction: async () => { snapshot = structuredClone(state); },
    commit: async () => {
      if (failOn.commit) throw new Error("commit failed (test)");
      snapshot = null;
    },
    rollback: async () => { if (snapshot) state = snapshot; snapshot = null; },
    release: () => {},
  };

  return {
    fastify: {
      mysql: { getConnection: async () => connection },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    },
    get state() { return state; },
    log,
    failOn,
  };
}

describe.skipIf(!CHECKZONE)("changing a record's type (real zone, real named-checkzone)", () => {
  let tmpDir;
  let zonePath;
  let cpMod;
  let origExecFile;
  let subdomain;
  let alert;
  const savedEnv = {};
  const MODULES = ["../configs/index.js", "../services/bind.js", "../services/alert.js", "../services/subdomain.js"];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sitey-retype-"));
    zonePath = path.join(tmpDir, `db.${DOMAIN}`);
    fs.writeFileSync(zonePath, ZONE);

    for (const key of ["BIND_DEV_MODE", "BIND_DB_PATH", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALERT_CHAT_ID", "REDIRECT_TARGET_IP"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.BIND_DEV_MODE = "false";
    process.env.BIND_DB_PATH = tmpDir;
    process.env.TELEGRAM_BOT_TOKEN = "test-tok";
    process.env.TELEGRAM_ALERT_CHAT_ID = "123";
    delete process.env.REDIRECT_TARGET_IP;

    cpMod = require2("child_process");
    origExecFile = cpMod.execFile;
    cpMod.execFile = (cmd, args, cb) => {
      if (cmd === "named-checkzone") {
        try {
          cb(null, execFileSync(CHECKZONE, args, { encoding: "utf8", stdio: "pipe" }), "");
        } catch (error) {
          cb(error, "", String(error.stderr || ""));
        }
        return;
      }
      cb(null, "", "");
    };

    for (const m of MODULES) delete require2.cache[require2.resolve(m)];
    alert = require2("../services/alert.js");
    alert.warn = vi.fn(async () => {});
    alert.critical = vi.fn(async () => {});
    subdomain = require2("../services/subdomain.js");
  });

  afterEach(() => {
    cpMod.execFile = origExecFile;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    for (const m of MODULES) delete require2.cache[require2.resolve(m)];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const zone = () => fs.readFileSync(zonePath, "utf8");
  const zoneOk = () => {
    try {
      execFileSync(CHECKZONE, [DOMAIN, zonePath], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  const SEED = {
    subdomains: [
      { id: 1, record_value: "203.0.113.10", record_type: "A" },
      { id: 2, record_value: "cname.vercel-dns.com", record_type: "CNAME" },
    ],
    txt: [{ subdomain_id: 2, host_prefix: "_vercel", txt_value: `vc-domain-verify=app.${DOMAIN},tok` }],
  };

  it("A → CNAME rewrites the one line, and the zone still loads", async () => {
    const db = makeDb(SEED);

    await subdomain.updateSubdomain(db.fastify, {
      recordId: 1, subdomain: "site", domain: DOMAIN, recordType: "CNAME", recordValue: "mysite.netlify.app",
    });

    const text = zone();
    expect(text).toContain("site\tIN\tCNAME\tmysite.netlify.app.");
    expect(text).not.toMatch(/^site\s+IN\s+A\s/m);
    // one line for the name, never zero, never two
    expect(text.split("\n").filter((l) => /^site\s/.test(l))).toHaveLength(1);
    expect(db.state.subdomains[0]).toMatchObject({ record_type: "CNAME", record_value: "mysite.netlify.app" });
    expect(zoneOk()).toBe(true);
  });

  it("CNAME → A, and the _vercel TXT it had stays where it was", async () => {
    const db = makeDb(SEED);

    await subdomain.updateSubdomain(db.fastify, {
      recordId: 2, subdomain: "app", domain: DOMAIN, recordType: "A", recordValue: "198.51.100.7",
    });

    const text = zone();
    expect(text).toContain("app\tIN\tA\t198.51.100.7");
    expect(text).not.toMatch(/^app\s+IN\s+CNAME/m);
    expect(text).toContain(`vc-domain-verify=app.${DOMAIN},tok`);
    expect(db.state.subdomains[1]).toMatchObject({ record_type: "A", record_value: "198.51.100.7" });
    expect(db.state.txt).toHaveLength(1);
    expect(zoneOk()).toBe(true);
  });

  it("A → REDIRECT writes this server's IP to the zone and the URL to the DB", async () => {
    const db = makeDb(SEED);

    await subdomain.updateSubdomain(db.fastify, {
      recordId: 1, subdomain: "site", domain: DOMAIN, recordType: "REDIRECT", recordValue: "https://github.com/me/site",
    });

    expect(zone()).toContain(`site\tIN\tA\t${SERVER_IP}`);
    expect(db.state.subdomains[0]).toMatchObject({ record_type: "REDIRECT", record_value: "https://github.com/me/site" });
    expect(zoneOk()).toBe(true);
  });

  it("CNAME → REDIRECT", async () => {
    const db = makeDb(SEED);

    await subdomain.updateSubdomain(db.fastify, {
      recordId: 2, subdomain: "app", domain: DOMAIN, recordType: "REDIRECT", recordValue: "https://example.org/",
    });

    expect(zone()).toContain(`app\tIN\tA\t${SERVER_IP}`);
    expect(zone()).not.toMatch(/^app\s+IN\s+CNAME/m);
    expect(zoneOk()).toBe(true);
  });

  it("refuses A → CNAME while the name holds its own TXT — nothing written anywhere", async () => {
    fs.writeFileSync(zonePath, `${ZONE}site\tIN\tTXT\t"v=MCPv1; k=ed25519; p=abc"\n`);
    const before = zone();
    const db = makeDb({
      ...SEED,
      txt: [...SEED.txt, { subdomain_id: 1, host_prefix: "@", txt_value: "v=MCPv1; k=ed25519; p=abc" }],
    });

    await expect(
      subdomain.updateSubdomain(db.fastify, {
        recordId: 1, subdomain: "site", domain: DOMAIN, recordType: "CNAME", recordValue: "mysite.netlify.app",
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "CNAME_CANNOT_HOLD_TXT" });

    expect(zone()).toBe(before);
    expect(db.state.subdomains[0]).toMatchObject({ record_type: "A", record_value: "203.0.113.10" });
    expect(db.log.some((sql) => /^UPDATE/.test(sql))).toBe(false);
  });

  it("a write BIND refuses leaves the zone byte-for-byte and the DB rolled back", async () => {
    // A TXT on the name that the database does not know about (hand-entered,
    // migration 009 style): the DB guard passes, named-checkzone does not.
    fs.writeFileSync(zonePath, `${ZONE}site\tIN\tTXT\t"hand-entered"\n`);
    const before = zone();
    const db = makeDb(SEED);

    await expect(
      subdomain.updateSubdomain(db.fastify, {
        recordId: 1, subdomain: "site", domain: DOMAIN, recordType: "CNAME", recordValue: "mysite.netlify.app",
      })
    ).rejects.toThrow(/validation failed/i);

    expect(zone()).toBe(before);
    expect(db.state.subdomains[0]).toMatchObject({ record_type: "A", record_value: "203.0.113.10" });
    expect(alert.critical).not.toHaveBeenCalled();
  });

  it("when the DB fails after the zone moved, the zone is put back to the old type", async () => {
    const before = zone();
    const db = makeDb(SEED);
    db.failOn.commit = true;

    await expect(
      subdomain.updateSubdomain(db.fastify, {
        recordId: 1, subdomain: "site", domain: DOMAIN, recordType: "CNAME", recordValue: "mysite.netlify.app",
      })
    ).rejects.toThrow(/commit failed/);

    const after = zone();
    expect(after).toContain("site\tIN\tA\t203.0.113.10");
    expect(after).not.toMatch(/^site\s+IN\s+CNAME/m);
    // everything but the serial is what it was
    expect(withoutSerial(after)).toBe(withoutSerial(before));
    expect(db.state.subdomains[0]).toMatchObject({ record_type: "A", record_value: "203.0.113.10" });
    expect(alert.warn).toHaveBeenCalledWith("UPDATE_COMPENSATED", expect.any(Object));
    expect(zoneOk()).toBe(true);
  });

  it("an update that keeps the type still goes through updateDnsRecord", async () => {
    const db = makeDb(SEED);

    await subdomain.updateSubdomain(db.fastify, {
      recordId: 1, subdomain: "site", domain: DOMAIN, recordType: "A", recordValue: "198.51.100.9",
    });

    expect(zone()).toMatch(/^site\tIN\tA\t198\.51\.100\.9$/m);
    expect(db.log).toContain("UPDATE subdomains SET record_value = ? WHERE id = ?");
  });
});
