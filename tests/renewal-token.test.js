import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const { sign, verify, TTL_MS } = require2("../services/renewal-token.js");
const config = require2("../configs/index.js");

// ---------------------------------------------------------------------------
// This token works with one click and no sign-in, so it goes wherever the mail
// goes: spam scanners, browser history, a forwarded thread. The requirement is
// that holding one buys you exactly one thing — extending that subdomain — and
// these tests are the fence around that.
// ---------------------------------------------------------------------------

describe("what a renewal token can be used for", () => {
  it("carries one subdomain id and nothing else", () => {
    // No field for an action, a scope or a user, so there is nothing to widen.
    const payload = Buffer.from(sign(42).split(".")[0], "base64url").toString("utf8");
    const parts = payload.split(".");

    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).toBe(42);
    expect(Number(parts[1])).toBeGreaterThan(Date.now()); // the other half is its own expiry
  });

  it("is not a session — @fastify/jwt will not take it", async () => {
    const fastifyJwt = require2("@fastify/jwt");
    const Fastify = require2("fastify");
    const app = Fastify({ logger: false });
    app.register(fastifyJwt, {
      secret: config.jwt.secret,
      verify: { algorithms: ["HS256"] },
    });
    await app.ready();

    // Signed with a key derived for this purpose alone, so the session
    // verifier cannot be talked into accepting one.
    expect(() => app.jwt.verify(sign(42))).toThrow();

    await app.close();
  });

  it("cannot be pointed at a different subdomain", () => {
    const token = sign(42);
    const forged = `${Buffer.from("43.99999999999999").toString("base64url")}.${
      token.split(".")[1]
    }`;

    expect(verify(forged)).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a tampered signature", () => {
    const token = sign(42);
    const [payload, mac] = token.split(".");
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");

    expect(verify(`${payload}.${flipped}`).valid).toBe(false);
  });

  it("stops working after it expires", () => {
    const issuedAt = Date.now();
    const token = sign(42, issuedAt);

    expect(verify(token, issuedAt + TTL_MS - 1000)).toEqual({ valid: true, subdomainId: 42 });
    expect(verify(token, issuedAt + TTL_MS + 1000)).toEqual({ valid: false, reason: "expired" });
  });

  it("turns junk away without deciding anything", () => {
    for (const junk of ["", "nonsense", "a.b.c", null, undefined, 7]) {
      expect(verify(junk).valid, String(junk)).toBe(false);
    }
  });

  it("accepts the one it issued", () => {
    expect(verify(sign(7))).toEqual({ valid: true, subdomainId: 7 });
  });
});
