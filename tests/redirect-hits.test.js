import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const config = require2("../configs/index.js");
const redirectHits = require2("../services/redirect-hits.js");
const redirectPlugin = require2("../plugins/redirect.js");
const apiV1Routes = require2("../routes/api-v1.js");
const domainRoutes = require2("../routes/domain.js");
const expiry = require2("../services/expiry.js");
const Fastify = require2("fastify");

// ---------------------------------------------------------------------------
// Counting the visits a REDIRECT answers. The rule that shapes every test
// here: the 301 comes first and the count comes second, so every failure of
// the counter has to be a failure of the counter only.
// ---------------------------------------------------------------------------

/** A fastify-shaped stub: a scripted mysql and a log that remembers. */
function harness(execute) {
  const warnings = [];
  return {
    mysql: { execute },
    log: {
      warn: (...args) => warnings.push(args),
      info: () => {},
      error: () => {},
    },
    warnings,
  };
}

beforeEach(() => {
  redirectHits.clear();
});

afterEach(() => {
  redirectHits.stop();
  redirectHits.clear();
});

describe("what day a visit belongs to", () => {
  // The bug this replaced: CURDATE() is the database server's day, and that
  // server runs on UTC. Somebody in Seoul visiting a link at 1am on the 1st
  // was counted into the previous month, and the dashboard's "this month"
  // was nine hours behind the calendar on every page of it.
  it("reads the clock in Seoul, not in UTC", () => {
    // 00:30 on the 1st in Seoul is still 15:30 on the 31st in UTC
    expect(redirectHits.kstDay(new Date("2026-08-31T15:30:00Z"))).toBe("2026-09-01");
    // and the last minute of the Seoul day is mid-afternoon the same day UTC
    expect(redirectHits.kstDay(new Date("2026-09-18T14:59:00Z"))).toBe("2026-09-18");
    expect(redirectHits.kstDay(new Date("2026-09-18T15:00:00Z"))).toBe("2026-09-19");
  });

  it("does not move with the process timezone either", () => {
    // Korea has no daylight saving, so a fixed offset off a UTC instant is the
    // whole of it — midwinter and midsummer answer the same way.
    expect(redirectHits.kstDay(new Date("2026-01-01T15:00:00Z"))).toBe("2026-01-02");
    expect(redirectHits.kstDay(new Date("2026-07-01T15:00:00Z"))).toBe("2026-07-02");
  });
});

describe("visits are gathered, not written one at a time", () => {
  it("turns many visits into one statement per name", async () => {
    const calls = [];
    const app = harness(async (sql, params) => {
      calls.push({ sql, params });
      return [{ affectedRows: 1 }];
    });

    for (let i = 0; i < 10; i += 1) redirectHits.record(7);
    redirectHits.record(9);
    expect(redirectHits.pendingCount()).toBe(2);

    const result = await redirectHits.flush(app);

    const today = redirectHits.kstDay();

    expect(result).toEqual({ written: 2, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.sql.startsWith("INSERT INTO redirect_hits"))).toBe(true);
    // ten visits, one row, ten added to the day's total
    expect(calls.find((c) => c.params[0] === 7).params.slice(0, 3)).toEqual([7, today, 10]);
    expect(calls.find((c) => c.params[0] === 9).params.slice(0, 3)).toEqual([9, today, 1]);
    // the day is Seoul's and it is ours, not the database's — CURDATE() there
    // reads the server's time_zone, which is UTC, and put nine hours of every
    // evening on the wrong day
    expect(calls[0].sql).not.toContain("CURDATE()");
    expect(calls[0].sql).not.toContain("NOW()");
    // the moment is a Date, so mysql2 converts it out the way it converted it in
    expect(calls[0].params[3]).toBeInstanceOf(Date);
    expect(calls[0].sql).toContain("hits = hits + VALUES(hits)");
    // one day for the whole batch, not one per statement
    expect(calls[0].params[1]).toBe(calls[1].params[1]);
  });

  it("empties the buffer before writing, so a visit mid-flush is not lost or doubled", async () => {
    let arrivedDuringFlush = false;
    const app = harness(async () => {
      if (!arrivedDuringFlush) {
        arrivedDuringFlush = true;
        // a visitor lands while the batch is in the air
        redirectHits.record(7);
      }
      return [{ affectedRows: 1 }];
    });

    redirectHits.record(7);
    await redirectHits.flush(app);

    // the one that arrived mid-flush is still owed, and is written next time
    expect(redirectHits.pendingCount()).toBe(1);

    const calls = [];
    const second = harness(async (sql, params) => {
      calls.push(params);
      return [{ affectedRows: 1 }];
    });
    await redirectHits.flush(second);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual([7, redirectHits.kstDay(), 1]);
  });

  it("writes nothing and says nothing when there is nothing to write", async () => {
    const execute = vi.fn();
    expect(await redirectHits.flush(harness(execute))).toEqual({ written: 0, failed: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("drops a batch it cannot write, warns once, and does not throw", async () => {
    const app = harness(async () => {
      throw new Error("ER_NO_SUCH_TABLE");
    });

    redirectHits.record(1);
    redirectHits.record(2);

    const result = await redirectHits.flush(app);

    expect(result).toEqual({ written: 0, failed: 2 });
    // one line for the batch, not one per name — an outage must not flood
    expect(app.warnings).toHaveLength(1);
    expect(app.warnings[0][0]).toMatchObject({ evt: "redirect_hits", action: "flush_failed", names: 2 });
    // dropped rather than requeued: holding them would grow without bound
    // against a database that is not answering
    expect(redirectHits.pendingCount()).toBe(0);
  });

  it("does not let one dead name take the others' counts down with it", async () => {
    const written = [];
    const app = harness(async (sql, params) => {
      if (params[0] === 2) throw new Error("ER_NO_REFERENCED_ROW_2");
      written.push(params[0]);
      return [{ affectedRows: 1 }];
    });

    redirectHits.record(1);
    redirectHits.record(2);
    redirectHits.record(3);

    expect(await redirectHits.flush(app)).toEqual({ written: 2, failed: 1 });
    expect(written.sort()).toEqual([1, 3]);
  });
});

describe("old day rows are removed", () => {
  it("deletes past the configured retention window", async () => {
    const calls = [];
    const app = harness(async (sql, params) => {
      calls.push({ sql, params });
      return [{ affectedRows: 12 }];
    });

    expect(await redirectHits.prune(app)).toBe(12);
    expect(calls[0].sql).toContain("DELETE FROM redirect_hits");
    // the cutoff is a Seoul day, the same reckoning the rows were written with
    const expected = redirectHits.kstDay(
      new Date(Date.now() - config.redirect.hitRetentionDays * 24 * 60 * 60 * 1000)
    );
    expect(calls[0].params).toEqual([expected]);
  });

  it("keeps a little over a year, so a year-on-year comparison has something to compare", () => {
    expect(config.redirect.hitRetentionDays).toBeGreaterThan(365);
  });

  it("warns rather than throws when it cannot", async () => {
    const app = harness(async () => {
      throw new Error("ER_LOCK_WAIT_TIMEOUT");
    });
    expect(await redirectHits.prune(app)).toBe(0);
    expect(app.warnings[0][0]).toMatchObject({ action: "prune_failed" });
  });
});

describe("reading the counts back", () => {
  it("answers for every name asked about, zeroed when nobody has come", async () => {
    const app = harness(async () => [
      // mysql2 hands SUM() over a BIGINT back as a string
      [{ subdomain_id: 7, total: "31", this_month: "4", last_at: new Date("2026-09-16T10:00:00Z") }],
    ]);

    const byId = await redirectHits.hitsFor(app, [7, 9]);

    expect(byId.get(7)).toEqual({
      total: 31,
      this_month: 4,
      last_at: new Date("2026-09-16T10:00:00Z"),
    });
    // asked for, never visited — a number, not a missing key, because the
    // screen has to tell "nobody clicked" apart from "we could not load this"
    expect(byId.get(9)).toEqual({ total: 0, this_month: 0, last_at: null });
  });

  it("asks nothing when there is nothing to ask about", async () => {
    const execute = vi.fn();
    expect((await redirectHits.hitsFor(harness(execute), [])).size).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows zero rather than failing the whole listing", async () => {
    const app = harness(async () => {
      throw new Error("ER_NO_SUCH_TABLE");
    });
    const byId = await redirectHits.hitsFor(app, [7]);
    expect(byId.get(7)).toEqual({ total: 0, this_month: 0, last_at: null });
    expect(app.warnings[0][0]).toMatchObject({ action: "read_failed" });
  });

  it("counts this month from the 1st in Seoul, not the 1st in UTC", async () => {
    const calls = [];
    await redirectHits.hitsFor(
      harness(async (sql, params) => {
        calls.push({ sql, params });
        return [[]];
      }),
      [1, 2]
    );
    expect(calls[0].sql).toContain("hit_day >= ?");
    expect(calls[0].sql).toContain("IN (?, ?)");
    // the month boundary comes first in the statement, so it comes first here
    expect(calls[0].params).toEqual([`${redirectHits.kstDay().slice(0, 7)}-01`, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// The request path
// ---------------------------------------------------------------------------

describe("the 301 comes first", () => {
  const TARGET = "https://github.com/jay/myapp";

  async function buildApp() {
    const app = Fastify({ logger: false });
    app.decorate("mysql", {
      execute: async (sql, params = []) => {
        if (/managed_domains/i.test(sql)) return [[{ id: 1, domain_name: "sitey.my" }]];
        if (/record_type = 'REDIRECT'/.test(sql)) {
          return [params[0] === "myapp" ? [{ id: 55, record_value: TARGET }] : []];
        }
        return [[]];
      },
    });
    await app.register(redirectPlugin);
    app.get("/", async () => ({ home: true }));
    await app.ready();
    return app;
  }

  it("counts the visit against the record that answered it", async () => {
    const app = await buildApp();
    try {
      for (let i = 0; i < 10; i += 1) {
        const res = await app.inject({ method: "GET", url: "/", headers: { host: "myapp.sitey.my" } });
        expect(res.statusCode).toBe(301);
      }

      const calls = [];
      await redirectHits.flush(
        harness(async (sql, params) => {
          calls.push(params);
          return [{ affectedRows: 1 }];
        })
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].slice(0, 3)).toEqual([55, redirectHits.kstDay(), 10]);
    } finally {
      redirectHits.clear();
      await app.close();
    }
  });

  it("still redirects when counting throws", async () => {
    const app = await buildApp();
    const original = redirectHits.record;
    redirectHits.record = () => {
      throw new Error("counter is on fire");
    };
    try {
      const res = await app.inject({ method: "GET", url: "/", headers: { host: "myapp.sitey.my" } });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe(TARGET);
    } finally {
      redirectHits.record = original;
      redirectHits.clear();
      await app.close();
    }
  });

  it("counts nothing for a name with no REDIRECT record", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/", headers: { host: "nobody.sitey.my" } });
      expect(res.statusCode).toBe(404);
      expect(redirectHits.pendingCount()).toBe(0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// What the API hands back
// ---------------------------------------------------------------------------

describe("hits travel with a REDIRECT and with nothing else", () => {
  it("adds the object to REDIRECT rows only, and never the row id", async () => {
    const rows = [
      { id: 1, subdomain: "a", domain: "sitey.my", type: "REDIRECT", value: "https://example.com/" },
      { id: 2, subdomain: "b", domain: "sitey.my", type: "A", value: "203.0.113.10" },
      { id: 3, subdomain: "c", domain: "sitey.my", type: "CNAME", value: "x.example.com" },
    ];
    const app = Fastify({ logger: false });
    app.decorate("mysql", {
      execute: async (sql) => {
        if (sql.includes("FROM subdomains s JOIN managed_domains")) return [rows];
        if (sql.includes("FROM redirect_hits")) {
          return [[{ subdomain_id: 1, total: "9", this_month: "2", last_at: new Date("2026-09-16T01:00:00Z") }]];
        }
        return [[]];
      },
    });
    app.register(apiV1Routes, { prefix: "/api/v1" });

    const res = await app.inject({ method: "GET", url: "/api/v1/subdomains" });
    const list = res.json().data.subdomains;

    expect(list[0]).toMatchObject({
      subdomain: "a",
      hits: { total: 9, this_month: 2, last_at: "2026-09-16T01:00:00.000Z" },
    });
    // an A or CNAME is reached straight from DNS; a zero there would be a lie
    expect(list[1].hits).toBeUndefined();
    expect(list[2].hits).toBeUndefined();
    // the join key is not part of the API — a record is addressed by name
    for (const entry of list) expect(entry.id).toBeUndefined();

    await app.close();
  });

  it("asks the counter about nothing when the caller holds no REDIRECT", async () => {
    const queries = [];
    const app = Fastify({ logger: false });
    app.decorate("mysql", {
      execute: async (sql) => {
        queries.push(sql);
        if (sql.includes("FROM subdomains s JOIN managed_domains")) {
          return [[{ id: 2, subdomain: "b", domain: "sitey.my", type: "A", value: "203.0.113.10" }]];
        }
        return [[]];
      },
    });
    app.register(apiV1Routes, { prefix: "/api/v1" });

    await app.inject({ method: "GET", url: "/api/v1/subdomains" });
    expect(queries.some((sql) => sql.includes("redirect_hits"))).toBe(false);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// The renew button's other half
// ---------------------------------------------------------------------------

describe("renewing from the dashboard", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function buildApp({ expiresAt, owned = true }) {
    const updates = [];
    const app = Fastify({ logger: false });
    app.decorate("authenticate", async (request) => {
      request.user = { id: 5 };
    });
    app.decorate("mysql", {
      execute: async (sql, params = []) => {
        if (sql.includes("FROM managed_domains")) return [[{ id: 1, domain_name: "sitey.my" }]];
        if (sql.startsWith("SELECT id FROM subdomains")) return [owned ? [{ id: 42 }] : []];
        if (sql.includes("FROM subdomains s") && sql.includes("WHERE s.id = ?")) {
          return [[{ id: 42, subdomain: "demo", owner_type: "user", expires_at: expiresAt, domain_name: "sitey.my" }]];
        }
        if (sql.startsWith("UPDATE subdomains SET expires_at")) {
          updates.push(params);
          return [{ affectedRows: 1 }];
        }
        return [[]];
      },
    });
    app.register(domainRoutes, { prefix: "/api" });
    return { app, updates };
  }

  it("extends a record inside the window and hands back the new date", async () => {
    const { app, updates } = buildApp({
      expiresAt: new Date(Date.now() + 3 * DAY_MS),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/subdomains/demo/renew",
      payload: { domain: "sitey.my" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, domain: "demo.sitey.my" });
    expect(new Date(res.json().expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(updates).toHaveLength(1);

    await app.close();
  });

  it("refuses outside the window and names the day it opens", async () => {
    const expiresAt = new Date(Date.now() + 60 * DAY_MS);
    const { app, updates } = buildApp({ expiresAt });

    const res = await app.inject({
      method: "POST",
      url: "/api/subdomains/demo/renew",
      payload: { domain: "sitey.my" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("RENEWAL_NOT_DUE");
    // the same door services/expiry.js opens for REST and MCP — the date, not
    // just "not yet"
    expect(res.json().error).toContain(
      new Date(expiresAt.getTime() - expiry.RENEWAL_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
    );
    expect(updates).toHaveLength(0);

    await app.close();
  });

  it("says the same thing for somebody else's record as for one that is not there", async () => {
    const { app } = buildApp({ expiresAt: new Date(Date.now() + DAY_MS), owned: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/subdomains/demo/renew",
      payload: { domain: "sitey.my" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// What the dashboard draws
//
// No jsdom in this repository, so `document` is a stub with the handful of
// methods public/modules/dashboard.js uses. Enough to pin the two things that
// are easy to break: that nothing is hidden behind a fold any more, and that
// the counts appear on a REDIRECT and nowhere else.
// ---------------------------------------------------------------------------

/**
 * Enough of a browser for the module to load and for `t()` to have real words
 * in it: the translations come from the same public/locales file the page
 * fetches, so an assertion here is against the phrase a visitor would read.
 */
async function installBrowser(lang = "en") {
  const fs = require2("fs");
  const path = require2("path");
  const store = new Map();

  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  globalThis.document = {
    documentElement: makeElement("html"),
    createElement: makeElement,
    cookie: "",
  };
  globalThis.fetch = async (url) => {
    const file = path.join(__dirname, "..", "public", url.replace(/^\//, ""));
    const body = fs.readFileSync(file, "utf8");
    return { ok: true, json: async () => JSON.parse(body) };
  };

  const [dashboard, i18n] = await Promise.all([
    import("../public/modules/dashboard.js"),
    import("../public/modules/i18n.js"),
  ]);
  await i18n.loadLang(lang);
  return dashboard;
}

function makeElement(tag) {
  return {
    tagName: tag,
    className: "",
    textContent: "",
    dataset: {},
    attrs: {},
    children: [],
    disabled: false,
    hidden: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
}

/** Every node under `root`, root included. */
function walk(root) {
  return [root, ...root.children.flatMap(walk)];
}

const byClass = (root, name) =>
  walk(root).filter((node) => String(node.className).split(/\s+/).includes(name));

const byAction = (root, action) =>
  walk(root).filter((node) => node.dataset.action === action);

describe("a REDIRECT row on the dashboard", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let createDashboardItem;

  beforeEach(async () => {
    ({ createDashboardItem } = await installBrowser("en"));
  });

  const redirectRow = (overrides = {}) => ({
    id: 1,
    subdomain: "myapp",
    domain_name: "sitey.my",
    record_type: "REDIRECT",
    record_value: "https://github.com/jay/myapp",
    expires_at: new Date(Date.now() + 60 * DAY_MS).toISOString(),
    ...overrides,
  });

  it("shows the value in an editable box with its buttons, unfolded", () => {
    const node = createDashboardItem(redirectRow(), 0);

    const input = byClass(node, "dashboard-record-input")[0];
    expect(input).toBeDefined();
    expect(input.value).toBe("https://github.com/jay/myapp");
    expect(byAction(node, "update")).toHaveLength(1);
    expect(byAction(node, "delete")).toHaveLength(1);

    // nothing is hidden, and nothing is a fold: the accordion's role, its
    // aria-expanded and its chevron are gone with it
    expect(walk(node).some((n) => n.hidden)).toBe(false);
    expect(walk(node).some((n) => n.attrs.role === "button")).toBe(false);
    expect(walk(node).some((n) => "aria-expanded" in n.attrs)).toBe(false);
    expect(byClass(node, "dashboard-item-chevron")).toHaveLength(0);
  });

  it("says how many visits it has answered", () => {
    const node = createDashboardItem(
      redirectRow({ hits: { total: 31, this_month: 4, last_at: "2026-09-16T01:00:00.000Z" } }),
      0
    );
    const hits = byClass(node, "record-hits")[0];
    expect(hits).toBeDefined();
    // the real phrase from public/locales/en.json, with the numbers in it
    expect(hits.textContent).toBe("4 this month \u00b7 31 total \u00b7 last Sep 16");
  });

  it("says so plainly when nobody has clicked it", () => {
    const node = createDashboardItem(
      redirectRow({ hits: { total: 0, this_month: 0, last_at: null } }),
      0
    );
    // the empty phrase, not "0 · 0 · —": three zeroes read as a failure to load
    expect(byClass(node, "record-hits")[0].textContent).toBe("No visits yet");
  });

  it("draws no count on an A or CNAME record", () => {
    for (const [type, value] of [["A", "203.0.113.10"], ["CNAME", "x.example.com"]]) {
      const node = createDashboardItem(
        redirectRow({ record_type: type, record_value: value, hits: undefined }),
        0
      );
      expect(byClass(node, "record-hits"), type).toHaveLength(0);
    }
  });
});

describe("the renew button on the dashboard", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let createDashboardItem;

  beforeEach(async () => {
    ({ createDashboardItem } = await installBrowser("en"));
  });

  // A second of slack on top of the days, because the clock is read twice: once
  // here to build the date and again inside renewState(). Exactly `days * DAY_MS`
  // makes the floor() in there land on `days` only when both reads fall in the
  // same millisecond, so the boundary case below failed whenever the machine was
  // a hair slower. The slack is far smaller than the day it must not cross.
  const rowExpiringIn = (days) =>
    createDashboardItem(
      {
        subdomain: "demo",
        domain_name: "sitey.my",
        record_type: "A",
        record_value: "203.0.113.10",
        expires_at: new Date(Date.now() + days * DAY_MS + 1000).toISOString(),
      },
      0
    );

  it("is pressable inside the window the server accepts", () => {
    const button = byAction(rowExpiringIn(3), "renew")[0];
    expect(button).toBeDefined();
    expect(button.disabled).toBe(false);
  });

  it("is shown and shut before then, with the date on its face", () => {
    const button = byAction(rowExpiringIn(60), "renew")[0];
    // shown, not hidden: a button nobody can see is a feature nobody waits for
    expect(button).toBeDefined();
    expect(button.disabled).toBe(true);
    // the date is on the button, not only in a tooltip — a title attribute is
    // invisible on a phone, which is where most of these are read
    const opensAt = new Date(Date.now() + (60 - expiry.RENEWAL_WINDOW_DAYS) * DAY_MS);
    const date = opensAt.toLocaleDateString("en", { month: "short", day: "numeric" });
    expect(button.textContent).toBe(`From ${date}`);
    expect(button.attrs["aria-label"]).toContain(date);
  });

  it("opens exactly where services/expiry.js opens it", () => {
    expect(byAction(rowExpiringIn(expiry.RENEWAL_WINDOW_DAYS), "renew")[0].disabled).toBe(false);
    expect(byAction(rowExpiringIn(expiry.RENEWAL_WINDOW_DAYS + 1), "renew")[0].disabled).toBe(true);
  });

  it("is not drawn at all for a record that never expires", () => {
    const node = createDashboardItem(
      { subdomain: "demo", domain_name: "sitey.my", record_type: "A", record_value: "203.0.113.10", expires_at: null },
      0
    );
    // nothing to wait for, so there is nothing to show — unlike the shut
    // button above, which is waiting for a date
    expect(byAction(node, "renew")).toHaveLength(0);
  });
});
