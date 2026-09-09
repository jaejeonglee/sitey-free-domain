import { getCurrentUser, apiFetch } from "./api.js";
import { navigateTo } from "./router.js";
import { showMessage, setButtonLoading, clearButtonLoading, showLoader, hideLoader, resetMessage } from "./ui.js";
import { normalizeRecordType, validateRecordValue } from "./util.js";
import { RECORD_TYPE_UI } from "./constants.js";
import { refreshDomainCount } from "./home.js";
import { t } from "./i18n.js";

export function initializeDashboardPage() {
  resetMessage();
  const user = getCurrentUser();

  if (!user) {
    navigateTo("/login");
    return;
  }

  const dashboardList = document.getElementById("dashboard-list");
  if (!dashboardList) return;

  function createDashboardItem(item, index) {
    const wrapper = document.createElement("article");
    wrapper.className = "dashboard-item";
    wrapper.dataset.subdomain = item.subdomain;
    wrapper.dataset.domain = item.domain_name;
    const recordType = normalizeRecordType(item.record_type || item.recordType);
    const recordConfig = RECORD_TYPE_UI[recordType] || RECORD_TYPE_UI.A;
    const recordValue =
      item.record_value ?? item.recordValue ?? item.ip ?? "";
    wrapper.dataset.recordType = recordType;

    const header = document.createElement("div");
    header.className = "dashboard-item-header";
    header.setAttribute("aria-expanded", "false");
    header.setAttribute("role", "button");
    header.tabIndex = 0;

    const headerContent = document.createElement("div");
    headerContent.className = "dashboard-item-title";

    const domainName = document.createElement("span");
    domainName.className = "domain-name";
    domainName.textContent = `${item.subdomain}.${item.domain_name}`;

    const typeBadge = document.createElement("span");
    typeBadge.className = `record-type-badge type-${recordType.toLowerCase()}`;
    typeBadge.textContent = recordType;

    const domainGroup = document.createElement("div");
    domainGroup.className = "dashboard-item-domain";
    domainGroup.appendChild(domainName);
    domainGroup.appendChild(typeBadge);

    const valueDisplay = document.createElement("span");
    valueDisplay.className = "record-value";
    valueDisplay.textContent = recordValue;

    headerContent.appendChild(domainGroup);
    headerContent.appendChild(valueDisplay);

    const icon = document.createElement("span");
    icon.className = "dashboard-item-chevron";
    icon.setAttribute("aria-hidden", "true");

    header.appendChild(headerContent);
    header.appendChild(icon);

    const detail = document.createElement("div");
    detail.className = "dashboard-item-detail";
    detail.hidden = true;

    const field = document.createElement("div");
    field.className = "dashboard-item-field";

    const valueLabel = document.createElement("label");
    const inputId = `dashboard-record-${index}`;
    valueLabel.setAttribute("for", inputId);
    valueLabel.textContent = recordConfig.detailLabel;

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.id = inputId;
    valueInput.className = "dashboard-record-input";
    valueInput.value = recordValue;
    valueInput.placeholder = recordConfig.placeholder;
    valueInput.autocomplete = "off";
    valueInput.autocapitalize = "none";
    valueInput.spellcheck = false;
    valueInput.inputMode = recordConfig.inputMode;

    field.appendChild(valueLabel);
    field.appendChild(valueInput);
    detail.appendChild(field);

    if (recordType === "CNAME") {
      const txtField = document.createElement("div");
      txtField.className = "dashboard-item-field";

      const txtLabel = document.createElement("label");
      const txtInputId = `dashboard-txt-${index}`;
      txtLabel.setAttribute("for", txtInputId);
      txtLabel.textContent = t("dashboard.txt_label");

      const txtInput = document.createElement("input");
      txtInput.type = "text";
      txtInput.id = txtInputId;
      txtInput.className = "dashboard-txt-input";
      txtInput.value = item.txt_value || "";
      txtInput.placeholder = "e.g. vc-domain-verify=...";
      txtInput.autocomplete = "off";
      txtInput.autocapitalize = "none";
      txtInput.spellcheck = false;

      txtField.appendChild(txtLabel);
      txtField.appendChild(txtInput);
      detail.appendChild(txtField);
    }

    const actions = document.createElement("div");
    actions.className = "dashboard-item-actions";

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "primary-button";
    saveButton.dataset.action = "update";
    saveButton.textContent = t("dashboard.save");

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button";
    deleteButton.dataset.action = "delete";
    deleteButton.textContent = t("dashboard.delete");

    actions.appendChild(saveButton);
    actions.appendChild(deleteButton);

    detail.appendChild(actions);

    wrapper.appendChild(header);
    wrapper.appendChild(detail);

    return wrapper;
  }

  function toggleDashboardItem(itemElement, forceExpand) {
    if (!itemElement) return;
    const header = itemElement.querySelector(".dashboard-item-header");
    const detail = itemElement.querySelector(".dashboard-item-detail");
    if (!header || !detail) return;

    const shouldExpand =
      typeof forceExpand === "boolean" ? forceExpand : detail.hidden;

    detail.hidden = !shouldExpand;
    header.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
    itemElement.classList.toggle("expanded", shouldExpand);

    if (shouldExpand) {
      const input = detail.querySelector(".dashboard-record-input");
      requestAnimationFrame(() => {
        input?.focus();
      });
    }
  }


  /**
   * The same domains, drawn as desktop icons.
   *
   * One click selects, two opens the site — the gesture people already know
   * from the thing this page is dressed as. The cards below keep every
   * control; this is the view, not a replacement for them.
   */
  function renderIcons(items) {
    const shelf = document.getElementById("dashboard-icons");
    if (!shelf) return;
    shelf.innerHTML = "";

    for (const item of items) {
      const fqdn = `${item.subdomain}.${item.domain_name}`;

      const cell = document.createElement("a");
      cell.className = "desk-icon";
      cell.setAttribute("role", "listitem");
      cell.href = `https://${fqdn}`;
      cell.target = "_blank";
      cell.rel = "noopener noreferrer";
      cell.title = fqdn;

      const glyph = document.createElement("span");
      glyph.className = "desk-icon-glyph";
      glyph.setAttribute("aria-hidden", "true");

      const label = document.createElement("span");
      label.className = "desk-icon-label";
      label.textContent = item.subdomain;

      cell.append(glyph, label);

      // Single click selects rather than navigates: on a desktop one click
      // has never opened anything, and following the link here would take
      // people off the page they came to manage.
      cell.addEventListener("click", (event) => {
        if (event.detail === 1) {
          event.preventDefault();
          shelf.querySelectorAll(".desk-icon.selected")
            .forEach((n) => n.classList.remove("selected"));
          cell.classList.add("selected");
        }
      });

      shelf.appendChild(cell);
    }
  }

  async function fetchSubdomains() {
    showLoader();
    dashboardList.innerHTML = `<p>${t("dashboard.loading")}</p>`;

    try {
      const data = await apiFetch("/api/subdomains", {
      });

      const items = Array.isArray(data) ? data : [];
      dashboardList.innerHTML = "";
      renderIcons(items);

      if (!items.length) {
        dashboardList.innerHTML =
          `<p>${t("dashboard.empty")}</p>`;
        return;
      }

      const fragment = document.createDocumentFragment();
      items.forEach((item, index) => {
        fragment.appendChild(createDashboardItem(item, index));
      });

      dashboardList.appendChild(fragment);
    } catch (error) {
      showMessage(error.message, "error");
      dashboardList.innerHTML =
        `<p class="error">${t("dashboard.load_error")}</p>`;
    } finally {
      hideLoader();
    }
  }

  async function handleUpdate(button) {
    if (!button) return;

    const item = button.closest(".dashboard-item");
    if (!item) return;

    const subdomain = item.dataset.subdomain;
    const domain = item.dataset.domain;
    const recordType = normalizeRecordType(item.dataset.recordType);
    const valueInput = item.querySelector(".dashboard-record-input");
    const newValue = valueInput?.value;

    if (!subdomain || !domain || !valueInput) return;

    const validation = validateRecordValue(recordType, newValue, {
      subdomain,
      domain,
    });
    if (!validation.valid) {
      showMessage(validation.message, "error");
      valueInput.focus();
      valueInput.select?.();
      return;
    }
    const recordValue = validation.value;
    valueInput.value = recordValue;

    const body = { value: recordValue, domain };

    if (recordType === "CNAME") {
      const txtInput = item.querySelector(".dashboard-txt-input");
      body.txtValue = txtInput ? txtInput.value.trim() : "";
    }

    setButtonLoading(button, "Updating…");
    showLoader();
    try {
      await apiFetch(`/api/subdomains/${encodeURIComponent(subdomain)}`, {
        method: "PUT",
        body,
      });

      const successMessage = t("dashboard.update_success", { type: recordType, domain: `${subdomain}.${domain}` });
      showMessage(successMessage, "success");

      const valueDisplay = item.querySelector(
        ".dashboard-item-header .record-value"
      );
      if (valueDisplay) {
        valueDisplay.textContent = recordValue;
      }
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      clearButtonLoading(button);
      hideLoader();
    }
  }

  async function handleDelete(button) {
    if (!button) return;

    const item = button.closest(".dashboard-item");
    if (!item) return;

    const subdomain = item.dataset.subdomain;
    const domain = item.dataset.domain;
    const recordType = normalizeRecordType(item.dataset.recordType);
    if (!subdomain || !domain) return;

    const confirmed = window.confirm(
      t("dashboard.delete_confirm", { type: recordType, domain: `${subdomain}.${domain}` })
    );
    if (!confirmed) return;

    setButtonLoading(button, "Deleting…");
    showLoader();
    try {
      await apiFetch(`/api/subdomains/${encodeURIComponent(subdomain)}`, {
        method: "DELETE",
        body: { domain },
      });

      const successMessage = t("dashboard.delete_success", { type: recordType, domain: `${subdomain}.${domain}` });
      showMessage(successMessage, "success");
      await fetchSubdomains();
      refreshDomainCount();
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      clearButtonLoading(button);
      hideLoader();
    }
  }

  fetchSubdomains();

  dashboardList.addEventListener("click", (event) => {
    const header = event.target.closest(".dashboard-item-header");
    if (header) {
      const item = header.closest(".dashboard-item");
      toggleDashboardItem(item);
      return;
    }

    const updateButton = event.target.closest("[data-action='update']");
    if (updateButton) {
      handleUpdate(updateButton);
      return;
    }

    const deleteButton = event.target.closest("[data-action='delete']");
    if (deleteButton) {
      handleDelete(deleteButton);
    }
  });

  dashboardList.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" &&
      event.key !== " " &&
      event.key !== "Spacebar"
    ) {
      return;
    }
    const header = event.target.closest(".dashboard-item-header");
    if (!header) return;
    event.preventDefault();
    const item = header.closest(".dashboard-item");
    toggleDashboardItem(item);
  });
}
