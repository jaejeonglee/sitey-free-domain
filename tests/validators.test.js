import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);
const { validateHostPrefix } = require2("../utils/validators.js");

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
      "apex": "@",
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
});
