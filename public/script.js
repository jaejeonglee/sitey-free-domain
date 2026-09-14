import { router, navigateTo, isClientRoute } from './modules/router.js';
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
      // Only paths the client router can actually render are taken over. The
      // rest — the pages the server fills in, and documents like /openapi.json
      // and /llms.txt — go to the network as ordinary navigations.
      if (!isClientRoute(link.pathname)) return;
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
