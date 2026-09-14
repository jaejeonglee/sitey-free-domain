const STORAGE_KEY = "sitey-lang";
const DEFAULT_LANG = "en";
const SUPPORTED = ["en", "ko"];

let translations = {};
let currentLang = DEFAULT_LANG;

export function getLang() {
  return currentLang;
}

export async function loadLang(lang) {
  if (!SUPPORTED.includes(lang)) lang = DEFAULT_LANG;

  try {
    const res = await fetch(`/locales/${lang}.json`);
    if (!res.ok) throw new Error(`Failed to load ${lang}`);
    translations = await res.json();
    currentLang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    // Also a cookie: pages whose text is rendered on the server (/about,
    // /privacy) cannot read localStorage, and without this they always came
    // back in the default language while the chrome said otherwise.
    document.cookie = `${STORAGE_KEY}=${lang}; path=/; max-age=31536000; SameSite=Lax`;
    document.documentElement.lang = lang;
  } catch {
    if (lang !== DEFAULT_LANG) {
      return loadLang(DEFAULT_LANG);
    }
    translations = {};
  }
}

export function t(key, params) {
  let text = translations[key] || key;
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.replace(`{${k}}`, v);
    });
  }
  return text;
}

export function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    const text = t(key);
    if (text === key) return;
    if (el.dataset.i18nHtml !== undefined) {
      el.innerHTML = text;
    } else {
      el.textContent = text;
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    const text = t(key);
    if (text !== key) el.placeholder = text;
  });

  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.dataset.i18nAria;
    const text = t(key);
    if (text !== key) el.setAttribute("aria-label", text);
  });
}

export function getSavedLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED.includes(saved)) return saved;

  const browserLang = navigator.language?.split("-")[0];
  if (browserLang && SUPPORTED.includes(browserLang)) return browserLang;

  return DEFAULT_LANG;
}
