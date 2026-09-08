import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const fs = require2("fs");
const path = require2("path");

const Fastify = require2("fastify");
const pageRoutes = require2("../routes/pages.js");
const { renderPage } = pageRoutes;

const ROOT = path.join(__dirname, "..");

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

/**
 * What the crawler gets without running JavaScript: the contents of
 * <main id="app-root">. The page <template>s are always in the document, so
 * searching the whole body would find login markup on every page.
 */
function appRootOf(html) {
  return html.match(/<main id="app-root">([\s\S]*?)<\/main>/)?.[1] ?? null;
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

  // Everything below is about the body, not the head. The SPA kept every page
  // body inside a <template> and only filled #app-root once the client router
  // ran, so anything that does not execute JavaScript — search crawlers, link
  // previews, AI agents — was handed a blank page.
  describe("the body arrives in the HTML", () => {
    it.each([
      ["/", "Get your free domain"],
      ["/", "What We Deliver"],
      ["/docs", "Get your domain up and running in 3 steps."],
      ["/guide", "1. Check availability"],
      ["/help", "Help & Support"],
      ["/blog", "AI 에이전트가 서브도메인을 만들 수 있게 되었어요 (MCP 지원)"],
      ["/blog/mcp-support", "MCP가 뭔가요?"],
    ])("%s carries %j without JavaScript", async (url, text) => {
      const res = await app.inject({ method: "GET", url });

      expect(res.statusCode).toBe(200);
      expect(appRootOf(res.body)).toContain(text);
    });

    it("links every post from the blog index", async () => {
      const res = await app.inject({ method: "GET", url: "/blog" });

      expect(appRootOf(res.body)).toContain('href="/blog/mcp-support"');
      expect(appRootOf(res.body)).toContain('href="/blog/google-login-update"');
    });

    // A post page carrying only its own title is half the point of this change.
    it("carries the post body, not just its title", async () => {
      const res = await app.inject({ method: "GET", url: "/blog/mcp-support" });
      const body = appRootOf(res.body);

      expect(body).toContain("Model Context Protocol");
      expect(body.length).toBeGreaterThan(1000);
    });

    // Auth-only pages hold nothing a crawler should have, and an indexed empty
    // dashboard shell is worse than no page at all. This guards against someone
    // later adding them to the list without thinking about it.
    it.each(["/login", "/signup", "/dashboard"])(
      "leaves %s empty for crawlers",
      async (url) => {
        const res = await app.inject({ method: "GET", url });

        expect(appRootOf(res.body)).toBe("");
      }
    );

    it("leaves the 404 body empty too", async () => {
      const res = await app.inject({ method: "GET", url: "/no-such-page" });

      expect(appRootOf(res.body)).toBe("");
    });
    // The docs body is built twice: public/modules/docs.js renders it in the
    // browser, services/page-body.js renders the same section on the server.
    // If someone edits one wording and not the other, crawlers get the stale
    // copy — this fails loudly instead.
    it("keeps the docs body in step with the client renderer", async () => {
      const docsJs = fs.readFileSync(path.join(ROOT, "public/modules/docs.js"), "utf8");
      const quickStart = docsJs.slice(
        docsJs.indexOf('"quick-start"'),
        docsJs.indexOf('"vercel"')
      );
      const keys = [...quickStart.matchAll(/t\("([^"]+)"\)/g)].map((m) => m[1]);
      const strings = JSON.parse(
        fs.readFileSync(path.join(ROOT, "public/locales/en.json"), "utf8")
      );

      expect(keys.length).toBeGreaterThan(4);

      const body = appRootOf((await app.inject({ method: "GET", url: "/docs" })).body);
      for (const key of keys) {
        expect(body).toContain(strings[key]);
      }
    });
  });

  // "$&", "$`" and "$'" are replacement patterns for String.replace. Blog
  // titles and post bodies are markdown we do not control, so every insertion
  // goes through a replacer function; a string replacement would splice
  // surrounding document text into the tag.
  describe("substitution tokens in page text", () => {
    const SHELL = [
      '<link rel="canonical" href="https://sitey.my/" />',
      "<title>Sitey</title>",
      '<meta name="description" content="placeholder" />',
      '<main id="app-root"></main>',
    ].join("\n");

    it("inserts $ patterns literally", () => {
      const html = renderPage(SHELL, {
        canonicalPath: "/blog/x",
        title: "Save $& and $` and $'",
        description: "costs $' nothing",
        body: "<p>$& $` body</p>",
      });

      expect(titleOf(html)).toBe("Save $&amp; and $` and $'");
      expect(metaOf(html, "name", "description")).toBe("costs $' nothing");
      expect(appRootOf(html)).toBe("<p>$& $` body</p>");
    });
  });
});
