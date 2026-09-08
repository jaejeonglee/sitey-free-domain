import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const { purgeCandidates, mapWithLimit } = require2("../deploy/cleanup-unreachable.js");

// ---------------------------------------------------------------------------
// The one-off tidy-up is the only code in the repository that removes a record
// for being unreachable, and it exists to clear a backlog once rather than to
// become a rule again. What keeps it honest is that a record has to have been
// told about, and long enough ago — that rule is pure, so here it is.
// ---------------------------------------------------------------------------

// A fixed clock: "exactly 14 days ago" is a boundary, and a `now` that drifts
// by a millisecond between the fixture and the assertion lands on either side
// of it at random.
const now = new Date("2026-09-08T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

describe("what --purge is allowed to remove", () => {
  it("never removes a record nobody was told about", () => {
    // The whole point of the grace period. A dark record with no notice
    // against it is left alone no matter how long it has been dark.
    const records = [
      { id: 1, unreachable_notified_at: null },
      { id: 2, unreachable_notified_at: undefined },
    ];

    expect(purgeCandidates(records, now, 14)).toEqual([]);
  });

  it("waits out the full grace period", () => {
    const records = [
      { id: 1, unreachable_notified_at: daysAgo(13) },
      { id: 2, unreachable_notified_at: daysAgo(1) },
    ];

    expect(purgeCandidates(records, now, 14)).toEqual([]);
  });

  it("removes the ones whose fortnight has run out", () => {
    const records = [
      { id: 1, unreachable_notified_at: daysAgo(14) },
      { id: 2, unreachable_notified_at: daysAgo(40) },
      { id: 3, unreachable_notified_at: daysAgo(3) },
    ];

    expect(purgeCandidates(records, now, 14).map((r) => r.id)).toEqual([1, 2]);
  });

  it("reads a date stored as a string the same way", () => {
    // mysql2 hands back Date objects, but a hand-run query or a fixture may not.
    const records = [{ id: 1, unreachable_notified_at: daysAgo(20).toISOString() }];

    expect(purgeCandidates(records, now, 14)).toHaveLength(1);
  });
});

describe("probing in parallel", () => {
  it("keeps the results lined up with the inputs", async () => {
    const out = await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 5));
      return n * 10;
    });

    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("does not run more than the limit at once", async () => {
    let running = 0;
    let peak = 0;

    await mapWithLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });

    expect(peak).toBe(2);
  });
});
