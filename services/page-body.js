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
  injectAppRoot,
};
