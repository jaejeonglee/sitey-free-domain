// services/page-body.js — builds what goes inside <main id="app-root">.
//
// Every page body lives in a <template> in public/index.html and only reaches
// the document once public/modules/router.js runs. Anything that does not
// execute JavaScript — search crawlers, link previews, AI agents — therefore
// received an empty <main>. This module renders the same first paint the client
// router would produce, so the delivered HTML already has the text in it.
//
// The client is unchanged: router.js clears #app-root ("appRoot.innerHTML = ''")
// before it appends the template, so what we put there is replaced, not doubled.
const fs = require("fs");
const path = require("path");

// English, because that is what public/modules/i18n.js falls back to and what
// the literal text inside the templates already says.
const STRINGS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "public", "locales", "en.json"), "utf8")
);

function t(key) {
  return STRINGS[key] ?? key;
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
function docsQuickStart() {
  return `
      <h1>${t("docs.quickstart.title")}</h1>
      <p class="docs-subtitle">${t("docs.quickstart.subtitle")}</p>

      <h2>${t("docs.quickstart.step1.title")}</h2>
      <p>${t("docs.quickstart.step1.desc")}</p>

      <h2>${t("docs.quickstart.step2.title")}</h2>
      <p>${t("docs.quickstart.step2.desc")}</p>

      <h2>${t("docs.quickstart.step3.title")}</h2>
      <p>${t("docs.quickstart.step3.desc")}</p>

      <div class="callout">
        <strong>Tip:</strong> ${t("docs.quickstart.tip")}
      </div>
    `;
}

function docsBody(docsTemplate) {
  return fillPlaceholder(docsTemplate, "div", "docs-content", docsQuickStart());
}

// Mirrors renderList() in public/modules/blog.js.
function blogListBody(blogTemplate, posts) {
  const inner =
    posts.length === 0
      ? `<p>${t("blog.empty")}</p>`
      : `
      <header class="blog-list-header">
        <h1>${t("blog.list.title")}</h1>
        <p>${t("blog.list.subtitle")}</p>
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
function blogPostBody(blogTemplate, post) {
  const inner = `
      <header class="blog-header">
        <a href="/blog" class="blog-back">← ${t("blog.back")}</a>
        <h1>${escapeHtml(post.title)}</h1>
        ${post.date ? `<time class="blog-meta">${formatDate(post.date)}</time>` : ""}
      </header>
      <div class="blog-body">${post.html}</div>
    `;

  return fillPlaceholder(blogTemplate, "article", "blog-content", inner);
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
  docsBody,
  blogListBody,
  blogPostBody,
  injectAppRoot,
};
