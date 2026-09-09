import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The ledger: one balance, however the money arrived.
//
// What is sold is a bundle — five more subdomains for a year — and the two
// things that makes true are tested here. Bundles stack: two payments are ten
// names, not five names for two years. And a bundle ends: the year is written
// down when the payment is recorded, and a bundle past it stops counting.
//
// 🔴 Nothing here says what happens to names already held when a bundle ends,
// because nothing happens to them. See tests/quota.test.js.
// ---------------------------------------------------------------------------

const savedEnv = {};
const ENV = ["SUBDOMAIN_BUNDLE_SIZE", "SUBDOMAIN_BUNDLE_PRICE_MICROS", "SUBDOMAIN_BUNDLE_DAYS"];
for (const key of ENV) savedEnv[key] = process.env[key];

const USER_ID = 7;
const BUNDLE_MICROS = 1000000;

function load() {
  for (const spec of ["../configs/index.js", "../services/credits.js"]) {
    delete require2.cache[require2.resolve(spec)];
  }
  return require2("../services/credits.js");
}

/**
 * A database that answers the balance query, and remembers what it was asked.
 *
 * `rows` are entries on the account. The fake applies the expiry the query
 * asks for rather than assuming it, and the query itself is asserted below —
 * between the two, "a lapsed bundle is not counted" is checked against the SQL
 * that will run on the server and not only against a fake's opinion.
 */
function fakeDb({ rows = [], fails = null } = {}) {
  const queries = [];
  const execute = vi.fn(async (sql, params = []) => {
    queries.push({ sql, params });
    if (fails) throw fails;
    if (sql.includes("FROM credit_entries")) {
      const live = rows.filter((row) => !row.expiresAt || row.expiresAt > new Date());
      return [[{ total: live.reduce((sum, row) => sum + row.amountMicros, 0) }]];
    }
    return [[]];
  });
  const lines = [];
  const log = {
    warn: (obj) => lines.push(obj),
    info: (obj) => lines.push(obj),
    error: (obj) => lines.push(obj),
  };
  return { mysql: { execute }, log, queries, lines };
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function bundle(expiresAt, amountMicros = BUNDLE_MICROS) {
  return { amountMicros, expiresAt };
}

beforeEach(() => {
  for (const key of ENV) delete process.env[key];
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  load();
});

// ---------------------------------------------------------------------------

describe("what a payment buys", () => {
  it("gives five more subdomains for one payment", async () => {
    const credits = load();
    const db = fakeDb({ rows: [bundle(new Date(Date.now() + YEAR_MS))] });

    expect(await credits.slotsFor(db, USER_ID)).toBe(5);
  });

  it("gives ten for two", async () => {
    const credits = load();
    const db = fakeDb({
      rows: [bundle(new Date(Date.now() + YEAR_MS)), bundle(new Date(Date.now() + YEAR_MS))],
    });

    expect(await credits.slotsFor(db, USER_ID)).toBe(10);
  });

  // The bundle is the unit. Half of one is not two or three names.
  it("gives nothing for less than a whole bundle", async () => {
    const credits = load();
    const db = fakeDb({ rows: [bundle(new Date(Date.now() + YEAR_MS), BUNDLE_MICROS / 2)] });

    expect(await credits.slotsFor(db, USER_ID)).toBe(0);
  });

  it("takes the size and the price from the settings, not from the code", async () => {
    process.env.SUBDOMAIN_BUNDLE_SIZE = "2";
    process.env.SUBDOMAIN_BUNDLE_PRICE_MICROS = "500000";
    const credits = load();
    const db = fakeDb({ rows: [bundle(new Date(Date.now() + YEAR_MS))] });

    // 1.00 against a price of 0.50 is two bundles of two
    expect(await credits.slotsFor(db, USER_ID)).toBe(4);
  });

  it("has nothing to attach a balance to without an account", async () => {
    const credits = load();
    const db = fakeDb({ rows: [bundle(new Date(Date.now() + YEAR_MS))] });

    expect(await credits.slotsFor(db, null)).toBe(0);
    expect(db.queries).toHaveLength(0);
  });
});

describe("a bundle that has run out", () => {
  it("is not counted", async () => {
    const credits = load();
    const db = fakeDb({ rows: [bundle(new Date(Date.now() - 1000))] });

    expect(await credits.slotsFor(db, USER_ID)).toBe(0);
  });

  it("leaves the ones still running behind it", async () => {
    const credits = load();
    const db = fakeDb({
      rows: [bundle(new Date(Date.now() - 1000)), bundle(new Date(Date.now() + YEAR_MS))],
    });

    expect(await credits.slotsFor(db, USER_ID)).toBe(5);
  });

  // The database decides what has lapsed, so a clock skewed on this host
  // cannot hand out or withdraw a year.
  it("is excluded by the query itself, against the database's own clock", async () => {
    const credits = load();
    const db = fakeDb();

    await credits.slotsFor(db, USER_ID);

    expect(db.queries[0].sql).toContain("expires_at IS NULL OR expires_at > NOW()");
  });
});

describe("writing a payment down", () => {
  it("dates the bundle a year from the payment", async () => {
    const credits = load();
    const db = fakeDb();
    const now = new Date("2026-09-09T13:00:00Z");

    const result = await credits.record(
      db,
      { userId: USER_ID, payer: "0xa1", amountMicros: BUNDLE_MICROS, channel: "x402", reference: "0xfeed" },
      now
    );

    expect(result).toEqual({ recorded: true });
    const insert = db.queries.find((q) => q.sql.startsWith("INSERT INTO credit_entries"));
    expect(insert.sql).toContain("expires_at");
    expect(insert.params[5]).toEqual(new Date("2027-09-09T13:00:00Z"));
  });

  it("takes the length of a bundle from the settings", async () => {
    process.env.SUBDOMAIN_BUNDLE_DAYS = "30";
    const credits = load();
    const db = fakeDb();
    const now = new Date("2026-09-09T13:00:00Z");

    await credits.record(
      db,
      { userId: USER_ID, amountMicros: BUNDLE_MICROS, channel: "x402", reference: "0xfeed" },
      now
    );

    const insert = db.queries.find((q) => q.sql.startsWith("INSERT INTO credit_entries"));
    expect(insert.params[5]).toEqual(new Date("2026-10-09T13:00:00Z"));
  });

  // A second payment starts its own year rather than pushing the first one
  // out: that is the difference between stacking and extending.
  it("dates a second bundle from when it was bought", async () => {
    const credits = load();
    const db = fakeDb();

    await credits.record(
      db,
      { userId: USER_ID, amountMicros: BUNDLE_MICROS, channel: "x402", reference: "0xone" },
      new Date("2026-09-09T13:00:00Z")
    );
    await credits.record(
      db,
      { userId: USER_ID, amountMicros: BUNDLE_MICROS, channel: "x402", reference: "0xtwo" },
      new Date("2026-10-09T13:00:00Z")
    );

    const inserts = db.queries.filter((q) => q.sql.startsWith("INSERT INTO credit_entries"));
    expect(inserts[0].params[5]).toEqual(new Date("2027-09-09T13:00:00Z"));
    expect(inserts[1].params[5]).toEqual(new Date("2027-10-09T13:00:00Z"));
  });

  it("refuses a payment it cannot name, so it cannot be spent twice", async () => {
    const credits = load();
    const db = fakeDb();

    const result = await credits.record(db, {
      userId: USER_ID, amountMicros: BUNDLE_MICROS, channel: "x402", reference: null,
    });

    expect(result.recorded).toBe(false);
    expect(result.code).toBe("unnameable");
    expect(db.queries).toHaveLength(0);
  });
});

describe("a database the migration has not reached", () => {
  const noTable = () =>
    Object.assign(new Error("Table 'credit_entries' doesn't exist"), {
      code: "ER_NO_SUCH_TABLE", errno: 1146,
    });

  it("reads as no balance rather than failing the request", async () => {
    const credits = load();
    const db = fakeDb({ fails: noTable() });

    expect(await credits.slotsFor(db, USER_ID)).toBe(0);
    expect(db.lines.some((l) => l.evt === "credits" && l.action === "no_table")).toBe(true);
  });

  it("says a payment cannot be recorded rather than losing it silently", async () => {
    const credits = load();
    const db = fakeDb({ fails: noTable() });

    const result = await credits.record(db, {
      userId: USER_ID, amountMicros: BUNDLE_MICROS, channel: "x402", reference: "0xfeed",
    });

    expect(result).toMatchObject({ recorded: false, code: "unrecordable" });
  });
});
