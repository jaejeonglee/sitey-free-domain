import { apiFetch, getCurrentUser } from "./api.js";
import { navigateTo } from "./router.js";
import { showMessage, setButtonLoading, clearButtonLoading, showLoader, hideLoader, setHidden, clearChildren, resetMessage } from "./ui.js";
import { normalizeRecordType, validateRecordValue } from "./util.js";
import { SUBDOMAIN_REGEX, RECORD_TYPE_UI } from "./constants.js";
import { t } from "./i18n.js";

export function initializeLandingPage() {
  resetMessage();

  const form = document.getElementById("subdomain-form");
  const subdomainInput = document.getElementById("subdomain");
  const checkBtn = document.getElementById("check-btn");
  const resultsContainer = document.getElementById("availability-results");

  if (!form || !subdomainInput || !checkBtn || !resultsContainer) return;

  // Pre-fill from ?check= query param (e.g. from blog domain chip click)
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get("check");
  if (prefill && SUBDOMAIN_REGEX.test(prefill)) {
    subdomainInput.value = prefill;
    setTimeout(() => form.requestSubmit(), 0);
  }

  subdomainInput.addEventListener("input", () => {
    clearChildren(resultsContainer);
    setHidden(resultsContainer, true);
  });

  const createModal = document.getElementById("create-modal");
  const createModalDomain = document.getElementById("create-modal-domain");
  const createModalForm = document.getElementById("create-modal-form");
  const createModalType = document.getElementById("create-modal-type");
  const createModalValue = document.getElementById("create-modal-value");
  const createModalValueLabel = document.getElementById(
    "create-modal-value-label"
  );
  const createModalHelper = document.getElementById("create-modal-helper");
  const createModalTypeInfoBtn = document.getElementById(
    "create-modal-type-info"
  );
  const createModalTypeTooltip = document.getElementById(
    "create-modal-type-tooltip"
  );
  const createModalSubmit = document.getElementById("create-modal-submit");
  const createModalClose = document.getElementById("create-modal-close");
  const createModalBackdrop = document.querySelector(
    "#create-modal [data-modal-close]"
  );

  let isTypeTooltipOpen = false;

  function openTypeTooltip() {
    if (!createModalTypeInfoBtn || !createModalTypeTooltip) return;
    createModalTypeTooltip.classList.add("show");
    createModalTypeInfoBtn.setAttribute("aria-expanded", "true");
    isTypeTooltipOpen = true;
  }

  function closeTypeTooltip() {
    if (!createModalTypeInfoBtn || !createModalTypeTooltip) return;
    createModalTypeTooltip.classList.remove("show");
    createModalTypeInfoBtn.setAttribute("aria-expanded", "false");
    isTypeTooltipOpen = false;
  }

  function applyCreateModalType(type) {
    const config = RECORD_TYPE_UI[type] || RECORD_TYPE_UI.A;
    closeTypeTooltip();
    if (createModalValueLabel) {
      createModalValueLabel.textContent = config.label;
    }
    if (createModalValue) {
      createModalValue.placeholder = config.placeholder;
      createModalValue.setAttribute("inputmode", config.inputMode);
    }
    if (createModalHelper) {
      createModalHelper.textContent = config.helper;
    }
    if (createModalTypeTooltip && typeof config.tooltip === "string") {
      createModalTypeTooltip.textContent = config.tooltip;
    }
    if (createModalTypeInfoBtn) {
      const ariaLabel = config.tooltipLabel || `Learn about ${type} records`;
      createModalTypeInfoBtn.setAttribute("aria-label", ariaLabel);
      createModalTypeInfoBtn.setAttribute("title", ariaLabel);
    }
  }

  let activeCreateContext = null;
  let currentCreateRecordType = "A";

  const openCreateModal = (context) => {
    if (!createModal || !createModalDomain || !createModalValue) {
      return;
    }
    activeCreateContext = context;
    createModalDomain.textContent = `${context.subdomain}.${context.domain}`;
    const initialType = "A";
    if (createModalType) {
      createModalType.value = initialType;
    }
    applyCreateModalType(initialType);
    if (createModalValue) {
      createModalValue.value = "";
    }
    currentCreateRecordType = initialType;
    closeTypeTooltip();
    setHidden(createModal, false);
    document.body.classList.add("modal-open");
    setTimeout(() => createModalValue.focus(), 0);
  };

  const closeCreateModal = () => {
    if (!createModal) return;
    activeCreateContext = null;
    currentCreateRecordType = "A";
    closeTypeTooltip();
    setHidden(createModal, true);
    document.body.classList.remove("modal-open");
  };

  resultsContainer.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;

    if (button.dataset.action === "open-create") {
      const domain = button.dataset.domain;
      const subdomain = button.dataset.subdomain;
      if (!domain || !subdomain) {
        showMessage("Unable to prepare creation form.", "error");
        return;
      }

      if (!getCurrentUser()) {
        navigateTo("/login");
        return;
      }

      openCreateModal({ domain, subdomain });
      return;
    }

    const targetUrl = button.dataset.target;
    if (targetUrl) {
      navigateTo(targetUrl);
    }
  });

  if (createModalTypeInfoBtn) {
    createModalTypeInfoBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isTypeTooltipOpen) {
        closeTypeTooltip();
      } else {
        openTypeTooltip();
      }
    });
  }

  document.addEventListener("click", (event) => {
    if (!isTypeTooltipOpen) return;
    if (
      createModalTypeInfoBtn?.contains(event.target) ||
      createModalTypeTooltip?.contains(event.target)
    ) {
      return;
    }
    closeTypeTooltip();
  });

  if (createModalType) {
    createModalType.addEventListener("change", () => {
      const type = normalizeRecordType(createModalType.value);
      applyCreateModalType(type);
      if (type !== currentCreateRecordType && createModalValue) {
        createModalValue.value = "";
      }
      currentCreateRecordType = type;
      createModalValue?.focus();
    });
  }

  if (createModalClose) {
    createModalClose.addEventListener("click", closeCreateModal);
  }
  if (createModalBackdrop) {
    createModalBackdrop.addEventListener("click", closeCreateModal);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (isTypeTooltipOpen) {
        closeTypeTooltip();
      }
      if (createModal && !createModal.classList.contains("hidden")) {
        closeCreateModal();
      }
    }
  });

  if (createModalForm) {
    createModalForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!activeCreateContext) return;

      if (!getCurrentUser()) {
        closeCreateModal();
        navigateTo("/login");
        return;
      }

      const recordType = normalizeRecordType(createModalType?.value || currentCreateRecordType);
      const validation = validateRecordValue(
        recordType,
        createModalValue?.value,
        activeCreateContext
      );
      if (!validation.valid) {
        showMessage(validation.message, "error");
        createModalValue?.focus();
        createModalValue?.select?.();
        return;
      }
      const recordValue = validation.value;

      setButtonLoading(createModalSubmit, "Creating…");
      showLoader();

      try {
        await apiFetch("/api/subdomains", {
          method: "POST",
          body: {
            subdomain: activeCreateContext.subdomain,
            domain: activeCreateContext.domain,
            recordType,
            value: recordValue,
          },
        });

        const successMessage = `${recordType} record for ${activeCreateContext.subdomain}.${activeCreateContext.domain} created successfully.`;
        showMessage(successMessage, "success");

        const createdButton = resultsContainer.querySelector(
          `button[data-domain="${activeCreateContext.domain}"][data-subdomain="${activeCreateContext.subdomain}"]`
        );
        if (createdButton) {
          delete createdButton.dataset.action;
          createdButton.removeAttribute("data-target");
          createdButton.textContent = "Unavailable";
          createdButton.disabled = true;
          createdButton.tabIndex = -1;
          const row = createdButton.closest(".result-row");
          const status = row?.querySelector(".status");
          if (row) {
            row.classList.remove("available");
            row.classList.add("taken");
          }
          if (status) {
            status.classList.remove("available");
            status.classList.add("taken");
            status.textContent = "Taken";
          }
        }

        closeCreateModal();
      } catch (error) {
        showMessage(error.message, "error");
      } finally {
        clearButtonLoading(createModalSubmit);
        hideLoader();
      }
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const inputValue = subdomainInput.value.trim().toLowerCase();

    if (!inputValue) {
      showMessage(t("validation.enter_domain"), "error");
      return;
    }

    if (!SUBDOMAIN_REGEX.test(inputValue)) {
      showMessage(t("validation.invalid_format"), "error");
      return;
    }

    setButtonLoading(checkBtn, "Checking…");
    showLoader();
    clearChildren(resultsContainer);
    setHidden(resultsContainer, true);

    try {
      const data = await apiFetch("/api/check-availability", {
        method: "POST",
        body: { subdomain: inputValue },
      });

      const results = Array.isArray(data?.results) ? data.results : [];

      if (!results.length) {
        showMessage(t("validation.no_data"), "info");
        return;
      }

      const fragment = document.createDocumentFragment();
      results.forEach((result) => {
        fragment.appendChild(createAvailabilityRow(result));
      });

      resultsContainer.appendChild(fragment);
      setHidden(resultsContainer, false);
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      clearButtonLoading(checkBtn);
      hideLoader();
    }
  });
}

function createAvailabilityRow(result) {
    const row = document.createElement('div');
    row.className = 'result-row';

    const domainName = document.createElement('span');
    domainName.className = 'domain-name';
    domainName.textContent = `${result.subdomain}.${result.domain}`;
    row.appendChild(domainName);

    const status = document.createElement('span');
    status.className = 'status';
    row.appendChild(status);

    const button = document.createElement('button');
    button.className = 'primary-button small';
    row.appendChild(button);

    if (result.isAvailable === true) {
        status.classList.add('available');
        status.textContent = t('availability.available');
        button.textContent = t('availability.create');
        button.dataset.action = 'open-create';
        button.dataset.subdomain = result.subdomain;
        button.dataset.domain = result.domain;
    } else {
        status.classList.add('taken');
        status.textContent = t('availability.taken');
        button.textContent = t('availability.unavailable');
        button.disabled = true;
    }

    return row;
}
