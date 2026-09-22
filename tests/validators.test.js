import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);
const { validateHostPrefix, checkTxtRecordName } = require2("../utils/validators.js");

describe("validateHostPrefix", () => {
  it("accepts the prefixes real verification services ask for", () => {
    for (const prefix of [
      "_vercel",
      "_acme-challenge",
      "_dmarc",
      "selector1._domainkey",
      "verify",
      "a",
      "x9-y",
    ]) {
      expect(validateHostPrefix(prefix)).toEqual({ valid: true, value: prefix });
    }
  });

  it("lowercases and trims", () => {
    expect(validateHostPrefix("  _VERCEL  ")).toEqual({
      valid: true,
      value: "_vercel",
    });
  });

  it("requires a value", () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(validateHostPrefix(empty).valid).toBe(false);
    }
  });

  // These are the inputs that made the prefix dangerous: the prefix becomes the
  // *name* field of a zone file line, so anything containing whitespace, a
  // comment marker or a directive character can append records of its own.
  describe("zone file injection", () => {
    const attacks = {
      "extra fields via space": '_vercel\tIN\tA\t1.2.3.4\n@',
      "newline starts a new record": "_vercel\n@\tIN\tA\t6.6.6.6",
      "carriage return": "_vercel\r@",
      "comment marker": "_vercel ; @ IN A 6.6.6.6",
      "zone directive": "$ORIGIN evil.com.",
      // "apex": "@" was here until 2026-09-22. It is no longer an injection
      // vector because it is no longer a name: bind.txtRecordName turns it
      // into the subdomain, and the subdomain is a row the caller was found to
      // own, never a string they typed. See "the self name" below.
      "wildcard": "*",
      "quote": '_vercel"',
      "leading dot": "._vercel",
      "trailing dot makes the name absolute": "_vercel.",
      "empty label": "_vercel..demo",
      "space": "_ver cel",
      "unicode": "_베르셀",
      "label over 63 chars": "a".repeat(64),
    };

    for (const [name, value] of Object.entries(attacks)) {
      it(`rejects ${name}`, () => {
        expect(validateHostPrefix(value).valid).toBe(false);
      });
    }

    it("rejects an over-long prefix", () => {
      expect(validateHostPrefix("ab.".repeat(40)).valid).toBe(false);
    });
  });

  // "@" means the subdomain's own name — `test.sitey.my IN TXT "..."` rather
  // than `_vercel.sitey.my IN TXT "..."`. It is spelled the way a zone file
  // spells "the name I am already at", and it is the one string the label
  // grammar can never produce, so nothing a caller invents collides with it.
  describe("the self name", () => {
    it("accepts @ and hands it back unchanged", () => {
      expect(validateHostPrefix("@")).toEqual({ valid: true, value: "@" });
      expect(validateHostPrefix("  @  ")).toEqual({ valid: true, value: "@" });
    });

    // The apex allow-list exists because a prefix at the root is a claim about
    // the root domain. "@" makes no such claim — the caller owns the name
    // already — so the list has nothing to say about it.
    it("accepts @ whatever the apex allow-list holds", () => {
      expect(validateHostPrefix("@", { allowed: ["_vercel"] }).valid).toBe(true);
      expect(validateHostPrefix("@", { allowed: [] }).valid).toBe(true);
    });

    it("still refuses the apex list to anything else", () => {
      expect(validateHostPrefix("_acme-challenge", { allowed: ["_vercel"] }).valid).toBe(false);
    });

    // Only the bare "@" is the marker. Anything with it embedded is an
    // ordinary prefix and fails the label grammar, as it always did.
    it.each(["@@", "@.demo", "demo.@", "_vercel@", "@_vercel"])(
      "rejects %s",
      (value) => {
        expect(validateHostPrefix(value).valid).toBe(false);
      }
    );
  });

  // The rule that keeps the self name legal in DNS.
  describe("checkTxtRecordName", () => {
    it("refuses a self-named TXT on a CNAME record", () => {
      const result = checkTxtRecordName("@", "CNAME");
      expect(result.valid).toBe(false);
      expect(result.code).toBe("CNAME_CANNOT_HOLD_TXT");
      // The message has to say what to do, not just that it failed.
      expect(result.message).toMatch(/A record/);
    });

    it("allows a self-named TXT on A and REDIRECT", () => {
      expect(checkTxtRecordName("@", "A").valid).toBe(true);
      // A REDIRECT's zone line is an A record for this server, and A and TXT
      // share a name happily (bind.zoneRecordFor).
      expect(checkTxtRecordName("@", "REDIRECT").valid).toBe(true);
    });

    // An apex prefix is a different name from the subdomain, so a CNAME at the
    // subdomain has nothing to say about it. This is the path 28 owners use.
    it("leaves an apex prefix alone on every record type", () => {
      for (const type of ["A", "CNAME", "REDIRECT"]) {
        expect(checkTxtRecordName("_vercel", type).valid).toBe(true);
      }
    });
  });
});
