import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);
const fs = require2("fs");
const path = require2("path");

const PUBLIC = path.join(__dirname, "..", "public");

const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(PUBLIC, "locales", `${name}.json`), "utf8"));

const en = read("en");
const ko = read("ko");

const indexHtml = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const moduleSource = fs
  .readdirSync(path.join(PUBLIC, "modules"))
  .filter((file) => file.endsWith(".js"))
  .map((file) => fs.readFileSync(path.join(PUBLIC, "modules", file), "utf8"))
  .join("\n");

/**
 * A phrase that exists in one language and not the other does not fall back to
 * the other language — public/modules/i18n.js returns the key itself, so the
 * page shows "home.point.mcp.desc" to half its visitors. Nothing on screen
 * says which half, which is why this is a test and not a habit.
 */
describe("the two locales stay the same shape", () => {
  it("defines the same keys in both", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
  });

  it("leaves no phrase empty", () => {
    for (const [name, strings] of [["en", en], ["ko", ko]]) {
      for (const [key, value] of Object.entries(strings)) {
        expect(typeof value, `${name} ${key}`).toBe("string");
        expect(value.trim(), `${name} ${key}`).not.toBe("");
      }
    }
  });

  // A translation may leave a value out — the Korean success toast says the
  // domain and not the record type on purpose — but it may not ask for one the
  // caller was never told to pass, which renders as a literal "{type}" on
  // screen. English is the reference because it is what i18n.js falls back to
  // and what the call sites were written against.
  it("asks for no value English does not supply", () => {
    const slots = (value) => new Set(value.match(/\{[a-z]+\}/g) || []);
    for (const key of Object.keys(en)) {
      const supplied = slots(en[key]);
      for (const slot of slots(ko[key])) {
        expect(supplied.has(slot), `ko ${key} uses ${slot}`).toBe(true);
      }
    }
  });
});

describe("every key the page asks for exists", () => {
  const declared = [
    ...indexHtml.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g),
  ].map((match) => match[1]);

  it("finds the markup's data-i18n keys", () => {
    expect(declared.length).toBeGreaterThan(10);
    for (const key of declared) {
      expect(en, key).toHaveProperty(key);
      expect(ko, key).toHaveProperty(key);
    }
  });

  it("finds the keys the modules look up", () => {
    // Only literal lookups are reachable from here; anything assembled from a
    // variable is left to the caller that passes a literal in.
    const looked = new Set(
      [...moduleSource.matchAll(/\bt\(\s*"([a-z][\w.]*\.[\w.]+)"/g)].map((m) => m[1])
    );
    expect(looked.size).toBeGreaterThan(10);
    for (const key of looked) {
      expect(en, key).toHaveProperty(key);
      expect(ko, key).toHaveProperty(key);
    }
  });
});
