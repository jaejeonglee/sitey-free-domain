import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { savePendingClaim, takePendingClaim, savePendingEdit, takePendingEdit } from "../public/modules/pending-claim.js";

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

// /dashboard?edit=<address> (2026-11-11) — the address whose edit window a
// mail link opens, kept across the sign-in it may have to go through; and,
// when a save found the session gone, what had been typed in that window.
describe("pending edit (?edit=)", () => {
  let original;

  beforeEach(() => {
    original = globalThis.sessionStorage;
    globalThis.sessionStorage = fakeStorage();
  });

  afterEach(() => {
    globalThis.sessionStorage = original;
  });

  it("keeps the address across the sign-in, and only once", () => {
    savePendingEdit("Jay.Sitey.My");
    expect(takePendingEdit()).toEqual({ key: "jay.sitey.my", draft: null });
    expect(takePendingEdit()).toBeNull();
  });

  it("brings back what was typed when the session ran out mid-save", () => {
    savePendingEdit("jay.sitey.my", { value: "mysite.netlify.app", txt: "vc-domain-verify=x", type: "CNAME" });
    expect(takePendingEdit()).toEqual({
      key: "jay.sitey.my",
      draft: { value: "mysite.netlify.app", txt: "vc-domain-verify=x", type: "CNAME" },
    });
  });

  it("drops anything that is not an address", () => {
    for (const key of ["", "jay", "../etc", "jay.sitey.my/x", "<b>.sitey.my", "a".repeat(260) + ".my"]) {
      sessionStorage.setItem("sitey-edit", JSON.stringify({ key }));
      expect(takePendingEdit(), key).toBeNull();
    }
  });

  it("drops a draft in a shape it did not write, and keeps the address", () => {
    sessionStorage.setItem("sitey-edit", JSON.stringify({ key: "jay.sitey.my", draft: { value: 1, txt: "", type: "MX" } }));
    expect(takePendingEdit()).toEqual({ key: "jay.sitey.my", draft: null });
  });

  it("does not throw when storage does", () => {
    globalThis.sessionStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(() => savePendingEdit("jay.sitey.my")).not.toThrow();
    expect(takePendingEdit()).toBeNull();
  });

  it("is a different slot from the home page's claim", () => {
    savePendingClaim("myapp", "sitey.my");
    savePendingEdit("jay.sitey.my");
    expect(takePendingClaim()).toMatchObject({ subdomain: "myapp" });
    expect(takePendingEdit()).toMatchObject({ key: "jay.sitey.my" });
  });
});
