import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const Fastify = require2("fastify");
const pageRoutes = require2("../routes/pages.js");

const ORIGIN = "https://sitey.my";

function canonicalOf(html) {
  return html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
}
function metaOf(html, attr, name) {
  return html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];
}
function titleOf(html) {
  return html.match(/<title>([\s\S]*?)<\/title>/)?.[1];
}

describe("per-path canonical and Open Graph tags", () => {
  let app;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(pageRoutes);
    // mirrors app.js: unknown URLs are a real 404, not the home page
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        return app.sendPageNotFound(reply);
      }
      reply.code(404).send({ error: "Not Found" });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Every subpage used to declare the home page as its canonical, so /docs and
  // /blog/:slug were treated as duplicates of "/".
  it.each([
    ["/", `${ORIGIN}/`],
    ["/docs", `${ORIGIN}/docs`],
    ["/blog", `${ORIGIN}/blog`],
    ["/help", `${ORIGIN}/help`],
    ["/login", `${ORIGIN}/login`],
    ["/dashboard", `${ORIGIN}/dashboard`],
  ])("%s declares itself canonical", async (url, expected) => {
    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(canonicalOf(res.body)).toBe(expected);
    expect(metaOf(res.body, "property", "og:url")).toBe(expected);
  });

  it("gives each path its own title and description", async () => {
    const home = await app.inject({ method: "GET", url: "/" });
    const docs = await app.inject({ method: "GET", url: "/docs" });

    expect(titleOf(docs.body)).toBe("Docs — Sitey");
    expect(titleOf(home.body)).not.toBe(titleOf(docs.body));

    // the social tags follow the page, not the home page
    expect(metaOf(docs.body, "property", "og:title")).toBe("Docs — Sitey");
    expect(metaOf(docs.body, "name", "twitter:title")).toBe("Docs — Sitey");
    expect(metaOf(docs.body, "name", "description")).toBe(
      metaOf(docs.body, "property", "og:description")
    );
    expect(metaOf(docs.body, "name", "description")).not.toBe(
      metaOf(home.body, "name", "description")
    );
  });

  it("points duplicate paths at one canonical", async () => {
    const guide = await app.inject({ method: "GET", url: "/guide" });
    const signup = await app.inject({ method: "GET", url: "/signup" });
    const indexHtml = await app.inject({ method: "GET", url: "/index.html" });

    expect(canonicalOf(guide.body)).toBe(`${ORIGIN}/docs`);
    expect(canonicalOf(signup.body)).toBe(`${ORIGIN}/login`);
    expect(canonicalOf(indexHtml.body)).toBe(`${ORIGIN}/`);
  });

  it("keeps the dashboard out of the index", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.body).toContain('<meta name="robots" content="noindex, follow" />');
  });

  it("leaves indexable pages without a robots meta", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.body).not.toContain('name="robots"');
  });

  it("never leaves the old hard-coded host in the delivered HTML", async () => {
    for (const url of ["/", "/docs", "/blog", "/dashboard"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toContain("www.sitey.one");
    }
  });

  describe("blog posts", () => {
    it("takes the title and description from the post", async () => {
      const res = await app.inject({ method: "GET", url: "/blog/mcp-support" });

      expect(res.statusCode).toBe(200);
      expect(canonicalOf(res.body)).toBe(`${ORIGIN}/blog/mcp-support`);
      expect(titleOf(res.body)).toContain("Sitey");
      expect(titleOf(res.body)).not.toBe("Blog — Sitey");
    });

    it("404s an unknown slug instead of serving the home page", async () => {
      const res = await app.inject({ method: "GET", url: "/blog/no-such-post" });

      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('name="robots"');
    });
  });

  // The old handler answered every unknown URL with index.html and a 200.
  describe("soft 404s are gone", () => {
    it.each(["/no-such-page", "/docs/extra", "/random/deep/path"])(
      "%s returns 404",
      async (url) => {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(404);
        expect(res.body).toContain('<meta name="robots" content="noindex, follow" />');
      }
    );

    it("keeps unknown API paths as JSON", async () => {
      const res = await app.inject({ method: "GET", url: "/api/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Not Found" });
    });
  });
});
