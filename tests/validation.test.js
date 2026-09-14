import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const { probeRecord, validateRecord, noteReachability } = require2("../services/validation.js");

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

// The write paths used to reduce the probe to a yes/no and refuse on "no".
// They now take the whole verdict, log it and pass it on, so what is worth
// pinning is that the verdict survives the trip and carries something a caller
// can act on. tests/unreachable-create.test.js checks the routes themselves.
describe("noteReachability", () => {
  function collectingLog() {
    const lines = [];
    return {
      lines,
      info: (obj, msg) => lines.push({ level: "info", obj, msg }),
      warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
    };
  }

  it("keeps the probe's own verdict and adds something to tell the caller", async () => {
    const log = collectingLog();

    const reach = await noteReachability(log, {
      recordType: "CNAME",
      recordValue: "gone.invalid",
      subdomain: "demo",
      domain: "example.com",
      phase: "create",
    });

    expect(reach.ok).toBe(false);
    expect(reach.detail).toMatch(/failed:/);
    expect(reach.note).toContain("gone.invalid");
    // The point of the whole change: the name is issued regardless, and the
    // caller is told what it is pointing at rather than turned away.
    expect(reach.note).toMatch(/written anyway/i);
  });

  it("writes one line carrying the check that produced the verdict", async () => {
    const log = collectingLog();

    await noteReachability(log, {
      recordType: "CNAME",
      recordValue: "gone.invalid",
      subdomain: "demo",
      domain: "example.com",
      phase: "update",
    });

    expect(log.lines).toHaveLength(1);
    expect(log.lines[0].level).toBe("warn");
    expect(log.lines[0].obj).toMatchObject({
      evt: "validate",
      phase: "update",
      subdomain: "demo",
      domain: "example.com",
      type: "CNAME",
      value: "gone.invalid",
      result: "unreachable",
    });
    expect(log.lines[0].obj.detail).toMatch(/failed:/);
  });

  it("has no note and logs at info when the target answers", async () => {
    const log = collectingLog();

    // MX is not a type the probe opens, so it comes back ok without a request.
    const reach = await noteReachability(log, {
      recordType: "MX",
      recordValue: "mail.example.com",
      subdomain: "demo",
      domain: "example.com",
      phase: "create",
    });

    expect(reach.ok).toBe(true);
    expect(reach.note).toBe(null);
    expect(log.lines[0].level).toBe("info");
    expect(log.lines[0].obj.result).toBe("ok");
  });

  it("treats an empty value as unanswered rather than as an error", async () => {
    const log = collectingLog();

    const reach = await noteReachability(log, {
      recordType: "CNAME",
      recordValue: "",
      subdomain: "demo",
      domain: "example.com",
      phase: "create",
    });

    expect(reach.ok).toBe(false);
    expect(reach.note).toBeTruthy();
  });
});
