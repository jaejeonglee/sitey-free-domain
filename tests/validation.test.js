import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const { probeRecord, validateRecord } = require2("../services/validation.js");

// ---------------------------------------------------------------------------
// probeRecord asks one question of both record types now — "does this open" —
// where it used to run a TCP connect for A and a DNS lookup for CNAME. The
// lookup was the damaging half: it passes forever for a deleted deployment,
// because the CDN hostname the CNAME points at stays in DNS. The table itself
// lives in services/reachability.js and is pinned in tests/reachability.test.js.
//
// Nothing here reaches the network: .invalid is guaranteed not to resolve and
// loopback refuses immediately.
// ---------------------------------------------------------------------------

describe("probeRecord", () => {
  it("says which check ran and what it saw when nothing answers", async () => {
    // .invalid never resolves (RFC 2606) — no DNS traffic leaves the machine.
    const probe = await probeRecord("CNAME", "gone.invalid");

    expect(probe.ok).toBe(false);
    expect(probe.status).toBe(null);
    expect(probe.detail).toMatch(/failed:/);
  });

  it("makes a request for A records too, not just a TCP connect", async () => {
    // Nothing listens on either web port of this address, so the verdict is
    // the same shape as the CNAME case: an HTTP attempt that got no answer.
    const probe = await probeRecord("A", "127.0.0.1");

    expect(["http", "https"]).toContain(probe.check);
    expect(probe.detail).toMatch(/https|http/);
  });

  it("skips record types it has no way to open", async () => {
    const probe = await probeRecord("MX", "mail.example.com");

    expect(probe).toMatchObject({ ok: true, check: "none", status: null });
  });
});

describe("validateRecord", () => {
  it("reduces the probe to the yes/no the create path needs", async () => {
    expect(await validateRecord("CNAME", "gone.invalid")).toBe(false);
    expect(await validateRecord("MX", "mail.example.com")).toBe(true);
  });

  it("rejects an empty value", async () => {
    expect(await validateRecord("CNAME", "")).toBe(false);
  });
});
