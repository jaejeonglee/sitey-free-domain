import { initializeLandingPage } from './home.js';
import { initializeLoginPage } from './auth.js';
import { initializeDashboardPage } from './dashboard.js';
import { initializeDocsPage } from './docs.js';
import { initializeBlogPage } from './blog.js';
import { renderNavbar } from './ui.js';
import { applyTranslations, loadLang, getLang } from './i18n.js';
import { getCurrentUser } from './api.js';

// Paths the server fills in; the client must not paint over them.
const SERVER_RENDERED = new Set(["/privacy", "/about"]);

const routes = {
    "/": { templateId: "template-home", init: initializeLandingPage, title: "Sitey - free domain" },
    "/index.html": { templateId: "template-home", init: initializeLandingPage, title: "Sitey - free domain" },
    "/login": { templateId: "template-login", init: initializeLoginPage, title: "Login - Sitey" },
    "/signup": { templateId: "template-login", init: initializeLoginPage, title: "Login - Sitey" },
    "/dashboard": { templateId: "template-dashboard", init: initializeDashboardPage, title: "Dashboard - Sitey", auth: true },
    "/docs": { templateId: "template-docs", init: initializeDocsPage, title: "Docs - Sitey" },
    "/guide": { templateId: "template-docs", init: initializeDocsPage, title: "Docs - Sitey" },
    "/blog": { templateId: "template-blog", init: initializeBlogPage, title: "Domain Name Ideas - Sitey" },
};

export function navigateTo(path) {
  history.pushState(null, null, path);
  router();
}

export async function router() {
  let path = window.location.pathname;
  if (path.endsWith('/index.html')) {
    path = '/';
  }

  // Match /blog/:slug to the blog route
  let route = routes[path];
  if (!route && /^\/blog\/[^/]+$/.test(path)) {
    route = routes["/blog"];
  }
  if (!route) {
    route = routes["/"];
  }

  // Redirect to login if auth required and not logged in
  if (route.auth && !getCurrentUser()) {
    return navigateTo("/login");
  }

  // These arrive fully rendered from the server (routes/pages.js) and have no
  // client template. Wiping app-root to drop a template in would blank the
  // page a moment after it appears — so for these the swap is skipped and only
  // the chrome around it is wired.
  const serverRendered = SERVER_RENDERED.has(path);

  const appRoot = document.getElementById("app-root");
  if (!appRoot) return;

  if (!serverRendered) {
    const template = document.getElementById(route.templateId);
    if (!template) {
      appRoot.innerHTML = "<h1>Error: Page not found</h1>";
      return;
    }

    appRoot.innerHTML = "";
    appRoot.appendChild(template.content.cloneNode(true));
    document.title = route.title;
  }

  renderNavbar(path);
  applyTranslations();
  if (!serverRendered) route.init();

  // KR·EN. The header is rebuilt on every route, so the buttons are wired
  // here rather than once at boot — and re-running the router is what repaints
  // the page in the new language, including anything route.init() drew.
  document.querySelectorAll(".lang button[data-lang]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.lang === getLang()));
    button.addEventListener("click", async () => {
      if (button.dataset.lang === getLang()) return;
      await loadLang(button.dataset.lang);
      // These pages have their text chosen on the server, so repainting on the
      // client would change everything except the words being read. loadLang
      // has just written the cookie the server reads, so a reload is enough —
      // and it drops any ?lang= left in the address by an earlier choice.
      if (serverRendered) {
        window.location.assign(window.location.pathname);
        return;
      }
      router();
    });
  });
}
