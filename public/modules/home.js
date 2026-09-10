import { apiFetch, getCurrentUser } from "./api.js";
import { navigateTo } from "./router.js";
import { showMessage, setButtonLoading, clearButtonLoading, showLoader, hideLoader, setHidden, clearChildren, resetMessage } from "./ui.js";
import { normalizeRecordType, validateRecordValue } from "./util.js";
import { SUBDOMAIN_REGEX, RECORD_TYPE_UI } from "./constants.js";
import { t } from "./i18n.js";

// 350ms — 한 글자 칠 때마다 묻지 않을 만큼 길고, 멈췄다는 걸 사람이 느끼기
// 전에 답이 오는 길이다.
const SEARCH_DEBOUNCE_MS = 350;

export function initializeLandingPage() {
  resetMessage();

  const form = document.getElementById("subdomain-form");
  const subdomainInput = document.getElementById("subdomain");
  const domainSelect = document.getElementById("domain-preference");
  const searchBar = document.getElementById("search-bar");
  const resultsContainer = document.getElementById("availability-results");

  if (!form || !subdomainInput || !domainSelect || !searchBar || !resultsContainer) return;

  /* ============================================
     The search

     One request answers the whole list: POST /api/check-availability takes a
     name and returns a row per managed domain. Calling it once per domain
     would be four round trips for the same answer.

     The select only decides which row goes first, so changing it re-orders
     what we already have instead of asking again.
     ============================================ */

  let searchTimer = null;
  let latestRequest = 0;
  let lastResults = [];

  const setSearching = (on) => searchBar.classList.toggle("on", on);

  function showHint(text) {
    clearChildren(resultsContainer);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = text;
    resultsContainer.appendChild(hint);
  }

  /** The chosen domain first, the rest in the order the server sent them. */
  function inPreferredOrder(results) {
    const preferred = domainSelect.value;
    if (!preferred) return results;
    return [
      ...results.filter((r) => r.domain === preferred),
      ...results.filter((r) => r.domain !== preferred),
    ];
  }

  function renderResults(results) {
    lastResults = results;
    clearChildren(resultsContainer);
    const fragment = document.createDocumentFragment();
    inPreferredOrder(results).forEach((result) => {
      fragment.appendChild(createAvailabilityRow(result));
    });
    resultsContainer.appendChild(fragment);
  }

  async function runSearch(name) {
    // Debounced requests can land out of order — a slow answer for "ja" must
    // not overwrite a fresh one for "jay". Only the newest token may draw.
    const token = ++latestRequest;
    setSearching(true);

    try {
      const data = await apiFetch("/api/check-availability", {
        method: "POST",
        body: { subdomain: name },
      });
      if (token !== latestRequest) return;

      const results = Array.isArray(data?.results) ? data.results : [];
      if (!results.length) {
        showHint(t("validation.no_data"));
        return;
      }
      renderResults(results);
    } catch (error) {
      if (token !== latestRequest) return;
      showHint(error.message);
    } finally {
      if (token === latestRequest) setSearching(false);
    }
  }

  function scheduleSearch(immediate = false) {
    clearTimeout(searchTimer);
    const name = subdomainInput.value.trim().toLowerCase();

    // 비어 있을 때는 아무것도 쓰지 않는다 — 안내는 플레이스홀더가 이미 하고
    // 있고, 같은 말을 두 군데 두면 화면만 시끄러워진다.
    if (!name) {
      latestRequest += 1; // drop anything still in flight
      lastResults = [];
      setSearching(false);
      clearChildren(resultsContainer);
      return;
    }

    // 서버와 같은 규칙으로 화면에서 먼저 거른다. 안 될 이름으로 기다리지
    // 않아도 되고, 거절당할 것이 뻔한 요청을 보내지도 않는다.
    if (!SUBDOMAIN_REGEX.test(name)) {
      latestRequest += 1;
      lastResults = [];
      setSearching(false);
      showHint(t("home.hint.bad"));
      return;
    }

    if (immediate) {
      runSearch(name);
      return;
    }
    setSearching(true);
    searchTimer = setTimeout(() => runSearch(name), SEARCH_DEBOUNCE_MS);
  }

  subdomainInput.addEventListener("input", () => scheduleSearch());
  domainSelect.addEventListener("change", () => {
    if (lastResults.length) renderResults(lastResults);
  });

  // Enter skips the wait rather than reloading the page.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    scheduleSearch(true);
  });

  loadDomainOptions(domainSelect).then(() => {
    if (lastResults.length) renderResults(lastResults);
  });

  // Pre-fill from ?check= query param (e.g. from blog domain chip click)
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get("check");
  if (prefill && SUBDOMAIN_REGEX.test(prefill)) {
    subdomainInput.value = prefill;
    scheduleSearch(true);
  }

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

        // The row you just used stops offering itself. Swapping the button
        // for the chip is the same shape the row would have had if the
        // search had run a second later.
        const createdButton = resultsContainer.querySelector(
          `button[data-domain="${activeCreateContext.domain}"][data-subdomain="${activeCreateContext.subdomain}"]`
        );
        const createdRow = createdButton?.closest(".result-row");
        if (createdRow) {
          createdRow.classList.remove("free");
          createdRow.classList.add("taken");
          createdButton.replaceWith(takenChip());
        }
        lastResults = lastResults.map((result) =>
          result.domain === activeCreateContext.domain
            ? { ...result, isAvailable: false }
            : result
        );

        closeCreateModal();
      } catch (error) {
        showMessage(error.message, "error");
      } finally {
        clearButtonLoading(createModalSubmit);
        hideLoader();
      }
    });
  }
}

/** The grey label a row wears when its name is gone, or when we could not tell. */
function takenChip(key = "availability.taken") {
  const chip = document.createElement("span");
  chip.className = "state";
  chip.textContent = t(key);
  return chip;
}

/**
 * One row: a dot, the address, and one box on the right.
 *
 * 오른쪽 끝은 규격이 하나다. 버튼과 딱지의 크기가 다르면 줄마다 오른쪽 끝이
 * 들쭉날쭉해진다. 같은 min-width 를 주고 «색과 무게»로만 구분한다.
 *
 * A domain whose zone we could not read comes back with `error` and no
 * verdict. It gets its own row rather than being folded into "taken": the
 * one thing we must not do is tell someone a free name is gone.
 */
function createAvailabilityRow(result) {
  const available = result.isAvailable === true;
  const unknown = result.isAvailable !== true && result.isAvailable !== false;
  const fqdn = `${result.subdomain}.${result.domain}`;

  const row = document.createElement("div");
  row.className = `result-row ${available ? "free" : "taken"}`;

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");

  const domainName = document.createElement("span");
  domainName.className = "domain-name mono";
  domainName.textContent = fqdn;

  row.append(dot, domainName);

  if (!available) {
    row.appendChild(takenChip(unknown ? "availability.unknown" : "availability.taken"));
    return row;
  }

  // 「비어 있음」을 따로 쓰지 않는다. 쉬고 있는 버튼이 「사용 가능」이라고
  // 이미 말하고 있어서, 옆에 또 쓰면 같은 말이 둘이 된다.
  const rest = t("availability.available");
  const hover = t("availability.take");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "take";
  button.dataset.action = "open-create";
  button.dataset.subdomain = result.subdomain;
  button.dataset.domain = result.domain;
  // 읽어주는 프로그램에는 굴러가는 두 판이 안 보인다. 상태와 행동을 한 줄에.
  button.setAttribute("aria-label", `${fqdn} ${rest}, ${hover}`);

  const roll = document.createElement("span");
  roll.className = "roll";
  roll.dataset.rest = rest;
  roll.dataset.hover = hover;
  // 판 두 장은 둘 다 절대 배치라 폭을 만들지 않는다. 상자 폭을 정하는 것은
  // 이 투명한 진짜 글자이므로 «긴 쪽»을 넣는다 — 짧은 쪽을 넣으면 굴러갈 때
  // 긴 쪽이 눌린다. 한국어는 「사용 가능」이 길고 영어는 Available 이 길다.
  roll.textContent = rest.length >= hover.length ? rest : hover;

  button.appendChild(roll);
  row.appendChild(button);
  return row;
}

/**
 * The roots we hand out, straight from the server — the list is a database
 * table, not a constant, and a hard-coded copy here would go stale the day a
 * new one is added.
 */
async function loadDomainOptions(select) {
  try {
    const data = await apiFetch("/api/managed-domains");
    const domains = Array.isArray(data?.domains) ? data.domains : [];
    for (const domain of domains) {
      const option = document.createElement("option");
      option.value = domain;
      option.textContent = domain;
      select.appendChild(option);
    }
  } catch {
    // 목록을 못 받아도 검색은 된다 — 먼저 볼 도메인을 못 고를 뿐이고,
    // 그때는 서버가 보낸 순서 그대로 나온다. (:empty 면 CSS 가 감춘다)
  }
}
