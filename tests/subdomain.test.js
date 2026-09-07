import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Get the CJS module objects that subdomain.js actually uses via require().
// We monkey-patch their exported functions before each test.
// ---------------------------------------------------------------------------

const bindMod = require2("../services/bind.js");
const alertMod = require2("../services/alert.js");
const { createSubdomain, updateSubdomain, deleteSubdomain } = require2("../services/subdomain.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnection() {
  return {
    execute: vi.fn().mockResolvedValue([[]]),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

function makeFastify(conn) {
  return {
    mysql: { getConnection: vi.fn().mockResolvedValue(conn) },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

const BASE_PARAMS = {
  userId: 1,
  domainId: 10,
  subdomain: "test",
  domain: "example.com",
  recordValue: "1.2.3.4",
  recordType: "A",
};

// Save originals so we can restore
const origBind = {};
const origAlert = {};

beforeEach(() => {
  // Save originals
  for (const key of Object.keys(bindMod)) {
    origBind[key] = bindMod[key];
  }
  for (const key of Object.keys(alertMod)) {
    origAlert[key] = alertMod[key];
  }

  // Replace with mocks
  bindMod.findDnsRecord = vi.fn().mockResolvedValue(false);
  bindMod.createDnsRecord = vi.fn().mockResolvedValue({
    name: "test.example.com",
    content: "1.2.3.4",
    type: "A",
  });
  bindMod.updateDnsRecord = vi.fn().mockResolvedValue({
    name: "test.example.com",
    content: "9.9.9.9",
    type: "A",
  });
  bindMod.deleteDnsRecord = vi.fn().mockResolvedValue({
    name: "test.example.com",
    type: "A",
  });
  bindMod.readDnsRecord = vi.fn().mockResolvedValue(null);
  bindMod.addTxtRecord = vi.fn().mockResolvedValue({});
  bindMod.deleteTxtRecord = vi.fn().mockResolvedValue({});

  alertMod.warn = vi.fn().mockResolvedValue(undefined);
  alertMod.critical = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  // Restore originals
  for (const key of Object.keys(origBind)) {
    bindMod[key] = origBind[key];
  }
  for (const key of Object.keys(origAlert)) {
    alertMod[key] = origAlert[key];
  }
});

// ---------------------------------------------------------------------------
// createSubdomain
// ---------------------------------------------------------------------------

describe("createSubdomain compensation", () => {
  let conn;
  let fastify;

  beforeEach(() => {
    conn = makeConnection();
    fastify = makeFastify(conn);
  });

  it("calls deleteDnsRecord when commit throws after BIND write", async () => {
    conn.commit.mockRejectedValue(new Error("DB commit failed"));

    await expect(createSubdomain(fastify, BASE_PARAMS)).rejects.toThrow("DB commit failed");
    expect(bindMod.deleteDnsRecord).toHaveBeenCalledWith("test", "example.com", "A");
  });

  it("calls alertService.warn when compensation succeeds", async () => {
    conn.commit.mockRejectedValue(new Error("DB commit failed"));

    await expect(createSubdomain(fastify, BASE_PARAMS)).rejects.toThrow();
    expect(alertMod.warn).toHaveBeenCalledWith(
      "ORPHAN_COMPENSATED",
      expect.objectContaining({ subdomain: "test", domain: "example.com" })
    );
  });

  it("calls alertService.critical when compensation fails", async () => {
    conn.commit.mockRejectedValue(new Error("DB commit failed"));
    bindMod.deleteDnsRecord.mockRejectedValue(new Error("BIND delete failed"));

    await expect(createSubdomain(fastify, BASE_PARAMS)).rejects.toThrow("DB commit failed");
    expect(alertMod.critical).toHaveBeenCalledWith(
      "ORPHAN_COMPENSATION_FAILED",
      expect.objectContaining({ subdomain: "test", domain: "example.com" })
    );
  });

  // createDnsRecord writes the zone line and *then* runs named-checkzone /
  // reload, so a throw from it is the most likely way to leave an orphan.
  // Compensation used to be skipped for exactly this case.
  it("compensates when the BIND write itself throws", async () => {
    bindMod.createDnsRecord.mockRejectedValue(new Error("BIND write failed"));

    await expect(createSubdomain(fastify, BASE_PARAMS)).rejects.toThrow("BIND write failed");
    expect(bindMod.deleteDnsRecord).toHaveBeenCalledWith("test", "example.com", "A");
    expect(alertMod.warn).toHaveBeenCalledWith(
      "ORPHAN_COMPENSATED",
      expect.objectContaining({ subdomain: "test", domain: "example.com" })
    );
    expect(alertMod.critical).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateSubdomain
// ---------------------------------------------------------------------------

describe("updateSubdomain compensation", () => {
  let conn;
  let fastify;

  const UPDATE_PARAMS = {
    recordId: 42,
    subdomain: "test",
    domain: "example.com",
    recordValue: "9.9.9.9",
    recordType: "A",
  };

  beforeEach(() => {
    conn = makeConnection();
    fastify = makeFastify(conn);
    // Return old record value from SELECT ... FOR UPDATE
    conn.execute.mockResolvedValue([[{ record_value: "1.2.3.4" }]]);
  });

  it("calls reverse updateDnsRecord with old value when commit throws", async () => {
    conn.commit.mockRejectedValue(new Error("DB commit failed"));
    // readDnsRecord returns the new value (our write is still there)
    bindMod.readDnsRecord.mockResolvedValue({ name: "test", type: "A", value: "9.9.9.9" });

    await expect(updateSubdomain(fastify, UPDATE_PARAMS)).rejects.toThrow("DB commit failed");

    // updateDnsRecord: first call is the original update, second is the compensation
    const calls = bindMod.updateDnsRecord.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(["test", "1.2.3.4", "example.com", "A"]);
    expect(alertMod.warn).toHaveBeenCalledWith(
      "UPDATE_COMPENSATED",
      expect.objectContaining({ subdomain: "test" })
    );
  });
});

// ---------------------------------------------------------------------------
// deleteSubdomain
// ---------------------------------------------------------------------------

describe("deleteSubdomain compensation", () => {
  let conn;
  let fastify;

  const DELETE_PARAMS = {
    recordId: 42,
    subdomain: "test",
    domain: "example.com",
    recordType: "A",
  };

  beforeEach(() => {
    conn = makeConnection();
    fastify = makeFastify(conn);
    conn.execute
      .mockResolvedValueOnce([[{ record_value: "1.2.3.4", record_type: "A" }]])
      .mockResolvedValueOnce([[]])   // no txt records
      .mockResolvedValueOnce([])     // DELETE txt
      .mockResolvedValueOnce([]);    // DELETE subdomain
  });

  it("calls createDnsRecord to restore when commit throws after BIND delete", async () => {
    conn.commit.mockRejectedValue(new Error("DB commit failed"));
    bindMod.readDnsRecord.mockResolvedValue(null);

    await expect(deleteSubdomain(fastify, DELETE_PARAMS)).rejects.toThrow("DB commit failed");
    expect(bindMod.createDnsRecord).toHaveBeenCalledWith("test", "1.2.3.4", "example.com", "A");
    expect(alertMod.warn).toHaveBeenCalledWith(
      "DELETE_COMPENSATED",
      expect.objectContaining({ subdomain: "test" })
    );
  });

  it("SELECT is inside transaction (after beginTransaction)", async () => {
    const callOrder = [];
    conn.beginTransaction.mockImplementation(() => {
      callOrder.push("beginTransaction");
      return Promise.resolve();
    });
    conn.execute.mockReset();
    conn.execute.mockImplementation((...args) => {
      callOrder.push("execute:" + (typeof args[0] === "string" ? args[0].slice(0, 20) : "?"));
      if (args[0]?.startsWith("SELECT record_value")) {
        return Promise.resolve([[{ record_value: "1.2.3.4", record_type: "A" }]]);
      }
      if (args[0]?.startsWith("SELECT host_prefix")) {
        return Promise.resolve([[]]);
      }
      return Promise.resolve([[]]);
    });
    conn.commit.mockImplementation(() => {
      callOrder.push("commit");
      return Promise.resolve();
    });

    await deleteSubdomain(fastify, DELETE_PARAMS);

    const beginIdx = callOrder.indexOf("beginTransaction");
    const firstSelectIdx = callOrder.findIndex((c) => c.startsWith("execute:SELECT"));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(firstSelectIdx).toBeGreaterThan(beginIdx);
  });
});
