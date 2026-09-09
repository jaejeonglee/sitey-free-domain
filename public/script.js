import { router, navigateTo } from './modules/router.js';
import { loadInitialTheme } from './modules/theme.js';
import { getSavedLang, loadLang } from './modules/i18n.js';
import { fetchCurrentUser } from './modules/api.js';
import { startClock, startMenu } from './modules/taskbar.js';

document.addEventListener("DOMContentLoaded", async () => {
  // Load saved language + check auth status
  await Promise.all([loadLang(getSavedLang()), fetchCurrentUser()]);
  // Handle client-side routing for all internal links
  document.body.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link && link.target !== "_blank" && link.origin === window.location.origin) {
      // Skip hash-only links (e.g. docs sidebar)
      if (link.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault();
      navigateTo(link.pathname + link.search);
    }
  });

  // Listen for browser back/forward button clicks
  window.addEventListener("popstate", router);

  // Initial route
  router();

  // Load initial theme
  loadInitialTheme();

  startClock();
  startMenu();
});
