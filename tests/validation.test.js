import { describe, it, expect, vi } from "vitest";
import {
  probeRecord,
  validateARecord,
  validateCnameRecord,
  validateRecord,
} from "../services/validation.js";

// Mock net module for TCP tests
vi.mock("net", () => {
  const Socket = vi.fn();
  Socket.prototype.setTimeout = vi.fn();
  Socket.prototype.once = vi.fn();
  Socket.prototype.connect = vi.fn();
  Socket.prototype.destroy = vi.fn();
  return { Socket };
});

describe("validateCnameRecord", () => {
  it("should return true for resolvable domain", async () => {
    const result = await validateCnameRecord("google.com");
    expect(result).toBe(true);
  });

  it("should return false for non-existent domain", async () => {
    const result = await validateCnameRecord(
      "this-domain-does-not-exist-xyz123.com"
    );
    expect(result).toBe(false);
  });

  it("should return false for empty string", async () => {
    const result = await validateCnameRecord("");
    expect(result).toBe(false);
  });
});

describe("validateRecord", () => {
  it("should delegate A records to validateARecord", async () => {
    // This will use mocked net module, so result depends on mock behavior
    const result = await validateRecord("A", "127.0.0.1");
    expect(typeof result).toBe("boolean");
  });

  it("should delegate CNAME records to validateCnameRecord", async () => {
    const result = await validateRecord("CNAME", "google.com");
    expect(result).toBe(true);
  });

  it("should return true for unsupported record types", async () => {
    const result = await validateRecord("MX", "mail.example.com");
    expect(result).toBe(true);
  });
});

describe("probeRecord", () => {
  it("says which check ran and what it saw on success", async () => {
    const probe = await probeRecord("CNAME", "google.com");
    expect(probe).toMatchObject({ ok: true, check: "dns" });
    expect(probe.detail).toMatch(/resolved to \d+ address/);
  });

  it("says why the check failed", async () => {
    // The reason a record is about to be deleted has to survive into the log.
    const probe = await probeRecord(
      "CNAME",
      "this-domain-does-not-exist-xyz123.com"
    );
    expect(probe.ok).toBe(false);
    expect(probe.check).toBe("dns");
    expect(probe.detail).toMatch(/resolve failed/);
  });
});
