import { getCurrentUser, logoutAndRedirect } from "./api.js";
import { toggleTheme, applyTheme } from "./theme.js";
import { t } from "./i18n.js";

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

  const authLink = user
    ? `<button type="button" id="nav-logout-btn" class="nav-auth-btn">${t("nav.logout")}</button>`
    : `<a href="/login" class="nav-auth-btn ${currentPath === "/login" ? "active" : ""}">${t("nav.login")}</a>`;

  container.innerHTML = `
    <nav class="site-nav" aria-label="Primary">
      <div class="nav-left">
        <a href="/" class="nav-logo" aria-label="Sitey Home">
          <img src="/logo-64.png" alt="sitey.one logo" width="28" height="28" decoding="async" />
          <span class="nav-brand">SITEY</span>
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
        <button type="button" id="theme-toggle-btn" class="nav-auth-btn" aria-label="Toggle theme">
          <span id="theme-icon-sun" class="theme-icon" style="display: none;">&#x1F31D;</span>
          <span id="theme-icon-moon" class="theme-icon" style="display: none;">&#x1F31A;</span>
        </button>
        ${authLink}
      </div>
    </nav>
  `;

  // Logout
  const logoutBtn = container.querySelector("#nav-logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (event) => {
      event.preventDefault();
      logoutAndRedirect("/");
    });
  }

  // Theme toggle — re-apply current theme to refresh icon state
  const themeToggleBtn = container.querySelector("#theme-toggle-btn");
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", toggleTheme);
    const currentTheme = document.body.classList.contains("dark-theme")
      ? "dark"
      : "light";
    applyTheme(currentTheme);
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
