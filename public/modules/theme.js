// public/modules/theme.js — light or dark, and which one the header says.
//
// The choice lands on <html data-theme>, which style.css reads. Applying it
// for the first time is the inline snippet in index.html's <head>, because by
// the time this deferred module runs the page has already been painted.

const STORAGE_KEY = "sitey-theme";

// 저장은 실패할 수 있다(사생활 보호 창·저장 차단). 그래도 화면은 돌아야 한다.
const store = {
  get() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {}
  },
};

const root = document.documentElement;

/**
 * What is on screen right now — the explicit choice if there is one, and the
 * system setting if there is not. style.css resolves it the same way, so the
 * header can never disagree with the colours around it.
 */
function currentTheme() {
  const chosen = root.getAttribute("data-theme");
  if (chosen === "dark" || chosen === "light") return chosen;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * The pair of buttons in the header, wired the same way as KR·EN: the one you
 * are on is bold and inert, the other is the way out.
 *
 * 고른 적이 없으면 «시스템을 따라간» 결과를 진하게 표시한다 — 사람 눈에
 * 지금 어두우면 어두운 쪽이 켜져 있어야 말이 맞는다.
 */
export function wireThemeButtons(container) {
  if (!container) return;
  const buttons = container.querySelectorAll(".theme button[data-set-theme]");
  if (!buttons.length) return;

  const label = () => {
    const now = currentTheme();
    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.setTheme === now));
    });
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.setTheme;
      if (currentTheme() === next) return;
      root.setAttribute("data-theme", next);
      store.set(next);
      label();
    });
  });

  label();
}
