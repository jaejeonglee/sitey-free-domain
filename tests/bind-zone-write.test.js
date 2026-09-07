import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const ZONE_PATH = "/zones/db.example.com";

const ZONE_CONTENT = [
  "$TTL 3600",
  "@  IN  SOA  ns1.example.com. admin.example.com. (",
  "    2024010101  ; Serial",
  "    3600        ; Refresh",
  "    900         ; Retry",
  "    604800      ; Expire",
  "    86400 )     ; Minimum TTL",
  "@       IN  NS  ns1.example.com.",
  "www     IN  A   1.2.3.4",
  "demo    IN  CNAME  cname.vercel-dns.com.",
  "_vercel    IN  TXT  \"vc-domain-verify=demo.example.com,demo-token\"",
  // left over from the old per-subdomain naming; nothing writes here any more
  "_vercel.stock    IN  TXT  \"vc-domain-verify=stale\"",
].join("\n");

// ---------------------------------------------------------------------------
// Harness: bind.js promisifies child_process.execFile and reads config at
// module load, so both have to be replaced before the module is re-required.
// ---------------------------------------------------------------------------

describe("zone file writes (BIND_DEV_MODE=false)", () => {
  let bind;
  let fsMod;
  let cpMod;
  let origExecFile;
  const savedEnv = {};

  /** files on the fake disk, keyed by path */
  let disk;
  /** every fs call in order: ["writeFile /path", "rename a b", ...] */
  let fsCalls;
  /** every command bind.js ran: [["named-checkzone", [...]], ...] */
  let commands;
  /** command name -> Error to throw */
  let failCommands;

  function pathsWrittenTo() {
    return fsCalls.filter((c) => c.startsWith("writeFile ")).map((c) => c.slice(10));
  }

  beforeEach(() => {
    for (const key of ["BIND_DEV_MODE", "BIND_DB_PATH", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALERT_CHAT_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.BIND_DEV_MODE = "false";
    process.env.BIND_DB_PATH = "/zones";
    process.env.TELEGRAM_BOT_TOKEN = "test-tok";
    process.env.TELEGRAM_ALERT_CHAT_ID = "123";

    disk = { [ZONE_PATH]: ZONE_CONTENT };
    fsCalls = [];
    commands = [];
    failCommands = {};

    cpMod = require2("child_process");
    origExecFile = cpMod.execFile;
    cpMod.execFile = (cmd, args, cb) => {
      commands.push([cmd, args]);
      if (failCommands[cmd]) {
        cb(failCommands[cmd], "", "");
        return;
      }
      cb(null, "", "");
    };

    for (const modPath of ["../configs/index.js", "../services/bind.js", "../services/alert.js"]) {
      delete require2.cache[require2.resolve(modPath)];
    }
    bind = require2("../services/bind.js");
    fsMod = require2("fs");

    fsMod.promises.readFile = vi.fn(async (p) => {
      fsCalls.push(`readFile ${p}`);
      if (!(p in disk)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return disk[p];
    });
    fsMod.promises.writeFile = vi.fn(async (p, content) => {
      fsCalls.push(`writeFile ${p}`);
      disk[p] = content;
    });
    fsMod.promises.rename = vi.fn(async (from, to) => {
      fsCalls.push(`rename ${from} ${to}`);
      disk[to] = disk[from];
      delete disk[from];
    });
    fsMod.promises.unlink = vi.fn(async (p) => {
      fsCalls.push(`unlink ${p}`);
      delete disk[p];
    });
    fsMod.promises.stat = vi.fn(async (p) => {
      fsCalls.push(`stat ${p}`);
      if (!(p in disk)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mode: 0o100644, uid: 0, gid: 108 };
    });
    fsMod.promises.chown = vi.fn(async () => {});
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
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // #5 — atomic writes
  // -------------------------------------------------------------------------

  describe("atomicity", () => {
    it("validates a temp file and renames it over the zone file", async () => {
      await bind.createDnsRecord("api", "5.6.7.8", "example.com", "A");

      const written = pathsWrittenTo();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^\/zones\/db\.example\.com\.tmp\./);

      // checkzone ran against the temp file, not the live one
      const checkzone = commands.find(([cmd]) => cmd === "named-checkzone");
      expect(checkzone[1]).toEqual(["example.com", written[0]]);

      // ...and only then was it swapped in
      expect(fsCalls).toContain(`rename ${written[0]} ${ZONE_PATH}`);
      expect(commands.map(([cmd]) => cmd)).toContain("systemctl");

      expect(disk[ZONE_PATH]).toContain("api\tIN\tA\t5.6.7.8");
      expect(disk[ZONE_PATH]).toContain("2024010102         ; Serial");
    });

    // This is the bug: the record used to be appended to the live zone file and
    // validated afterwards, so a rejected line stayed behind and broke every
    // later write on that domain.
    it("leaves the live zone file untouched when named-checkzone rejects it", async () => {
      failCommands["named-checkzone"] = new Error("zone example.com/IN: not loaded due to errors.");

      await expect(
        bind.createDnsRecord("api", "5.6.7.8", "example.com", "A")
      ).rejects.toThrow("Zone file validation failed");

      expect(disk[ZONE_PATH]).toBe(ZONE_CONTENT);
      expect(pathsWrittenTo()).not.toContain(ZONE_PATH);
      expect(fsCalls.some((c) => c.startsWith(`rename `) && c.endsWith(ZONE_PATH))).toBe(false);
      // the temp file is cleaned up
      expect(fsCalls.some((c) => c.startsWith("unlink /zones/db.example.com.tmp."))).toBe(true);
      expect(Object.keys(disk)).toEqual([ZONE_PATH]);
    });

    it("does not reload named when validation failed", async () => {
      failCommands["named-checkzone"] = new Error("bad zone");

      await expect(
        bind.createDnsRecord("api", "5.6.7.8", "example.com", "A")
      ).rejects.toThrow();

      expect(commands.map(([cmd]) => cmd)).not.toContain("systemctl");
    });

    it("rolls the zone file back when the reload fails", async () => {
      failCommands["systemctl"] = new Error("Job for named.service failed");

      await expect(
        bind.updateDnsRecord("www", "9.9.9.9", "example.com", "A")
      ).rejects.toThrow("Failed to reload BIND9 service.");

      // named still holds the old zone, so disk must match it again
      expect(disk[ZONE_PATH]).toBe(ZONE_CONTENT);
      expect(Object.keys(disk)).toEqual([ZONE_PATH]);
    });

    it("keeps the mode and owner of the live zone file", async () => {
      await bind.createDnsRecord("api", "5.6.7.8", "example.com", "A");

      const tmpPath = pathsWrittenTo()[0];
      expect(fsMod.promises.writeFile).toHaveBeenCalledWith(tmpPath, expect.any(String), {
        mode: 0o644,
      });
      expect(fsMod.promises.chown).toHaveBeenCalledWith(tmpPath, 0, 108);
    });

    it("aborts before touching anything when the record to update is missing", async () => {
      await expect(
        bind.updateDnsRecord("nope", "9.9.9.9", "example.com", "A")
      ).rejects.toThrow("A record not found in zone file.");

      expect(pathsWrittenTo()).toHaveLength(0);
      expect(commands).toHaveLength(0);
      expect(disk[ZONE_PATH]).toBe(ZONE_CONTENT);
    });

    it("does not write or reload when the record to delete is already absent", async () => {
      const result = await bind.deleteDnsRecord("nope", "example.com", "A");

      expect(result.alreadyAbsent).toBe(true);
      expect(pathsWrittenTo()).toHaveLength(0);
      expect(commands).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // #3 — every owner's TXT value shares one name, so add appends and delete
  //      matches on the value
  // -------------------------------------------------------------------------

  describe("TXT records", () => {
    const DEMO_TOKEN = "vc-domain-verify=demo.example.com,demo-token";

    it("writes at the shared root name, not under the subdomain", async () => {
      const result = await bind.addTxtRecord(
        "shop",
        "example.com",
        "_vercel",
        "vc-domain-verify=shop.example.com,shop-token"
      );

      expect(result.name).toBe("_vercel.example.com");
      expect(disk[ZONE_PATH]).toContain(
        '_vercel\tIN\tTXT\t"vc-domain-verify=shop.example.com,shop-token"'
      );
      expect(disk[ZONE_PATH]).not.toMatch(/^_vercel\.shop\s+IN\s+TXT/im);
    });

    // The bug: creation replaced the line whose *name* matched, so each new
    // token deleted the previous owner's. 28 rows in the database, 3 lines in
    // the zone.
    it("keeps two owners' tokens side by side under the one name", async () => {
      await bind.addTxtRecord("shop", "example.com", "_vercel", "token-shop");
      await bind.addTxtRecord("blog", "example.com", "_vercel", "token-blog");

      expect(disk[ZONE_PATH]).toContain('_vercel\tIN\tTXT\t"token-shop"');
      expect(disk[ZONE_PATH]).toContain('_vercel\tIN\tTXT\t"token-blog"');
      // ...and the value that was already verifying is untouched
      expect(disk[ZONE_PATH]).toContain(DEMO_TOKEN);
    });

    it("removes only the value asked for, leaving the other owners", async () => {
      await bind.addTxtRecord("shop", "example.com", "_vercel", "token-shop");
      await bind.addTxtRecord("blog", "example.com", "_vercel", "token-blog");

      const result = await bind.deleteTxtRecord("shop", "example.com", "_vercel", "token-shop");

      expect(result).toEqual({ name: "_vercel.example.com", deleted: true });
      expect(disk[ZONE_PATH]).not.toContain("token-shop");
      expect(disk[ZONE_PATH]).toContain('_vercel\tIN\tTXT\t"token-blog"');
      expect(disk[ZONE_PATH]).toContain(DEMO_TOKEN);
    });

    it("does not add a second line for a value that is already there", async () => {
      await bind.addTxtRecord("shop", "example.com", "_vercel", "token-shop");
      const writesAfterFirst = pathsWrittenTo().length;

      await bind.addTxtRecord("shop", "example.com", "_vercel", "token-shop");

      expect(disk[ZONE_PATH].match(/"token-shop"/g)).toHaveLength(1);
      // nothing to change, so the zone is not rewritten and named is not reloaded
      expect(pathsWrittenTo()).toHaveLength(writesAfterFirst);
    });

    it("drops the caller's own previous value in the same write", async () => {
      await bind.addTxtRecord("shop", "example.com", "_vercel", "token-old");

      await bind.addTxtRecord("shop", "example.com", "_vercel", "token-new", "token-old");

      expect(disk[ZONE_PATH]).not.toContain("token-old");
      expect(disk[ZONE_PATH]).toContain('_vercel\tIN\tTXT\t"token-new"');
      expect(disk[ZONE_PATH]).toContain(DEMO_TOKEN);
    });

    // Deleting by name would take every other owner's verification with it.
    it("refuses to delete without a value", async () => {
      await expect(
        bind.deleteTxtRecord("shop", "example.com", "_vercel")
      ).rejects.toThrow("requires the value to remove");

      expect(pathsWrittenTo()).toHaveLength(0);
      expect(disk[ZONE_PATH]).toBe(ZONE_CONTENT);
    });

    // "Deleted successfully" for a line that was never found is how records
    // survived deletion and stayed in the zone.
    it("says nothing was removed when the value is not in the zone", async () => {
      const result = await bind.deleteTxtRecord("shop", "example.com", "_vercel", "never-written");

      expect(result).toEqual({
        name: "_vercel.example.com",
        deleted: false,
        alreadyAbsent: true,
      });
      expect(pathsWrittenTo()).toHaveLength(0);
      expect(commands).toHaveLength(0);
    });

    it("leaves records written under the old naming alone", async () => {
      await bind.addTxtRecord("shop", "example.com", "_vercel", "token-shop");
      await bind.deleteTxtRecord("shop", "example.com", "_vercel", "token-shop");

      expect(disk[ZONE_PATH]).toContain('_vercel.stock    IN  TXT  "vc-domain-verify=stale"');
    });

    it("treats a missing zone file as nothing to delete", async () => {
      delete disk[ZONE_PATH];
      const result = await bind.deleteTxtRecord("shop", "example.com", "_vercel", "token-shop");
      expect(result).toEqual({
        name: "_vercel.example.com",
        deleted: false,
        alreadyAbsent: true,
      });
    });
  });
});
