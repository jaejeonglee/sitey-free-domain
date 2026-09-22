import { getCurrentUser, apiFetch } from "./api.js";
import { navigateTo } from "./router.js";
import { showMessage, setButtonLoading, clearButtonLoading, showLoader, hideLoader, resetMessage } from "./ui.js";
import { normalizeRecordType, validateRecordValue } from "./util.js";
import { RECORD_TYPE_UI, RENEWAL_WINDOW_DAYS } from "./constants.js";
import { t, getLang } from "./i18n.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Sep 24" / "9월 24일" — a date short enough to sit inside a button. */
function shortDate(value) {
  return new Date(value).toLocaleDateString(getLang(), {
    month: "short",
    day: "numeric",
  });
}

/**
 * "2026-12-09 · 90 days left", and whether that is close enough to say loudly.
 *
 * Both halves, because neither works alone: a date on its own is a sum the
 * reader has to do, and "90 days" on its own cannot be put in a calendar.
 *
 * A record with no expiry (expires_at NULL — see deploy/migrations/002) says
 * so rather than showing an empty space, which reads as a value we failed to
 * load.
 *
 * `soon` is the fortnight renewal opens in, so what is highlighted here is
 * exactly what the button on the site would accept today.
 */
function expiryLine(expiresAt) {
  if (!expiresAt) {
    return { text: t("dashboard.expires_never"), soon: false };
  }

  const due = new Date(expiresAt);
  const daysLeft = Math.floor((due.getTime() - Date.now()) / DAY_MS);

  let left;
  if (daysLeft < 0) left = t("dashboard.expired");
  else if (daysLeft === 0) left = t("dashboard.expires_today");
  else if (daysLeft === 1) left = t("dashboard.expires_tomorrow");
  else left = t("dashboard.expires_days", { days: daysLeft });

  return {
    text: t("dashboard.expires", { date: due.toISOString().slice(0, 10), left }),
    soon: daysLeft <= RENEWAL_WINDOW_DAYS,
  };
}

/**
 * What a REDIRECT record's visit counts read as.
 *
 * Zero gets a sentence rather than "0 · 0": somebody who has just made a link
 * and sees three zeroes cannot tell "nobody has clicked it" from "this is
 * broken". Only REDIRECT rows are handed a `hits` object at all — an A or
 * CNAME is reached straight from DNS and never passes through this server, so
 * there is nothing of theirs to count (routes/domain.js).
 */
function hitsLine(hits) {
  if (!hits) return null;
  if (!hits.total) return t("dashboard.hits_none");
  return t("dashboard.hits", {
    month: hits.this_month,
    total: hits.total,
    date: hits.last_at ? shortDate(hits.last_at) : "—",
  });
}

/**
 * Whether the renew button can be pressed, and what it should say if not.
 *
 * The rule itself lives in services/expiry.js and is enforced there; this only
 * decides what the screen shows, and it has to agree — a button offered before
 * the server will take it produces a 409 the person did nothing to deserve.
 *
 * `show: false` only for a record with no expiry at all. There is nothing to
 * wait for there, so a permanently dead button would be furniture. Everything
 * else shows the button even when it is shut, with the date on its face:
 * hiding it is how people end up not knowing renewal exists.
 */
function renewState(expiresAt) {
  if (!expiresAt) return { show: false };

  const due = new Date(expiresAt);
  const daysLeft = Math.floor((due.getTime() - Date.now()) / DAY_MS);
  if (daysLeft <= RENEWAL_WINDOW_DAYS) {
    return { show: true, open: true, label: t("dashboard.renew") };
  }

  const opensAt = new Date(due.getTime() - RENEWAL_WINDOW_DAYS * DAY_MS);
  const date = shortDate(opensAt);
  return {
    show: true,
    open: false,
    // The date is the label, not a tooltip: a title attribute is invisible on
    // a phone, which is where most of these are read.
    label: t("dashboard.renew_from", { date }),
    title: t("dashboard.renew_from_title", { date }),
  };
}

/**
 * Paint a renew button for the date a record currently expires on.
 *
 * One function for both the first draw and the redraw after a renewal, so the
 * shut button somebody sees after pressing it is built by exactly the code
 * that decided it was pressable a second earlier.
 */
function applyRenewState(button, expiresAt) {
  const state = renewState(expiresAt);
  button.textContent = state.label || "";
  button.disabled = !state.open;
  if (state.open) {
    button.removeAttribute("title");
    button.removeAttribute("aria-label");
  } else {
    button.title = state.title || "";
    button.setAttribute("aria-label", state.title || "");
  }
}

/**
 * A labelled TXT box under the record's line.
 *
 * Two of these can appear on one record and they write to different names, so
 * neither goes without a label — a second box with no word beside it is a
 * guess, which is why the Vercel one has had one from the start.
 *
 * `note` is the reason the box is shut, and a shut box needs one: a disabled
 * field with nothing beside it reads as broken rather than as not applicable.
 * It is tied to the input by id, because a disabled input is out of the tab
 * order and a screen reader would otherwise reach the sentence separately from
 * the thing it is about.
 */
function txtField({ id, label, value, placeholder, inputClass, note }) {
  const field = document.createElement("div");
  field.className = "dashboard-item-field";

  const labelElement = document.createElement("label");
  labelElement.setAttribute("for", id);
  labelElement.textContent = label;

  const input = document.createElement("input");
  input.type = "text";
  input.id = id;
  input.className = inputClass;
  input.value = value || "";
  input.autocomplete = "off";
  input.autocapitalize = "none";
  input.spellcheck = false;
  input.placeholder = note ? "" : placeholder;
  input.disabled = Boolean(note);

  field.appendChild(labelElement);
  field.appendChild(input);

  if (note) {
    const why = document.createElement("p");
    why.className = "dashboard-field-note";
    why.id = `${id}-note`;
    why.textContent = note;
    input.setAttribute("aria-describedby", why.id);
    field.appendChild(why);
  }

  return field;
}

/**
 * One record, open.
 *
 * 🔴 Nothing folds. Every row shows its value in an editable box with Save,
 * Renew and Delete beside it, because the fold was doing the opposite of
 * what a control panel is for: Jay, 2026-09-16 — "마이페이지에서 지금 레코드를
 * 바꾸거나 이런건 안되네?" It was never that it could not be done, only that
 * nothing on screen said it could.
 *
 * Laid out to survive a long list — a hundred records is within the rules —
 * so the value and its three buttons share one line rather than stacking,
 * and the read-only copy of the value that used to sit in the header is
 * gone: the input is the value now, and showing it twice only cost height.
 */
export function createDashboardItem(item, index) {
  const wrapper = document.createElement("article");
  wrapper.className = "dashboard-item";
  wrapper.dataset.subdomain = item.subdomain;
  wrapper.dataset.domain = item.domain_name;
  const recordType = normalizeRecordType(item.record_type || item.recordType);
  const recordConfig = RECORD_TYPE_UI[recordType] || RECORD_TYPE_UI.A;
  const recordValue =
    item.record_value ?? item.recordValue ?? item.ip ?? "";
  wrapper.dataset.recordType = recordType;
  // The renew button is drawn from this and redrawn from it after a renewal,
  // so the row carries the date rather than the button carrying a copy.
  const expiresAt = item.expires_at ?? item.expiresAt;
  if (expiresAt) wrapper.dataset.expiresAt = new Date(expiresAt).toISOString();

  const header = document.createElement("div");
  header.className = "dashboard-item-head";

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

  const expiry = expiryLine(expiresAt);
  const expiryDisplay = document.createElement("span");
  expiryDisplay.className = expiry.soon ? "record-expiry soon" : "record-expiry";
  expiryDisplay.textContent = expiry.text;

  header.appendChild(domainGroup);
  header.appendChild(expiryDisplay);

  const hitsText = hitsLine(item.hits);
  if (hitsText) {
    const hitsDisplay = document.createElement("span");
    hitsDisplay.className = "record-hits";
    hitsDisplay.textContent = hitsText;
    header.appendChild(hitsDisplay);
  }

  const detail = document.createElement("div");
  detail.className = "dashboard-item-detail";

  const line = document.createElement("div");
  line.className = "dashboard-item-line";

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.id = `dashboard-record-${index}`;
  valueInput.className = "dashboard-record-input";
  valueInput.value = recordValue;
  valueInput.placeholder = recordConfig.placeholder;
  // No visible label: the type badge above already names what this is, and a
  // label per row is a line of height per row. Readers that cannot see the
  // badge get the same words here.
  valueInput.setAttribute("aria-label", `${item.subdomain}.${item.domain_name} — ${recordConfig.detailLabel}`);
  valueInput.autocomplete = "off";
  valueInput.autocapitalize = "none";
  valueInput.spellcheck = false;
  valueInput.inputMode = recordConfig.inputMode;

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "primary-button small";
  saveButton.dataset.action = "update";
  saveButton.textContent = t("dashboard.save");

  line.appendChild(valueInput);
  line.appendChild(saveButton);

  if (renewState(expiresAt).show) {
    const renewButton = document.createElement("button");
    renewButton.type = "button";
    renewButton.className = "small";
    renewButton.dataset.action = "renew";
    applyRenewState(renewButton, expiresAt);
    line.appendChild(renewButton);
  }

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger-button small";
  deleteButton.dataset.action = "delete";
  deleteButton.textContent = t("dashboard.delete");
  line.appendChild(deleteButton);

  detail.appendChild(line);

  // Two names a TXT record can go on, and the record type decides which of
  // them this record may use.
  //
  // A CNAME keeps the box it has always had: the value goes to `_vercel` at
  // the root domain, which is the only name a verification service reads for a
  // subdomain of a root that is not on the Public Suffix List.
  if (recordType === "CNAME") {
    detail.appendChild(
      txtField({
        id: `dashboard-txt-${index}`,
        label: t("dashboard.txt_label"),
        value: item.txt_value || "",
        placeholder: "e.g. vc-domain-verify=...",
        inputClass: "dashboard-txt-input",
      })
    );
  }

  // ...and everything else gets the record's own name, which is where a reader
  // handed that one hostname looks. Drawn on a CNAME too, shut, with the
  // reason in the space: leaving it out would make a CNAME owner think the
  // feature does not exist, and drawing it open would hand them a refusal they
  // could have been spared. DNS allows nothing beside a CNAME.
  detail.appendChild(
    txtField({
      id: `dashboard-self-txt-${index}`,
      label: t("dashboard.self_txt_label", {
        fqdn: `${item.subdomain}.${item.domain_name}`,
      }),
      value: recordType === "CNAME" ? "" : item.txt_value || "",
      placeholder: "e.g. v=MCPv1; k=ed25519; p=...",
      inputClass: "dashboard-self-txt-input",
      note: recordType === "CNAME" ? t("dashboard.self_txt_cname") : null,
    })
  );

  wrapper.appendChild(header);
  wrapper.appendChild(detail);

  return wrapper;
}

export function initializeDashboardPage() {
  resetMessage();
  const user = getCurrentUser();

  if (!user) {
    navigateTo("/login");
    return;
  }

  const dashboardList = document.getElementById("dashboard-list");
  if (!dashboardList) return;

  async function fetchSubdomains() {
    showLoader();
    dashboardList.innerHTML = `<p>${t("dashboard.loading")}</p>`;

    try {
      const data = await apiFetch("/api/subdomains", {
      });

      const items = Array.isArray(data) ? data : [];
      dashboardList.innerHTML = "";

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

    // One box per record. Which name the server writes it to follows from the
    // record type and is decided there, not here (services/subdomain.js
    // txtPrefixFor) — so the screen sends the value and nothing about where it
    // goes. An empty box clears the record, which is how it has always worked.
    // The shut box on a CNAME is skipped: it is a sentence, not an input.
    const txtInput = item.querySelector(
      recordType === "CNAME" ? ".dashboard-txt-input" : ".dashboard-self-txt-input"
    );
    if (txtInput && !txtInput.disabled) {
      body.txtValue = txtInput.value.trim();
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
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      clearButtonLoading(button);
      hideLoader();
    }
  }

  /**
   * Extend the lease, and show the new date where the old one was.
   *
   * Redrawing the whole list would work and would throw away anything typed in
   * another row's box; the only thing that changed is this record's date, so
   * only that is rewritten.
   */
  async function handleRenew(button) {
    if (!button || button.disabled) return;

    const item = button.closest(".dashboard-item");
    if (!item) return;

    const subdomain = item.dataset.subdomain;
    const domain = item.dataset.domain;
    if (!subdomain || !domain) return;

    setButtonLoading(button, "…");
    showLoader();
    try {
      const result = await apiFetch(
        `/api/subdomains/${encodeURIComponent(subdomain)}/renew`,
        { method: "POST", body: { domain } }
      );

      const expiry = expiryLine(result.expires_at);
      const expiryDisplay = item.querySelector(".record-expiry");
      if (expiryDisplay) {
        expiryDisplay.textContent = expiry.text;
        expiryDisplay.className = expiry.soon ? "record-expiry soon" : "record-expiry";
      }

      showMessage(
        t("dashboard.renew_success", {
          domain: `${subdomain}.${domain}`,
          date: new Date(result.expires_at).toISOString().slice(0, 10),
        }),
        "success"
      );

      item.dataset.expiresAt = new Date(result.expires_at).toISOString();
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      // clearButtonLoading restores the old label and re-enables; the button
      // then has to be repainted, because a record that has just been renewed
      // is shut again until a fortnight before its new date.
      clearButtonLoading(button);
      applyRenewState(button, item.dataset.expiresAt || null);
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
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      clearButtonLoading(button);
      hideLoader();
    }
  }

  fetchSubdomains();

  dashboardList.addEventListener("click", (event) => {
    const updateButton = event.target.closest("[data-action='update']");
    if (updateButton) {
      handleUpdate(updateButton);
      return;
    }

    const renewButton = event.target.closest("[data-action='renew']");
    if (renewButton) {
      handleRenew(renewButton);
      return;
    }

    const deleteButton = event.target.closest("[data-action='delete']");
    if (deleteButton) {
      handleDelete(deleteButton);
    }
  });
}
