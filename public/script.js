import { router, navigateTo, isClientRoute } from './modules/router.js';
import { getSavedLang, loadLang } from './modules/i18n.js';
import { fetchCurrentUser, getCurrentUser } from './modules/api.js';
import { initPrivacyModal } from './modules/privacy-modal.js';
import { takePendingClaim, holdClaim } from './modules/pending-claim.js';

document.addEventListener("DOMContentLoaded", async () => {
  // Load saved language + check auth status
  await Promise.all([loadLang(getSavedLang()), fetchCurrentUser()]);

  // Somebody who pressed "Get it" without an account left the name they were
  // taking behind on the way to Google. The OAuth callback always lands on
  // /dashboard — that redirect is the only sign we get that a sign-in has just
  // finished — so this is where the walk back starts. A sign-in that began
  // anywhere else stored nothing and goes to the dashboard as it always did.
  if (getCurrentUser() && window.location.pathname === "/dashboard") {
    const claim = takePendingClaim();
    if (claim) {
      holdClaim(claim);
      // replaceState, not pushState: Back belongs to wherever they were before
      // signing in, not to a dashboard that was never on the screen.
      history.replaceState(null, "", `/?check=${encodeURIComponent(claim.subdomain)}`);
    }
  }
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
