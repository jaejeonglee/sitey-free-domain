// The privacy policy, opened over whatever page you are on.
//
// It also lives at /privacy as a real server-rendered page, because a crawler
// and a review team need a URL they can read without running any script. The
// modal is for the person who clicks the footer link: nothing navigates, so
// the client router never touches it and it cannot be blanked.
//
// The body is fetched from that same page — one source, not two copies.

import { getLang } from "./i18n.js";

let loadedLang = null;

function els() {
  return {
    modal: document.getElementById("privacy-modal"),
    body: document.getElementById("privacy-modal-body"),
  };
}

function close() {
  const { modal } = els();
  if (modal) modal.classList.add("hidden");
}

async function open() {
  const { modal, body } = els();
  if (!modal || !body) return;

  modal.classList.remove("hidden");

  const lang = getLang();
  if (loadedLang === lang) return; // already showing this language

  body.innerHTML = '<p class="privacy-loading">…</p>';

  try {
    const res = await fetch(`/privacy?lang=${encodeURIComponent(lang)}`, {
      headers: { Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // The page returns the whole shell; take the part that is the policy.
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const rendered = doc.querySelector("#app-root .blog-body");
    if (!rendered) throw new Error("no policy body in the response");

    body.innerHTML = rendered.innerHTML;
    loadedLang = lang;
  } catch (error) {
    // A link to the page always works, so say so rather than leaving a blank.
    body.innerHTML =
      '<p>Could not load the policy here. <a href="/privacy">Open it as a page</a>.</p>';
    loadedLang = null;
    console.error("privacy modal:", error);
  }
}

/**
 * Wired once at boot, not per route: the footer and this modal live outside
 * <main id="app-root">, so re-rendering a page must not re-bind them.
 */
export function initPrivacyModal() {
  const { modal } = els();
  if (!modal) return;

  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href="/privacy"]');
    if (link) {
      event.preventDefault();
      open();
      return;
    }
    if (event.target.closest("#privacy-modal [data-modal-close]")) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  // Language switch while it is open: drop the cache so the next open refetches.
  document.querySelectorAll(".lang button[data-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      loadedLang = null;
      if (!modal.classList.contains("hidden")) open();
    });
  });
}
