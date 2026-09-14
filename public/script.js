import { router, navigateTo } from './modules/router.js';
import { getSavedLang, loadLang } from './modules/i18n.js';
import { fetchCurrentUser } from './modules/api.js';
import { initPrivacyModal } from './modules/privacy-modal.js';

document.addEventListener("DOMContentLoaded", async () => {
  // Load saved language + check auth status
  await Promise.all([loadLang(getSavedLang()), fetchCurrentUser()]);
  // Handle client-side routing for all internal links
  document.body.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link && link.target !== "_blank" && link.origin === window.location.origin) {
      // Skip hash-only links (e.g. docs sidebar)
      if (link.getAttribute("href")?.startsWith("#")) return;
      // The policy opens in a modal (modules/privacy-modal.js); /about is a
      // server-rendered page. Leaving either to the client router would render
      // the home template over markup the server already filled.
      const href = link.getAttribute("href");
      if (href === "/privacy" || href === "/about") return;
      event.preventDefault();
      navigateTo(link.pathname + link.search);
    }
  });

  // Listen for browser back/forward button clicks
  window.addEventListener("popstate", router);

  // Bound once, outside the router: the footer and the modal live outside
  // <main id="app-root">, so a re-render must not re-bind them.
  initPrivacyModal();

  // Initial route
  router();
});
