import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The session cookie is `__Host-sitey_token` (2026-10-07).
//
// sitey.my is not on the Public Suffix List, so a page on any user's
// subdomain — a server that is not ours — could set `Domain=sitey.my;
// sitey_token=…` and the site would read it as somebody's session. A
// `__Host-` cookie is refused by the browser unless it is Secure, Path=/ and
// has no Domain, so no subdomain can plant one.
//
// 🔴 The old name must not be read even as a fallback: a fallback is the same
// hole with one more step. It is only cleared, on logout.
//
// Google is faked in the require cache; vi.mock cannot reach through
// createRequire.
// ---------------------------------------------------------------------------

const googleapisPath = require2.resolve("googleapis");
require2.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, path: googleapisPath, loaded: true,
  children: [], paths: [],
  exports: {
    google: {
      auth: {
        OAuth2: class {
          generateAuthUrl() { return "https://accounts.google.com/o/oauth2/auth"; }
          async getToken() { return { tokens: {} }; }
          setCredentials() {}
        },
      },
      oauth2: () => ({
        userinfo: { get: async () => ({ data: { id: "g1", email: "a@example.com", name: "A" } }) },
      }),
    },
  },
};
delete require2.cache[require2.resolve("../routes/user.js")];

const Fastify = require2("fastify");

function connection() {
  return {
    execute: vi.fn(async (sql) => {
      if (sql.startsWith("SELECT id, email FROM users")) return [[{ id: 1, email: "a@example.com" }]];
      return [{ affectedRows: 1 }];
    }),
    release: () => {},
  };
}

let app;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.decorate("mysql", {
    execute: vi.fn(async (sql) => {
      if (sql.includes("FROM user_sessions")) return [[{ 1: 1 }]];
      if (sql.includes("FROM users WHERE id")) {
        return [[{ id: 1, email: "a@example.com", name: "A", picture: null }]];
      }
      return [{ affectedRows: 1 }];
    }),
    getConnection: async () => connection(),
  });
  app.register(require2("../plugins/auth.js"));
  app.register(require2("../routes/user.js"), { prefix: "/api/auth" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete require2.cache[googleapisPath];
});

/** Set-Cookie as an array of raw header lines. */
function setCookies(res) {
  return [].concat(res.headers["set-cookie"] || []);
}

describe("signing in", () => {
  it("sets __Host-sitey_token; Secure; Path=/ and no Domain", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/google/callback?code=x" });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/dashboard");
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const [cookie] = cookies;
    expect(cookie).toMatch(/^__Host-sitey_token=[^;]+;/);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*Path=\/(;|$)/);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});

describe("reading the session", () => {
  const token = () => app.jwt.sign({ id: 1, email: "a@example.com", sessionId: "s1" });

  it("accepts the new name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `__Host-sitey_token=${token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe("a@example.com");
  });

  // 🔴 The whole point. A valid token under the old name is exactly what a
  // subdomain could plant; it must count for nothing.
  it("does not read the old name, even holding a valid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `sitey_token=${token()}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is not swayed by an old-name cookie sitting beside the real one", async () => {
    const planted = app.jwt.sign({ id: 2, email: "victim@example.com", sessionId: "s2" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `sitey_token=${planted}; __Host-sitey_token=${token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(1);
  });
});

describe("signing out", () => {
  it("clears both names", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: `__Host-sitey_token=${app.jwt.sign({ id: 1, email: "a@example.com", sessionId: "s1" })}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const cookies = setCookies(res);
    const cleared = (name) =>
      cookies.find((c) => c.startsWith(`${name}=;`) && /Expires=Thu, 01 Jan 1970/i.test(c));
    expect(cleared("__Host-sitey_token")).toBeTruthy();
    expect(cleared("__Host-sitey_token")).toMatch(/;\s*Secure/i);
    expect(cleared("__Host-sitey_token")).toMatch(/;\s*Path=\//);
    expect(cleared("sitey_token")).toBeTruthy();
  });
});
