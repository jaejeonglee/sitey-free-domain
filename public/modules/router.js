import { initializeLandingPage } from './home.js';
import { initializeLoginPage } from './auth.js';
import { initializeDashboardPage } from './dashboard.js';
import { initializeDocsPage } from './docs.js';
import { initializeBlogPage } from './blog.js';
import { renderNavbar, renderFooter } from './ui.js';
import { applyTranslations, loadLang, getLang } from './i18n.js';
import { getCurrentUser } from './api.js';

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

  const appRoot = document.getElementById("app-root");
  if (!appRoot) return;

  const template = document.getElementById(route.templateId);
  if (!template) {
    appRoot.innerHTML = "<h1>Error: Page not found</h1>";
    return;
  }

  appRoot.innerHTML = "";
  appRoot.appendChild(template.content.cloneNode(true));
  document.title = route.title;

  renderNavbar(path);
  renderFooter();
  applyTranslations();
  route.init();

  const langSelect = document.getElementById("lang-select");
  if (langSelect) {
    langSelect.value = getLang();
    langSelect.addEventListener("change", async () => {
      await loadLang(langSelect.value);
      router();
    });
  }
}
