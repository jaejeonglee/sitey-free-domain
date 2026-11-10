import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { savePendingClaim, takePendingClaim } from "../public/modules/pending-claim.js";

// The claim rides sessionStorage across the Google sign-in. Since the first
// screen creates in place (2026-11-10) it also carries the hosting chip, the
// record type and the value — and a claim written by the page before that
// ({subdomain, domain}) still has to read, because somebody can be halfway
// through a sign-in on the day this ships.

const KEY = "sitey-claim";

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe("pending claim", () => {
  let original;

  beforeEach(() => {
    original = globalThis.sessionStorage;
    globalThis.sessionStorage = fakeStorage();
  });

  afterEach(() => {
    globalThis.sessionStorage = original;
  });

  it("carries the chip, the record type and the value across the sign-in", () => {
    savePendingClaim("myapp", "sitey.my", {
      host: "vercel",
      recordType: "CNAME",
      value: "cname.vercel-dns.com",
    });
    expect(takePendingClaim()).toEqual({
      subdomain: "myapp",
      domain: "sitey.my",
      host: "vercel",
      recordType: "CNAME",
      value: "cname.vercel-dns.com",
    });
  });

  it("still reads a claim written before the details existed", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ subdomain: "abcd", domain: "sitey.my" }));
    expect(takePendingClaim()).toEqual({
      subdomain: "abcd",
      domain: "sitey.my",
      host: null,
      recordType: null,
      value: null,
    });
  });

  it("saves the old two-argument call the same way it used to", () => {
    savePendingClaim("abcd", "sitey.my");
    expect(JSON.parse(sessionStorage.getItem(KEY))).toEqual({ subdomain: "abcd", domain: "sitey.my" });
  });

  it("deletes on read, so a plain sign-in later is not bounced home", () => {
    savePendingClaim("myapp", "sitey.my", { host: "server", recordType: "A", value: "203.0.113.10" });
    expect(takePendingClaim()).not.toBeNull();
    expect(takePendingClaim()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("drops a malformed detail but keeps the name", () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        subdomain: "myapp",
        domain: "sitey.my",
        host: "<img src=x>",
        recordType: "TXT",
        value: "x".repeat(2049),
      })
    );
    expect(takePendingClaim()).toEqual({
      subdomain: "myapp",
      domain: "sitey.my",
      host: null,
      recordType: null,
      value: null,
    });
  });

  it("refuses a name the server would refuse", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ subdomain: "-bad", domain: "sitey.my", host: "vercel" }));
    expect(takePendingClaim()).toBeNull();
  });

  it("reads nothing when the value is not JSON", () => {
    sessionStorage.setItem(KEY, "{not json");
    expect(takePendingClaim()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("behaves as if nothing was stored when storage throws", () => {
    globalThis.sessionStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    };
    expect(() => savePendingClaim("myapp", "sitey.my", { host: "vercel" })).not.toThrow();
    expect(takePendingClaim()).toBeNull();
  });
});
