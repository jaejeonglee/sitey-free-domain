// routes/pages.js — serves index.html with per-path canonical / Open Graph tags.
//
// The SPA ships one index.html for every route, and it hard-coded a single
// canonical URL, so /docs and /blog/:slug all declared the home page as their
// canonical — search engines treated them as duplicates of "/". Social
// scrapers never run the SPA router, so client-side tag updates would not help
// them either; the tags have to be right in the delivered HTML.
//
// The same argument applies to the body: it lived in <template> elements that
// only the client router copied into <main id="app-root">, so a reader without
// JavaScript got correct tags wrapped around a blank page. Public pages now
// ship their body too — see services/page-body.js.
const fs = require("fs").promises;
const path = require("path");
const fp = require("fastify-plugin");
const { loadPost } = require("../services/blog");
const { extractTemplate, docsBody, injectAppRoot } = require("../services/page-body");

// One canonical origin for the whole site. robots.txt and sitemap.xml carry the
// same value — change all three together.
const CANONICAL_ORIGIN = "https://sitey.my";

const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");

const SITE_TITLE_SUFFIX = "Sitey";
const DEFAULT_DESCRIPTION =
  "Get a free subdomain in seconds. Create A, CNAME and TXT records and manage them from a simple dashboard.";

// Mirrors the client router in public/modules/router.js. Anything not listed
// here is a real 404 — the old handler answered every unknown URL with the home
// page and a 200 (a soft 404).
//
// "template" names the <template> whose contents are rendered into the body.
// Pages behind sign-in deliberately have none: their markup is an empty shell
// waiting on an API call, so shipping it would only put a contentless page in
// front of crawlers.
const PAGES = {
  "/": {
    title: "Sitey — free subdomains for developers",
    description: DEFAULT_DESCRIPTION,
    template: "template-home",
  },
  "/docs": {
    title: `Docs — ${SITE_TITLE_SUFFIX}`,
    description: "How to create a subdomain, point it at your server, and use the REST API.",
    template: "template-docs",
  },
  "/guide": {
    title: `Docs — ${SITE_TITLE_SUFFIX}`,
    description: "How to create a subdomain, point it at your server, and use the REST API.",
    canonicalPath: "/docs", // same page under two paths
    template: "template-docs",
  },
  "/blog": {
    title: `Blog — ${SITE_TITLE_SUFFIX}`,
    description: "Notes on running a free subdomain service: DNS, deploys and developer tooling.",
  },
  "/help": {
    title: `Help — ${SITE_TITLE_SUFFIX}`,
    description: "Answers to common questions about sitey subdomains.",
    template: "template-help",
  },
  // No template below this line: sign-in and the dashboard are behind auth.
  "/login": {
    title: `Sign in — ${SITE_TITLE_SUFFIX}`,
    description: "Sign in with Google to manage your sitey subdomains.",
  },
  "/signup": {
    title: `Sign in — ${SITE_TITLE_SUFFIX}`,
    description: "Sign in with Google to manage your sitey subdomains.",
    canonicalPath: "/login", // signup renders the same login template
  },
  "/dashboard": {
    title: `Dashboard — ${SITE_TITLE_SUFFIX}`,
    description: "Manage your sitey subdomains.",
    noindex: true, // behind auth, and already disallowed in robots.txt
  },
};

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Replacement text is always produced by a function: blog titles, descriptions
 * and post bodies come from markdown we do not control the punctuation of, and
 * a literal "$&" or "$\'" in a string replacement would splice the surrounding
 * document into the tag.
 */
function replaceWith(html, pattern, value) {
  return html.replace(pattern, () => value);
}

/** Replace a <meta> tag's content, matching across line breaks. */
function setMeta(html, attr, name, value) {
  const pattern = new RegExp(`<meta\\s+${attr}="${name}"[\\s\\S]*?/>`, "i");
  return replaceWith(html, pattern, `<meta ${attr}="${name}" content="${escapeAttr(value)}" />`);
}

function renderPage(template, { canonicalPath, title, description, noindex, body }) {
  const canonicalUrl = `${CANONICAL_ORIGIN}${canonicalPath}`;

  let html = replaceWith(
    template,
    /<link rel="canonical" href="[^"]*"\s*\/>/i,
    `<link rel="canonical" href="${escapeAttr(canonicalUrl)}" />`
  );
  html = replaceWith(html, /<title>[\s\S]*?<\/title>/i, `<title>${escapeAttr(title)}</title>`);

  html = setMeta(html, "name", "description", description);
  html = setMeta(html, "property", "og:url", canonicalUrl);
  html = setMeta(html, "property", "og:title", title);
  html = setMeta(html, "property", "og:description", description);
  html = setMeta(html, "name", "twitter:title", title);
  html = setMeta(html, "name", "twitter:description", description);

  if (noindex) {
    html = html.replace(
      /<link rel="canonical"[^>]*\/>/i,
      (match) => `${match}\n    <meta name="robots" content="noindex, follow" />`
    );
  }

  return injectAppRoot(html, body || "");
}

async function pageRoutes(fastify, options) {
  const template = await fs.readFile(INDEX_PATH, "utf8");

  // Read the <template> bodies once at startup. extractTemplate throws if one
  // is missing, so a renamed template fails the boot instead of quietly
  // serving blank pages again.
  const staticBodies = {
    "template-home": extractTemplate(template, "template-home"),
    "template-docs": docsBody(extractTemplate(template, "template-docs")),
    "template-help": extractTemplate(template, "template-help"),
  };
  function send(reply, page, statusCode = 200) {
    const body = page.body ?? (page.template ? staticBodies[page.template] : "");
    return reply
      .code(statusCode)
      .type("text/html; charset=utf-8")
      .send(renderPage(template, { ...page, body }));
  }

  /** the 404 body: still the app shell, but with an honest status code */
  function sendNotFound(reply) {
    return send(
      reply,
      {
        canonicalPath: "/",
        title: `Page not found — ${SITE_TITLE_SUFFIX}`,
        description: DEFAULT_DESCRIPTION,
        noindex: true,
      },
      404
    );
  }

  fastify.decorate("sendPageNotFound", sendNotFound);

  for (const [routePath, page] of Object.entries(PAGES)) {
    fastify.get(routePath, async (request, reply) =>
      send(reply, { ...page, canonicalPath: page.canonicalPath || routePath })
    );
  }

  // /index.html is the same document as "/" — point it at the canonical path.
  fastify.get("/index.html", async (request, reply) =>
    send(reply, { ...PAGES["/"], canonicalPath: "/" })
  );

  fastify.get("/blog/:slug", async (request, reply) => {
    const { slug } = request.params;
    let post;
    try {
      post = await loadPost(slug);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 400) {
        return sendNotFound(reply);
      }
      throw error;
    }

    return send(reply, {
      canonicalPath: `/blog/${post.slug}`,
      title: `${post.title} — ${SITE_TITLE_SUFFIX}`,
      description: post.description || DEFAULT_DESCRIPTION,
    });
  });
}

// Registered with fastify-plugin so the not-found handler on the root instance
// can reuse the same rendered 404 body.
module.exports = fp(pageRoutes, { name: "pages" });
module.exports.CANONICAL_ORIGIN = CANONICAL_ORIGIN;
module.exports.PAGES = PAGES;
module.exports.renderPage = renderPage;
