import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const fs = require2("fs");
const os = require2("os");
const path = require2("path");
const { execFileSync } = require2("child_process");

// ---------------------------------------------------------------------------
// The only test here that runs BIND itself, and the only kind that can catch
// what this change is really about.
//
// A TXT record on a subdomain's own name is illegal in DNS when that name is a
// CNAME (RFC 1034 §3.6.2). BIND does not drop the offending line — it refuses
// the *entire zone* with "CNAME and other data", so one bad record stops every
// other name in the file from resolving. No amount of unit testing our string
// handling can show that; only the program that reads the file can.
//
// So: a real temp directory, real zone files, and the real `named-checkzone`
// that production runs. Only `named-checkconf` (wants /etc/named.conf) and
// `systemctl reload` (not a thing on a developer's machine) are stubbed.
// ---------------------------------------------------------------------------

function findCheckzone() {
  const candidates = [
    "/opt/homebrew/bin/named-checkzone",
    "/opt/homebrew/sbin/named-checkzone",
    "/usr/sbin/named-checkzone",
    "/usr/bin/named-checkzone",
    "/usr/local/sbin/named-checkzone",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync("which", ["named-checkzone"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const CHECKZONE = findCheckzone();
const DOMAIN = "example.com";
const MCP_VALUE = "v=MCPv1; k=ed25519; p=G72mfmBr3XwUBjR0G3ehT4un5XxkVO9gnaMHTr3Kpnk=";

/** A zone with the two shapes that matter: an A name and a CNAME name. */
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
  "@          IN  TXT    \"v=spf1 -all\"",
  // an A-record subdomain — this one may hold a TXT of its own
  "test       IN  A      139.59.126.52",
  // a CNAME subdomain — this one may not
  "kimh4nkyul IN  CNAME  cname.vercel-dns.com.",
  // the shared apex name every Vercel token lives under
  `_vercel    IN  TXT    "vc-domain-verify=demo.${DOMAIN},demo-token"`,
  "",
].join("\n");

describe.skipIf(!CHECKZONE)("named-checkzone accepts what we write", () => {
  let bind;
  let cpMod;
  let origExecFile;
  let tmpDir;
  let zonePath;
  const savedEnv = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sitey-zone-"));
    zonePath = path.join(tmpDir, `db.${DOMAIN}`);
    fs.writeFileSync(zonePath, ZONE);

    for (const key of ["BIND_DEV_MODE", "BIND_DB_PATH", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALERT_CHAT_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.BIND_DEV_MODE = "false";
    process.env.BIND_DB_PATH = tmpDir;
    process.env.TELEGRAM_BOT_TOKEN = "test-tok";
    process.env.TELEGRAM_ALERT_CHAT_ID = "123";

    // The real checkzone; everything else about a running BIND is stubbed.
    cpMod = require2("child_process");
    origExecFile = cpMod.execFile;
    cpMod.execFile = (cmd, args, cb) => {
      if (cmd === "named-checkzone") {
        try {
          const out = execFileSync(CHECKZONE, args, { encoding: "utf8", stdio: "pipe" });
          cb(null, out, "");
        } catch (error) {
          cb(error, "", String(error.stderr || ""));
        }
        return;
      }
      cb(null, "", "");
    };

    for (const modPath of ["../configs/index.js", "../services/bind.js", "../services/alert.js"]) {
      delete require2.cache[require2.resolve(modPath)];
    }
    bind = require2("../services/bind.js");
  });

  afterEach(() => {
    cpMod.execFile = origExecFile;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    for (const modPath of ["../configs/index.js", "../services/bind.js", "../services/alert.js"]) {
      delete require2.cache[require2.resolve(modPath)];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** what BIND makes of the zone as it stands on disk right now */
  function checkzone() {
    try {
      return { ok: true, out: execFileSync(CHECKZONE, [DOMAIN, zonePath], { encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { ok: false, out: String(error.stdout || "") + String(error.stderr || "") };
    }
  }

  it("starts from a zone BIND already accepts", () => {
    expect(checkzone().ok).toBe(true);
  });

  it("loads the zone after a TXT goes on an A record's own name", async () => {
    await bind.addTxtRecord("test", DOMAIN, "@", MCP_VALUE);

    const onDisk = fs.readFileSync(zonePath, "utf8");
    expect(onDisk).toContain(`test\tIN\tTXT\t"${MCP_VALUE}"`);

    const result = checkzone();
    expect(result.out).toContain("OK");
    expect(result.ok).toBe(true);
  });

  // 🔴 The finding this whole change is built around. Without the guard in
  // utils/validators.js this is the 500 that 23 of the live zone's 32 owners
  // would get, with nothing in it saying what to change.
  it("refuses the write when the name is already a CNAME", async () => {
    const before = fs.readFileSync(zonePath, "utf8");

    await expect(
      bind.addTxtRecord("kimh4nkyul", DOMAIN, "@", MCP_VALUE)
    ).rejects.toThrow(/validation failed/i);

    // The live file is not touched: bind.js validates the temp copy and only
    // renames it in once BIND has accepted it.
    expect(fs.readFileSync(zonePath, "utf8")).toBe(before);
    expect(checkzone().ok).toBe(true);
  });

  // ...and the reason it refuses is the one we think it is, in BIND's words.
  it("fails with 'CNAME and other data', not something else", () => {
    fs.writeFileSync(zonePath, `${ZONE}kimh4nkyul\tIN\tTXT\t"${MCP_VALUE}"\n`);

    const result = checkzone();

    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/CNAME and other data/i);
  });

  // The path 28 owners are on. A TXT at the shared apex name is legal beside
  // anything, including a CNAME subdomain, because it is a different name.
  it("still loads the zone after an apex _vercel append", async () => {
    await bind.addTxtRecord("kimh4nkyul", DOMAIN, "_vercel", "vc-domain-verify=kimh4nkyul,tok");

    const onDisk = fs.readFileSync(zonePath, "utf8");
    expect(onDisk).toContain('_vercel\tIN\tTXT\t"vc-domain-verify=kimh4nkyul,tok"');
    // the token that was already verifying is still there
    expect(onDisk).toContain("demo-token");
    expect(checkzone().ok).toBe(true);
  });

  // The value Jay asked for carries ";" and "=" and spaces. Inside the quoted
  // field none of them is a separator, and validateTxtValue refuses the two
  // characters that could end the field early — `"` and `\`.
  it("keeps a value full of zone-file punctuation in one field", async () => {
    await bind.addTxtRecord("test", DOMAIN, "@", MCP_VALUE);

    const lines = bind.txtRecordName("test", "@");
    expect(lines).toBe("test");

    const read = await bind.listTxtRecords(DOMAIN);
    expect(read).toContainEqual({ name: "test", type: "TXT", value: MCP_VALUE });
    expect(checkzone().ok).toBe(true);
  });
});
