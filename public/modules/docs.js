import { t } from "./i18n.js";
import { resetMessage } from "./ui.js";
import { applyTranslations } from "./i18n.js";

const docs = {
  "quick-start": () => `
    <h1>${t("docs.quickstart.title")}</h1>
    <p class="docs-subtitle">${t("docs.quickstart.subtitle")}</p>

    <h2>${t("docs.quickstart.step1.title")}</h2>
    <p>${t("docs.quickstart.step1.desc")}</p>

    <h2>${t("docs.quickstart.step2.title")}</h2>
    <p>${t("docs.quickstart.step2.desc")}</p>

    <h2>${t("docs.quickstart.step3.title")}</h2>
    <p>${t("docs.quickstart.step3.desc")}</p>

    <div class="callout">
      <strong>Tip:</strong> ${t("docs.quickstart.tip")}
    </div>
  `,

  "vercel": () => `
    <h1>${t("docs.vercel.title")}</h1>
    <p class="docs-subtitle">${t("docs.vercel.subtitle")}</p>

    <h2>${t("docs.vercel.step1.title")}</h2>
    <p>${t("docs.vercel.step1.desc")}</p>
    <ol>
      <li>${t("docs.vercel.step1.item1")}</li>
      <li>${t("docs.vercel.step1.item2")}</li>
      <li>${t("docs.vercel.step1.item3")}</li>
    </ol>

    <h2>${t("docs.vercel.step2.title")}</h2>
    <p>${t("docs.vercel.step2.desc")}</p>
    <ol>
      <li>${t("docs.vercel.step2.item1")}</li>
      <li>${t("docs.vercel.step2.item2")}</li>
      <li>${t("docs.vercel.step2.item3")}</li>
    </ol>

    <h2>${t("docs.vercel.step3.title")}</h2>
    <p>${t("docs.vercel.step3.desc")}</p>
    <ol>
      <li>${t("docs.vercel.step3.item1")}</li>
      <li>${t("docs.vercel.step3.item2")}</li>
      <li>${t("docs.vercel.step3.item3")}</li>
    </ol>

    <div class="callout">
      <strong>Tip:</strong> ${t("docs.vercel.tip")}
    </div>
  `,

  "record-types": () => `
    <h1>${t("docs.records.title")}</h1>
    <p class="docs-subtitle">${t("docs.records.subtitle")}</p>

    <h2>${t("docs.records.a.title")}</h2>
    <p>${t("docs.records.a.desc")}</p>
    <pre><code>${t("docs.records.a.example")}</code></pre>

    <h2>${t("docs.records.cname.title")}</h2>
    <p>${t("docs.records.cname.desc")}</p>
    <pre><code>${t("docs.records.cname.example")}</code></pre>

    <h2>${t("docs.records.txt.title")}</h2>
    <p>${t("docs.records.txt.desc")}</p>
  `,

  "limits": () => `
    <h1>${t("docs.limits.title")}</h1>
    <p class="docs-subtitle">${t("docs.limits.subtitle")}</p>

    <h2>${t("docs.limits.free.title")}</h2>
    <p>${t("docs.limits.free.desc")}</p>

    <h2>${t("docs.limits.user.title")}</h2>
    <p>${t("docs.limits.user.desc")}</p>

    <h2>${t("docs.limits.agent.title")}</h2>
    <p>${t("docs.limits.agent.desc")}</p>

    <div class="callout">
      <strong>Tip:</strong> ${t("docs.limits.tip")}
    </div>
  `,
};

function renderDoc(docId) {
  const content = document.getElementById("docs-content");
  if (!content) return;

  const renderer = docs[docId];
  if (!renderer) return;

  content.innerHTML = renderer();

  // Update active link
  document.querySelectorAll(".docs-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.doc === docId);
  });
}

export function initializeDocsPage() {
  resetMessage();

  const hash = window.location.hash.replace("#", "") || "quick-start";
  renderDoc(hash);

  const sidebar = document.getElementById("docs-sidebar");
  if (!sidebar) return;

  sidebar.addEventListener("click", (e) => {
    const link = e.target.closest(".docs-link");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();

    const docId = link.dataset.doc;
    window.location.hash = docId;
    renderDoc(docId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}
