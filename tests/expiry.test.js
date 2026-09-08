import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require2 = createRequire(import.meta.url);

const {
  expiryAfter,
  addMonths,
  daysUntil,
  reminderStageFor,
  shouldSendReminder,
} = require2("../services/expiry.js");

// ---------------------------------------------------------------------------
// The trap this whole file exists to keep shut: dating the existing records
// from when they were created. The oldest of the 44 are from 2025-11, so a
// created_at + 3 months rule expires nearly all of them on the morning the job
// is switched on — before one reminder has gone out or one button been pressed.
// ---------------------------------------------------------------------------

describe("when a record falls due", () => {
  it("measures from the day it starts, never from when the record was made", () => {
    const startedOn = new Date("2026-09-08T00:00:00Z");

    expect(expiryAfter(startedOn, "user")).toEqual(new Date("2026-12-08T00:00:00Z"));
  });

  it("gives an agent-owned record one month", () => {
    const startedOn = new Date("2026-09-08T00:00:00Z");

    expect(expiryAfter(startedOn, "agent")).toEqual(new Date("2026-10-08T00:00:00Z"));
  });

  it("takes only the day it is told about — a creation date cannot reach it", () => {
    // expiryAfter has nowhere to put a created_at even if a caller had one.
    expect(expiryAfter.length).toBe(2);
  });

  it("clamps the day of the month the way MySQL DATE_ADD does", () => {
    // 30 November + 3 months is 28 February, not 2 March. The backfill runs in
    // SQL and renewals run here; the two have to land on the same date.
    expect(addMonths(new Date("2025-11-30T00:00:00Z"), 3)).toEqual(
      new Date("2026-02-28T00:00:00Z")
    );
  });

  it("does not stack when a record is renewed early", () => {
    // Renewing on day one of a period gives three months from that day, not
    // six. Otherwise an agent calling renew in a loop buys itself years.
    const renewedOn = new Date("2026-09-10T00:00:00Z");

    expect(expiryAfter(renewedOn, "user")).toEqual(new Date("2026-12-10T00:00:00Z"));
  });
});

describe("the backfill in deploy/migrations/002-subdomain-expiry.sql", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "deploy/migrations/002-subdomain-expiry.sql"),
    "utf8"
  );
  // strip the commentary so the assertions read the statements, not the prose
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("dates existing rows from the day it is run", () => {
    expect(statements).toMatch(/SET expires_at = DATE_ADD\(NOW\(\), INTERVAL 3 MONTH\)/);
    expect(statements).toMatch(/SET expires_at = DATE_ADD\(NOW\(\), INTERVAL 1 MONTH\)/);
  });

  it("never reads created_at", () => {
    // The one mistake that would empty the service on switch-on day.
    // (The ALTER names created_at only to place the new column after it.)
    for (const update of statements.match(/UPDATE subdomains[\s\S]*?;/g)) {
      expect(update).not.toMatch(/created_at/);
    }
  });

  it("is safe to run twice", () => {
    // Both updates are guarded, so a row that already has a date keeps it.
    const updates = statements.match(/UPDATE subdomains[\s\S]*?;/g);
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update).toMatch(/expires_at IS NULL/);
    }
  });
});

describe("which reminder is due", () => {
  it("stays quiet until a fortnight out", () => {
    expect(reminderStageFor(30)).toBe(null);
    expect(reminderStageFor(15)).toBe(null);
  });

  it("moves through 14, 3 and the day itself", () => {
    expect(reminderStageFor(14)).toBe(14);
    expect(reminderStageFor(4)).toBe(14);
    expect(reminderStageFor(3)).toBe(3);
    expect(reminderStageFor(1)).toBe(3);
    expect(reminderStageFor(0)).toBe(0);
  });

  it("still sends a missed reminder late rather than never", () => {
    // The job runs nightly and a night can be lost to a restart. A record found
    // at 11 days out has not had its 14-day notice, so it gets it now.
    expect(reminderStageFor(11)).toBe(14);
  });

  it("sends each stage once", () => {
    expect(shouldSendReminder(14, null)).toBe(true);
    expect(shouldSendReminder(14, 14)).toBe(false);
    expect(shouldSendReminder(3, 14)).toBe(true);
    expect(shouldSendReminder(3, 3)).toBe(false);
    expect(shouldSendReminder(0, 3)).toBe(true);
    expect(shouldSendReminder(0, 0)).toBe(false);
    expect(shouldSendReminder(null, null)).toBe(false);
  });
});

describe("counting the days left", () => {
  it("reads the day a record falls due as zero, not as a fraction", () => {
    // Due at 15:00, checked at midnight that morning: this is the day, so the
    // last notice goes out. Deletion waits for the next night's run.
    expect(daysUntil("2026-12-08T15:00:00Z", "2026-12-08T00:00:00Z")).toBe(0);
  });

  it("counts a fortnight as a fortnight", () => {
    expect(daysUntil("2026-12-08T00:00:00Z", "2026-11-24T00:00:00Z")).toBe(14);
  });

  it("goes negative once a record is past due", () => {
    expect(daysUntil("2026-12-08T00:00:00Z", "2026-12-10T00:00:00Z")).toBe(-2);
  });
});
