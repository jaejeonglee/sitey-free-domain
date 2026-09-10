import { getCurrentUser, logoutAndRedirect } from "./api.js";
import { t } from "./i18n.js";
import { setWindowTitle } from "./taskbar.js";

/* ============================================
   Toast Notifications
   ============================================ */
const TOAST_DURATION = 4000;

export function showMessage(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(20px)";
    toast.style.transition = "opacity 0.3s, transform 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION);
}

export function resetMessage() {
  // No-op: toasts auto-dismiss, no persistent message to reset
}

/* ============================================
   Button Loading States
   ============================================ */
export function setButtonLoading(button, label) {
  if (!button) return;
  if (!button.dataset.originalText) {
    button.dataset.originalText = button.textContent.trim();
  }
  button.disabled = true;
  button.textContent = label;
}

export function clearButtonLoading(button) {
  if (!button) return;
  const original = button.dataset.originalText;
  if (original) {
    button.textContent = original;
    delete button.dataset.originalText;
  }
  button.disabled = false;
}

/* ============================================
   Visibility & DOM Helpers
   ============================================ */
export function setHidden(element, shouldHide) {
  if (!element) return;
  element.classList.toggle("hidden", Boolean(shouldHide));
}

export function clearChildren(element) {
  if (!element) return;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

/* ============================================
   Loader
   ============================================ */
let loaderElement = null;
let loaderCount = 0;

function ensureLoader() {
  if (!loaderElement) {
    loaderElement = document.createElement("div");
    loaderElement.className = "loader-overlay";
    loaderElement.setAttribute("role", "status");
    loaderElement.setAttribute("aria-live", "polite");

    const spinner = document.createElement("div");
    spinner.className = "loader-spinner";
    spinner.setAttribute("aria-hidden", "true");

    const srText = document.createElement("span");
    srText.className = "sr-only";
    srText.textContent = "Loading";

    loaderElement.append(spinner, srText);
    document.body.appendChild(loaderElement);
  }
  return loaderElement;
}

export function showLoader() {
  const element = ensureLoader();
  loaderCount += 1;
  element.classList.add("show");
}

export function hideLoader() {
  if (loaderCount > 0) loaderCount -= 1;
  if (loaderCount === 0 && loaderElement) {
    loaderElement.classList.remove("show");
  }
}

/* ============================================
   Format Helpers
   ============================================ */
export function formatDomainList(domains = []) {
  return domains.join(", ");
}

/* ============================================
   Footer
   ============================================ */
export function renderFooter() {
  const container = document.getElementById("footer");
  if (!container) return;
  container.innerHTML = `
    <footer class="site-footer">
      <span class="footer-brand">SITEY</span>
      <span class="footer-divider" aria-hidden="true">|</span>
      <a href="/api/policies/privacy" target="_blank" rel="noopener noreferrer">
        Privacy Policy
      </a>
    </footer>
  `;
}

/* ============================================
   Navbar
   ============================================ */
export function renderNavbar(currentPath) {
  const container = document.getElementById("navbar");
  if (!container) return;

  const user = getCurrentUser();

  const navLinks = [
    { path: "/", label: t("nav.home") },
    { path: "/docs", label: t("nav.docs") },
    { path: "/blog", label: t("nav.blog") },
    { path: "/help", label: t("nav.help") },
  ];

  if (user) {
    navLinks.push({ path: "/dashboard", label: t("nav.dashboard") });
  }

  // The title bar says which window you are in, and the task button below
  // repeats it. /login and /dashboard are not menu titles but are still
  // pages, so they get their labels from the same strings.
  const titles = {
    ...Object.fromEntries(navLinks.map(({ path, label }) => [path, label])),
    "/guide": t("nav.docs"),
    "/login": t("nav.login"),
    "/signup": t("nav.login"),
    "/dashboard": t("nav.dashboard"),
  };
  const pageLabel =
    titles[currentPath] || (currentPath.startsWith("/blog") ? t("nav.blog") : "");
  const windowTitle = pageLabel ? `sitey.my — ${pageLabel}` : "sitey.my";
  setWindowTitle(windowTitle);

  const authLink = user
    ? `<button type="button" id="nav-logout-btn" class="nav-auth-btn">${t("nav.logout")}</button>`
    : `<a href="/login" class="nav-auth-btn ${currentPath === "/login" ? "active" : ""}">${t("nav.login")}</a>`;

  container.innerHTML = `
    <nav class="site-nav" aria-label="Primary">
      <div class="nav-left">
        <a href="/" class="nav-logo" aria-label="Sitey Home">
          <img src="/logo-64.png" alt="sitey.my logo" width="28" height="28" decoding="async" />
          <span class="nav-brand">${windowTitle}</span>
        </a>
      </div>
      <button type="button" class="nav-toggle" id="nav-toggle" aria-label="Toggle menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
      <div class="nav-center" id="nav-menu">
        ${navLinks.map(({ path, label }) => `
          <a href="${path}" class="${currentPath === path ? "active" : ""}">${label}</a>
        `).join("")}
      </div>
      <div class="nav-right">
        <select id="lang-select" class="nav-select">
          <option value="en">EN</option>
          <option value="ko">KR</option>
        </select>
        ${authLink}
      </div>
    </nav>

    <!-- Internet Explorer's furniture. Jay: «윈도우 os 위에 인터넷 창이
         띄워진 느낌이 아니라 어색해» — a title bar and a menu make a window,
         but what makes it an *internet* window is the address bar. And for a
         service whose product is addresses, showing one is not decoration. -->
    <div class="ie-tools" role="toolbar" aria-label="${t("ie.toolbar")}">
      <button type="button" class="ie-btn" data-go="back">
        <span aria-hidden="true">&#x25C0;</span> ${t("ie.back")}
      </button>
      <button type="button" class="ie-btn" data-go="forward">
        <span aria-hidden="true">&#x25B6;</span> ${t("ie.forward")}
      </button>
      <span class="ie-divider" aria-hidden="true"></span>
      <button type="button" class="ie-btn" data-go="reload">
        <span aria-hidden="true">&#x21BB;</span> ${t("ie.reload")}
      </button>
      <button type="button" class="ie-btn" data-go="home">
        <span aria-hidden="true">&#x2302;</span> ${t("ie.home")}
      </button>
    </div>

    <div class="ie-address">
      <label for="ie-url">${t("ie.address")}</label>
      <input id="ie-url" type="text" readonly value="https://sitey.my${currentPath === "/" ? "/" : currentPath}" />
    </div>
  `;

  // Back and forward are the browser's own history — the buttons say what
  // they do and then do exactly that, rather than imitating it.
  container.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const where = btn.dataset.go;
      if (where === "back") history.back();
      else if (where === "forward") history.forward();
      else if (where === "reload") window.location.reload();
      // A full load rather than the client router: router.js imports this
      // file, so importing it back would be a cycle — and a Home button that
      // actually reloads is the more faithful one anyway.
      else if (where === "home") window.location.assign("/");
    });
  });

  // Selecting the whole address on focus is what a browser does, and it is
  // the one gesture people try on an address bar.
  const urlField = container.querySelector("#ie-url");
  if (urlField) urlField.addEventListener("focus", () => urlField.select());

  // Logout
  const logoutBtn = container.querySelector("#nav-logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (event) => {
      event.preventDefault();
      logoutAndRedirect("/");
    });
  }

  // Mobile menu toggle
  const navToggle = container.querySelector("#nav-toggle");
  const navMenu = container.querySelector("#nav-menu");
  if (navToggle && navMenu) {
    navToggle.addEventListener("click", () => {
      const isOpen = navMenu.classList.toggle("open");
      navToggle.classList.toggle("open", isOpen);
      navToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    // Close menu on link click
    navMenu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        navMenu.classList.remove("open");
        navToggle.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }
}
