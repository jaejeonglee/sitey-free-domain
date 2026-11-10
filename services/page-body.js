// services/page-body.js — builds what goes inside <main id="app-root">.
//
// Every page body lives in a <template> in public/index.html and only reaches
// the document once public/modules/router.js runs. Anything that does not
// execute JavaScript — search crawlers, link previews, AI agents — therefore
// received an empty <main>. This module renders the same first paint the client
// router would produce, so the delivered HTML already has the text in it.
//
// 🔴 «The same first paint» includes the language and the header (2026-11-10).
// The page used to arrive in English with an empty header, and the client then
// filled the header (everything under it dropped 42px) and swapped English for
// Korean — on every page, on every load. Now the server paints both, and on the
// first route router.js keeps what it was sent instead of drawing it again
// (later routes clear #app-root and append the template, as before).
const fs = require("fs");
const path = require("path");

// Both languages. English is what public/modules/i18n.js falls back to and what
// the literal text inside the templates already says.
const STRINGS = Object.fromEntries(
  ["en", "ko"].map((lang) => [
    lang,
    JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "public", "locales", `${lang}.json`), "utf8")
    ),
  ])
);

function t(key, lang = "en") {
  return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/**
 * Replacement text is passed through a function so that "$&", "$`" and friends
 * in a post title or body are inserted literally instead of being read as
 * replacement patterns.
 */
function replaceOnce(html, pattern, description, build) {
  if (!pattern.test(html)) {
    throw new Error(`page-body: ${description} not found — public/index.html changed shape`);
  }
  return html.replace(pattern, (...args) => build(...args));
}

/** The inner HTML of <template id="...">, throwing if the template is gone. */
function extractTemplate(indexHtml, templateId) {
  const match = indexHtml.match(
    new RegExp(`<template id="${templateId}">([\\s\\S]*?)</template>`, "i")
  );
  if (!match) {
    throw new Error(`page-body: no <template id="${templateId}"> in public/index.html`);
  }
  return match[1];
}

/** Fill an empty placeholder element (identified by tag + id) with markup. */
function fillPlaceholder(html, tagName, id, inner) {
  const pattern = new RegExp(
    `(<${tagName}[^>]*\\sid="${id}"[^>]*>)[\\s\\S]*?(</${tagName}>)`,
    "i"
  );
  return replaceOnce(
    html,
    pattern,
    `<${tagName} id="${id}"> placeholder`,
    (match, open, close) => `${open}${inner}${close}`
  );
}

// Mirrors the "quick-start" entry of public/modules/docs.js. Only that one
// section: it is the section the client shows first (docs.js defaults to
// "quick-start"), so the delivered HTML matches what a browser renders. The
// other two sections are hash anchors on the same URL, never separate pages.
function docsQuickStart(lang) {
  return `
      <h1>${t("docs.quickstart.title", lang)}</h1>
      <p class="docs-subtitle">${t("docs.quickstart.subtitle", lang)}</p>

      <h2>${t("docs.quickstart.step1.title", lang)}</h2>
      <p>${t("docs.quickstart.step1.desc", lang)}</p>

      <h2>${t("docs.quickstart.step2.title", lang)}</h2>
      <p>${t("docs.quickstart.step2.desc", lang)}</p>

      <h2>${t("docs.quickstart.step3.title", lang)}</h2>
      <p>${t("docs.quickstart.step3.desc", lang)}</p>

      <div class="callout">
        <strong>Tip:</strong> ${t("docs.quickstart.tip", lang)}
      </div>
    `;
}

function docsBody(docsTemplate, lang = "en") {
  return fillPlaceholder(docsTemplate, "div", "docs-content", docsQuickStart(lang));
}

// Mirrors renderList() in public/modules/blog.js.
function blogListBody(blogTemplate, posts, lang = "en") {
  const inner =
    posts.length === 0
      ? `<p>${t("blog.empty", lang)}</p>`
      : `
      <header class="blog-list-header">
        <h1>${t("blog.list.title", lang)}</h1>
        <p>${t("blog.list.subtitle", lang)}</p>
      </header>
      <ul class="blog-list">
${posts
  .map(
    (post) => `        <li class="blog-list-item">
          <a href="/blog/${encodeURIComponent(post.slug)}" class="blog-list-link">
            <h2>${escapeHtml(post.title)}</h2>
            ${post.description ? `<p class="blog-list-desc">${escapeHtml(post.description)}</p>` : ""}
            ${post.date ? `<time class="blog-list-date">${formatDate(post.date)}</time>` : ""}
          </a>
        </li>`
  )
  .join("\n")}
      </ul>
    `;

  return fillPlaceholder(blogTemplate, "article", "blog-content", inner);
}

// Mirrors renderPost() in public/modules/blog.js. post.html is already HTML
// produced by marked from our own markdown, so it goes in unescaped.
function blogPostBody(blogTemplate, post, lang = "en") {
  const inner = `
      <header class="blog-header">
        <a href="/blog" class="blog-back">← ${t("blog.back", lang)}</a>
        <h1>${escapeHtml(post.title)}</h1>
        ${post.date ? `<time class="blog-meta">${formatDate(post.date)}</time>` : ""}
      </header>
      <div class="blog-body">${post.html}</div>
    `;

  return fillPlaceholder(blogTemplate, "article", "blog-content", inner);
}

/**
 * The home body: the template as it is, with the agent's sentence in the page's
 * language. Plain text — modules/home.js underlines the name once it runs, and
 * a crawler should read one sentence, not a sentence and a span.
 */
function homeBody(homeTemplate, lang = "en") {
  const [before, after = ""] = t("home.agent.prompt", lang).split("{name}");
  const sentence = `${before}myapp.sitey.my${after.replace("{where}", t("home.agent.where.default", lang))}`;
  return fillPlaceholder(homeTemplate, "code", "agent-prompt", escapeHtml(sentence));
}

// The two pairs in the header carry no words, only these marks.
const SUN = `<svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <path d="M10 1.6v2.2M10 16.2v2.2M18.4 10h-2.2M3.8 10H1.6M15.9 4.1l-1.6 1.6M5.7 14.3l-1.6 1.6M15.9 15.9l-1.6-1.6M5.7 5.7 4.1 4.1"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;

const MOON = `<svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M16 11.8A6.5 6.5 0 0 1 8.2 4a6.5 6.5 0 1 0 7.8 7.8Z"
            fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;

/**
 * Mirrors renderNavbar() in public/modules/ui.js — change the two together.
 *
 * `signedIn` is the server's reading of the session cookie (routes/pages.js).
 * Which theme button is pressed is left to the client: the server cannot see
 * the system setting, and the two marks are the same width either way.
 */
function navbarBody(currentPath, lang = "en", signedIn = false) {
  const link = (href, key, active) =>
    `<a href="${href}" class="${active ? "active" : ""}" data-label="${escapeHtml(t(key, lang))}">${escapeHtml(t(key, lang))}</a>`;
  const account = signedIn
    ? `${link("/dashboard", "nav.dashboard", currentPath === "/dashboard")}
       <button type="button" id="nav-logout-btn" class="nav-auth-btn">${escapeHtml(t("nav.logout", lang))}</button>`
    : link("/login", "nav.login", currentPath === "/login");
  const aria = (key) => `data-i18n-aria="${key}" aria-label="${escapeHtml(t(key, lang))}"`;

  return `
    <a href="/" class="brand" ${aria("nav.home")}>sitey</a>
    <nav aria-label="Primary">
      ${link("/docs", "nav.docs", currentPath === "/docs" || currentPath === "/guide")}
      ${account}
      <span class="lang" role="group" ${aria("lang.group")}>
        <button type="button" data-lang="ko" aria-pressed="${lang === "ko"}">KR</button>
        <span aria-hidden="true">·</span>
        <button type="button" data-lang="en" aria-pressed="${lang === "en"}">EN</button>
      </span>
      <span class="theme" role="group" ${aria("theme.group")}>
        <button type="button" data-set-theme="light" ${aria("theme.light")}>${SUN}</button>
        <span aria-hidden="true">·</span>
        <button type="button" data-set-theme="dark" ${aria("theme.dark")}>${MOON}</button>
      </span>
    </nav>
  `;
}

/**
 * Put the page in `lang` the way modules/i18n.js applyTranslations() would:
 * the text of every [data-i18n] element, [data-i18n-aria] labels,
 * [data-i18n-placeholder] hints, and <html lang>. Only elements whose content
 * is plain text are touched — that is all applyTranslations sets, too
 * (textContent). English is what the markup already says, so it is left alone.
 */
function localize(html, lang) {
  if (lang === "en" || !STRINGS[lang]) return html;
  const has = (key) => Object.prototype.hasOwnProperty.call(STRINGS[lang], key);
  return html
    .replace(/<html lang="[^"]*"/i, () => `<html lang="${lang}"`)
    .replace(
      /(<([a-z][a-z0-9]*)\b[^>]*?\sdata-i18n="([^"]+)"[^>]*>)[^<]*(<\/\2\s*>)/gi,
      (match, open, tag, key, close) => (has(key) ? `${open}${escapeHtml(t(key, lang))}${close}` : match)
    )
    .replace(/<[a-z][a-z0-9]*\b[^>]*\sdata-i18n-(aria|placeholder)="([^"]+)"[^>]*>/gi, (tag, kind, key) => {
      if (!has(key)) return tag;
      const attr = kind === "aria" ? "aria-label" : "placeholder";
      return tag.replace(new RegExp(`\\s${attr}="[^"]*"`), () => ` ${attr}="${escapeHtml(t(key, lang))}"`);
    });
}

/** Put a rendered body inside the empty <main id="app-root"> of the shell. */
function injectAppRoot(html, body) {
  return replaceOnce(
    html,
    /(<main id="app-root">)\s*(<\/main>)/i,
    '<main id="app-root">',
    (match, open, close) => `${open}${body}${close}`
  );
}

module.exports = {
  extractTemplate,
  homeBody,
  docsBody,
  blogListBody,
  blogPostBody,
  navbarBody,
  localize,
  injectAppRoot,
  fillPlaceholder,
};
