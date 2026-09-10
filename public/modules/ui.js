import { getCurrentUser, logoutAndRedirect } from "./api.js";
import { t } from "./i18n.js";
import { wireThemeButtons } from "./theme.js";

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
   Navbar

   Right-aligned and small: the header is not where the work happens.

   Two links plus two pairs. The pairs — KR·EN and sun·moon — follow one
   rule between them: the one you are on is bold and inert, the one you can
   go to is quiet. A different rule for each would leave neither readable.
   ============================================ */

const SUN = `<svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <path d="M10 1.6v2.2M10 16.2v2.2M18.4 10h-2.2M3.8 10H1.6M15.9 4.1l-1.6 1.6M5.7 14.3l-1.6 1.6M15.9 15.9l-1.6-1.6M5.7 5.7 4.1 4.1"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;

const MOON = `<svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M16 11.8A6.5 6.5 0 0 1 8.2 4a6.5 6.5 0 1 0 7.8 7.8Z"
            fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;

export function renderNavbar(currentPath) {
  const container = document.getElementById("navbar");
  if (!container) return;

  const user = getCurrentUser();

  // Signed in, the login link becomes the two things only a signed-in
  // visitor can do. Signed out, it is the one thing they can.
  const account = user
    ? `<a href="/dashboard" class="${currentPath === "/dashboard" ? "active" : ""}">${t("nav.dashboard")}</a>
       <button type="button" id="nav-logout-btn" class="nav-auth-btn">${t("nav.logout")}</button>`
    : `<a href="/login" class="${currentPath === "/login" ? "active" : ""}">${t("nav.login")}</a>`;

  // 홈에는 가운데에 큰 글자 로고가 서 있다. 위에 또 두면 같은 이름이 한
  // 화면에 두 번 나오므로 홈에서만 뺀다. 다른 화면에는 그 큰 로고가 없어
  // 여기가 집으로 돌아오는 유일한 문이 된다 — 구글이 첫 화면에만 로고를
  // 빼고 결과 화면 왼쪽 위에 두는 것과 같은 이유다.
  const atHome = currentPath === "/" || currentPath === "/index.html";
  const brand = atHome
    ? ""
    : `<a href="/" class="brand" data-i18n-aria="nav.home" aria-label="Home">sitey<em>.my</em></a>`;

  container.innerHTML = `
    ${brand}
    <nav aria-label="Primary">
      <a href="/docs" class="${currentPath === "/docs" || currentPath === "/guide" ? "active" : ""}">${t("nav.docs")}</a>
      ${account}
      <span class="lang" role="group" data-i18n-aria="lang.group" aria-label="Language">
        <button type="button" data-lang="ko">KR</button>
        <span aria-hidden="true">·</span>
        <button type="button" data-lang="en">EN</button>
      </span>
      <span class="theme" role="group" data-i18n-aria="theme.group" aria-label="Theme">
        <button type="button" data-set-theme="light" data-i18n-aria="theme.light" aria-label="Light">${SUN}</button>
        <span aria-hidden="true">·</span>
        <button type="button" data-set-theme="dark" data-i18n-aria="theme.dark" aria-label="Dark">${MOON}</button>
      </span>
    </nav>
  `;

  wireThemeButtons(container);

  const logoutBtn = container.querySelector("#nav-logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (event) => {
      event.preventDefault();
      logoutAndRedirect("/");
    });
  }
}
