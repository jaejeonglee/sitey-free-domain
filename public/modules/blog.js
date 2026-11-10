import { apiFetch } from "./api.js";
import { navigateTo } from "./router.js";
import { getLang } from "./i18n.js";
import { t } from "./i18n.js";

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

async function renderList() {
  const container = document.getElementById("blog-content");
  if (!container) return;

  container.innerHTML = `<p>${t("common.loading")}</p>`;

  try {
    const data = await apiFetch(`/api/blog?lang=${getLang()}`);
    const posts = data.posts || [];

    if (posts.length === 0) {
      container.innerHTML = `<p>${t("blog.empty")}</p>`;
      return;
    }

    container.innerHTML = `
      <header class="blog-list-header">
        <h1>${t("blog.list.title")}</h1>
        <p>${t("blog.list.subtitle")}</p>
      </header>
      <ul class="blog-list">
        ${posts.map((post) => `
          <li class="blog-list-item">
            <a href="/blog/${encodeURIComponent(post.slug)}" class="blog-list-link">
              <h2>${escapeHtml(post.title)}</h2>
              ${post.description ? `<p class="blog-list-desc">${escapeHtml(post.description)}</p>` : ""}
              ${post.date ? `<time class="blog-list-date">${formatDate(post.date)}</time>` : ""}
            </a>
          </li>
        `).join("")}
      </ul>
    `;
  } catch (error) {
    container.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

async function renderPost(slug) {
  const container = document.getElementById("blog-content");
  if (!container) return;

  container.innerHTML = `<p>${t("common.loading")}</p>`;

  try {
    const post = await apiFetch(`/api/blog/${encodeURIComponent(slug)}?lang=${getLang()}`);

    document.title = `${post.title} - Sitey`;

    container.innerHTML = `
      <header class="blog-header">
        <a href="/blog" class="blog-back">← ${t("blog.back")}</a>
        <h1>${escapeHtml(post.title)}</h1>
        ${post.date ? `<time class="blog-meta">${formatDate(post.date)}</time>` : ""}
      </header>
      <div class="blog-body">${post.html}</div>
    `;
  } catch (error) {
    container.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function initializeBlogPage({ hydrated = false } = {}) {
  const container = document.getElementById("blog-content");
  if (!container) return;

  // Extract slug from /blog/:slug
  const path = window.location.pathname;
  const match = path.match(/^\/blog\/(.+)$/);

  // Unless the server already put this list or post on screen (router.js) —
  // fetching it again only flashed «Loading…» over it.
  if (!hydrated) {
    if (match) {
      renderPost(decodeURIComponent(match[1]));
    } else {
      renderList();
    }
  }

  // Delegate clicks for domain chips
  container.addEventListener("click", (e) => {
    const chip = e.target.closest(".domain-chip");
    if (chip) {
      const name = chip.dataset.name;
      navigateTo(`/?check=${encodeURIComponent(name)}`);
    }
  });
}
