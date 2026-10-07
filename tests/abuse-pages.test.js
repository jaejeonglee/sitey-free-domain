import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const fs = require2("fs");
const path = require2("path");
const fp = require2("fastify-plugin");

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// /terms, /abuse and /.well-known/security.txt (2026-10-07).
//
// Without a way to report us, a security vendor that finds a phishing page on
// x.sitey.my blocks sitey.my whole. So: a terms page that says what a name may
// not be used for, a report form that needs no account and reaches the
// operator's Telegram, and a security.txt that points at the form.
//
// The real app, booted with plugins/db swapped for a stub (the trick
// tests/discovery.test.js uses), so the global rate limiter, the page router
// and the static footer are the ones that ship.
// ---------------------------------------------------------------------------
const dbPath = require2.resolve("../plugins/db.js");
const inserts = [];

require2.cache[dbPath] = {
  id: dbPath, filename: dbPath, path: dbPath, loaded: true, children: [], paths: [],
  exports: fp(async function stubDb(fastify) {
    fastify.decorate("mysql", {
      execute: async (sql, params = []) => {
        if (/managed_domains/i.test(sql)) return [[{ id: 1, domain_name: "sitey.my" }]];
        if (sql.startsWith("INSERT INTO abuse_reports")) {
          inserts.push(params);
          return [{ insertId: inserts.length, affectedRows: 1 }];
        }
        return [[]];
      },
      getConnection: async () => ({ execute: async () => [[]], release: () => {} }),
    });
  }),
};

delete require2.cache[require2.resolve("../app.js")];
const { buildApp } = require2("../app.js");
const config = require2("../configs/index.js");
const alertService = require2("../services/alert.js");
const accessLog = require2("../services/access-log.js");
const { PAGES } = require2("../routes/pages.js");

let app;
const origWarn = alertService.warn;

beforeAll(async () => {
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  alertService.warn = origWarn;
  await app.close();
  delete require2.cache[dbPath];
});

beforeEach(() => {
  inserts.length = 0;
  alertService.warn = vi.fn(async () => {});
});

const appRoot = (html) => html.match(/<main id="app-root">([\s\S]*?)<\/main>/)[1];

describe("/terms", () => {
  it("is 200 with the rules in the HTML, in English by default", async () => {
    const res = await app.inject({ method: "GET", url: "/terms" });
    const body = appRoot(res.body);

    expect(res.statusCode).toBe(200);
    expect(body).toContain("Terms of Use");
    expect(body).toMatch(/Malware/);
    expect(body).toMatch(/without warning/);
    expect(body).toMatch(/one month/);
    expect(res.body).toContain('<link rel="canonical" href="https://sitey.my/terms" />');
  });

  it("is Korean when asked", async () => {
    const res = await app.inject({ method: "GET", url: "/terms?lang=ko" });
    expect(appRoot(res.body)).toContain("이용약관");
    expect(appRoot(res.body)).toContain("통보 없이");
  });
});

describe("/abuse", () => {
  it("is 200 and carries a form that works without JavaScript", async () => {
    const res = await app.inject({ method: "GET", url: "/abuse" });
    const body = appRoot(res.body);

    expect(res.statusCode).toBe(200);
    expect(body).toContain('id="abuse-form"');
    expect(body).toContain('method="post" action="/api/abuse-reports"');
    for (const name of ["target", "reason", "contact"]) {
      expect(body).toContain(`name="${name}"`);
    }
    expect(body).toMatch(/No account is needed/);
  });

  it("speaks Korean on the form too", async () => {
    const res = await app.inject({ method: "GET", url: "/abuse?lang=ko" });
    expect(appRoot(res.body)).toContain("신고 보내기");
    expect(appRoot(res.body)).toContain('data-sent="고맙습니다');
  });
});

describe("POST /api/abuse-reports", () => {
  const report = { target: "https://toss-login.sitey.my", reason: "fake sign-in page", contact: "me@example.com" };

  it("saves the report and tells the operator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/abuse-reports",
      remoteAddress: "198.51.100.40",
      payload: report,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ success: true });
    expect(inserts).toEqual([
      [report.target, report.reason, report.contact, accessLog.hashIp("198.51.100.40")],
    ]);
    // the raw address is not what is stored
    expect(JSON.stringify(inserts)).not.toContain("198.51.100.40");
    expect(alertService.warn).toHaveBeenCalledTimes(1);
    const [title, context] = alertService.warn.mock.calls[0];
    expect(title).toBe("ABUSE REPORT #1");
    expect(context).toMatchObject({ target: report.target, contact: report.contact });
  });

  it("needs no account and no contact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/abuse-reports",
      remoteAddress: "198.51.100.41",
      payload: { target: "x.sitey.my", reason: "malware" },
    });
    expect(res.statusCode).toBe(201);
    expect(inserts[0][2]).toBeNull();
  });

  it("refuses a report with nothing in it, and says nothing to Telegram", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/abuse-reports",
      remoteAddress: "198.51.100.42",
      payload: { target: "x.sitey.my", reason: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(inserts).toHaveLength(0);
    expect(alertService.warn).not.toHaveBeenCalled();
  });

  it("refuses an overlong reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/abuse-reports",
      remoteAddress: "198.51.100.43",
      payload: { target: "x.sitey.my", reason: "a".repeat(4001) },
    });
    expect(res.statusCode).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("takes the plain form post a browser without JavaScript sends", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/abuse-reports",
      remoteAddress: "198.51.100.44",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "target=x.sitey.my&reason=phishing+page&contact=",
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toMatch(/received/);
    expect(inserts[0].slice(0, 3)).toEqual(["x.sitey.my", "phishing page", null]);
  });

  it("stops one address after five in an hour", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/abuse-reports",
        remoteAddress: "198.51.100.99",
        payload: { target: "x.sitey.my", reason: `report ${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect(alertService.warn).toHaveBeenCalledTimes(5);
  });
});

describe("/.well-known/security.txt", () => {
  it("names the report page as Contact and expires a year out", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    const fields = Object.fromEntries(
      res.body.trim().split("\n").map((line) => line.split(/:\s(.*)/s).slice(0, 2))
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(fields.Contact).toBe(`${config.server.publicOrigin}/abuse`);
    expect(fields.Policy).toBe(`${config.server.publicOrigin}/terms`);
    const days = (Date.parse(fields.Expires) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(365);
    // RFC 9116: Expires is an ISO 8601 date-time
    expect(fields.Expires).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});

describe("the links that lead there", () => {
  it("are in the footer of every page, as markup", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const footer = res.body.match(/<footer>([\s\S]*?)<\/footer>/)[1];
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/abuse"');
  });

  it("are in llms.txt", async () => {
    const res = await app.inject({ method: "GET", url: "/llms.txt" });
    expect(res.body).toContain(`${config.server.publicOrigin}/terms`);
    expect(res.body).toContain(`${config.server.publicOrigin}/abuse`);
    expect(res.body).toMatch(/TXT records need an account/);
  });
});

// 🔴 2026-09-14: /privacy shipped with its body in the HTML and the client
// router wiped it a moment later, because the router did not know the page
// was the server's. Every markdown page has to be on the router's list.
describe("public/modules/router.js knows every server-rendered page", () => {
  it("lists each markdown page in SERVER_RENDERED", () => {
    const source = fs.readFileSync(path.join(ROOT, "public/modules/router.js"), "utf8");
    const listed = source.match(/const SERVER_RENDERED = new Set\(\[([^\]]*)\]\)/)[1];
    const markdownPages = Object.entries(PAGES)
      .filter(([, page]) => page.markdown)
      .map(([route]) => route);

    expect(markdownPages).toEqual(expect.arrayContaining(["/terms", "/abuse"]));
    for (const route of markdownPages) {
      expect(listed, `${route} is missing from SERVER_RENDERED`).toContain(`"${route}"`);
    }
  });
});
