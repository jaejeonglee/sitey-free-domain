// public/modules/dashboard.js — 내 주소 (/dashboard), 2026-11-11.
//
// One address, one row; the row's «수정 ›» opens the address's edit window
// (a <dialog>: a box pinned at the top on a desktop, a sheet from the bottom
// on a phone). Mockup and its review history:
// ~/Develop/design-drafts/sitey-dashboard (Jay «응 그리고 목록에서 누르면 모달 떠서
// 그 안에서 수정을 하는게 낫지 않나»).
//
// 🔴 The 2026-09-16 lesson still holds — folded rows read as «nothing here can
// be changed». So every row shows «수정 ›» all the time, and that one button's
// hit area is the whole row (style.css `.edit::after`). ↗ and [갱신] sit above
// it as separate elements; there is never a button inside a button.
//
// Order is decided once, on the first draw (renewable → unreachable → soonest
// to expire). After a save or a renewal the row stays where it is and flashes;
// rows that jump away from under the cursor are worse than a stale order.
import { getCurrentUser, apiFetch } from "./api.js";
import { setBackHandler } from "./router.js";
import { validateRecordValue } from "./util.js";
import { IPV4_REGEX, RENEWAL_WINDOW_DAYS } from "./constants.js";
import { t, getLang } from "./i18n.js";
import { savePendingEdit, takePendingEdit } from "./pending-claim.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNT_KEY = "sitey-dash-count";
const TYPES = ["CNAME", "A", "REDIRECT"];
const TYPE_LABEL = {
  CNAME: "dashboard.type.cname",
  A: "dashboard.type.a",
  REDIRECT: "dashboard.type.redirect",
};
const TYPE_TAG = { CNAME: "CNAME", A: "A", REDIRECT: "Redirect" };
const VALUE_PLACEHOLDER = { CNAME: "cname.vercel-dns.com", A: "203.0.113.24", REDIRECT: "https://" };
const TXT_PLACEHOLDER = { CNAME: "vc-domain-verify=…", SELF: "v=MCPv1; k=ed25519; p=…" };

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Which TXT name a type writes to — services/subdomain.js txtPrefixFor. */
const txtSlot = (type) => (type === "CNAME" ? "_vercel" : "@");

/** Whole days until the date — the same floor renewState used, so the same day count the server agrees with. */
function daysUntil(date) {
  return Math.floor((date.getTime() - Date.now()) / DAY_MS);
}

/**
 * Whether the renew button is offered. The rule is enforced in
 * services/expiry.js; this only has to agree with it (RENEWAL_WINDOW_DAYS) —
 * a button the server will refuse is a 409 the person did nothing to earn.
 */
function renewable(item) {
  return Boolean(item.exp) && !item.renewedTo && daysUntil(item.exp) <= RENEWAL_WINDOW_DAYS;
}

const isoDate = (date) => date.toISOString().slice(0, 10);
const monthDay = (date) => date.toLocaleDateString(getLang(), { month: "long", day: "numeric" });

/**
 * «정상» · «접속 불가» · «확인 전». A fresh answer from this session (save or
 * «지금 확인») wins over the nightly one; with no nightly check yet and no
 * fresh answer, nothing is guessed.
 */
function liveState(item) {
  if (item.fresh) return item.fresh.reachable ? "ok" : "down";
  if (!item.checked) return "unknown";
  return item.warn > 0 ? "down" : "ok";
}

function failedDays(item) {
  if (!(item.warn > 0)) return "";
  return item.warn === 1 ? t("dashboard.status.day") : t("dashboard.status.days", { days: item.warn });
}

/** «만료 7일 전» on a row. */
function rowExpiry(item) {
  if (!item.exp) return t("dashboard.expires_never");
  const days = daysUntil(item.exp);
  if (days < 0) return t("dashboard.expired");
  if (days === 0) return t("dashboard.expires_today");
  if (days === 1) return t("dashboard.expires_tomorrow");
  return t("dashboard.expires_days", { days });
}

/** «만료일 2026-12-07 (26일 남음)» in the window. */
function windowExpiry(item) {
  const days = daysUntil(item.exp);
  const left =
    days < 0
      ? t("dashboard.expired")
      : days === 0
        ? t("dashboard.expires_today")
        : days === 1
          ? t("dashboard.day_left")
          : t("dashboard.days_left", { days });
  return `${t("dashboard.expiry_on", { date: isoDate(item.exp) })} (${left})`;
}

export function fromApi(row) {
  const type = String(row.record_type || "A").toUpperCase();
  return {
    key: `${row.subdomain}.${row.domain_name}`.toLowerCase(),
    sub: row.subdomain,
    dom: row.domain_name,
    type: TYPES.includes(type) ? type : "A",
    value: row.record_value ?? "",
    txt: row.txt_value || "",
    exp: row.expires_at ? new Date(row.expires_at) : null,
    hits: row.hits || null,
    warn: Number(row.warning_count || 0),
    checked: row.last_checked_at ? new Date(row.last_checked_at) : null,
    fresh: null,
    renewedTo: null,
  };
}

function addrHTML(item) {
  const state = liveState(item);
  const word = t(`dashboard.status.${state}`);
  return `<span class="addr" aria-label="${esc(item.key)}, ${esc(word)}"><span class="nm">${esc(item.sub)}</span><span class="pt${state === "unknown" ? "" : ` ${state}`}" aria-hidden="true">.</span><span class="tl">${esc(item.dom)}</span></span>`;
}

/** One row. Exported for tests/redirect-hits.test.js — the markup is the contract. */
export function rowHTML(item, { flash = false, fresh = false } = {}) {
  const state = liveState(item);
  const soon = renewable(item);
  const alert =
    state === "down"
      ? [t("dashboard.status.down"), failedDays(item)].filter(Boolean).join(" · ")
      : state === "unknown"
        ? t("dashboard.status.unknown")
        : "";
  const renewed = item.renewedTo
    ? `<span class="days done"><span class="${fresh ? "new" : ""}">${esc(t("dashboard.renewed"))}</span></span>`
    : null;
  const days = renewed || `<span class="days${soon ? " soon" : ""}">${esc(rowExpiry(item))}</span>`;
  const renewButton = soon
    ? `<button class="renew" type="button" data-renew aria-label="${esc(t("dashboard.renew_aria", { fqdn: item.key }))}">${esc(t("dashboard.renew"))}</button>`
    : "";
  const phone = soon || item.renewedTo ? "m-renew" : state === "down" ? "m-down" : "m-days";
  const shown = item.value.replace(/^https:\/\//, "");

  return `
    <li class="dash-row ${phone}${flash ? " flash" : ""}" data-key="${esc(item.key)}">
      <div class="who">
        ${addrHTML(item)}
        <a class="out" href="https://${esc(item.key)}" target="_blank" rel="noopener" aria-label="${esc(t("dashboard.open_tab", { fqdn: item.key }))}">↗</a>
      </div>
      <span class="to" title="${esc(item.value)}">${esc(shown)}</span>
      <span class="alert${state === "unknown" ? " quiet" : ""}">${esc(alert)}</span>
      ${days}
      <span class="act">${renewButton}</span>
      <div class="meta-renew">${renewed || `<span class="days soon">${esc(rowExpiry(item))}</span>${renewButton}`}</div>
      <button class="edit" type="button" data-edit aria-label="${esc(t("dashboard.edit_aria", { fqdn: item.key }))}">${esc(t("dashboard.edit"))}<span class="chev" aria-hidden="true">›</span></button>
    </li>`;
}


/**
 * A REDIRECT's visits, in the edit window. Only REDIRECT rows carry `hits` —
 * an A or CNAME is reached straight from DNS and never passes through this
 * server — and zero gets a phrase rather than «0 · 0», which reads as broken.
 */
export function hitsText(item) {
  if (item.type !== "REDIRECT" || !item.hits) return "";
  return item.hits.total
    ? t("dashboard.hits", { month: item.hits.this_month, total: item.hits.total })
    : t("dashboard.hits_none");
}

/** Renewable → unreachable → soonest to expire. Used once, on the first draw. */
export function sortKeys(items) {
  const rank = (item) => (renewable(item) ? 0 : liveState(item) === "down" ? 1 : 2);
  const left = (item) => (item.exp ? item.exp.getTime() : Infinity);
  return [...items].sort((a, b) => rank(a) - rank(b) || left(a) - left(b)).map((item) => item.key);
}

export function initializeDashboardPage() {
  const user = getCurrentUser();
  if (!user) return; // the router has already sent this visitor to /login

  const root = document.querySelector(".dash");
  const listEl = document.getElementById("dash-list");
  const countEl = document.getElementById("dash-count");
  const newSlot = document.getElementById("dash-new");
  const sheet = document.getElementById("dash-sheet");
  const scrollEl = document.getElementById("sheet-scroll");
  const foot = document.getElementById("sheet-foot");
  const toastEl = document.getElementById("dash-toast");
  if (!root || !listEl || !sheet) return;

  let items = [];
  let order = null;

  // Which window to open once the list is in: ?edit=<address> from a mail, or
  // the one a sign-in interrupted (with what had been typed).
  const pending = takePendingEdit();
  const asked = new URLSearchParams(window.location.search).get("edit");
  if (asked) history.replaceState(null, "", "/dashboard");
  const target = (asked || pending?.key || "").toLowerCase() || null;
  const restoredDraft = pending && pending.key === target ? pending.draft : null;

  /* ---------- 알림 ---------- */
  let toastTimer = null;
  function toast(text, action = null) {
    toastEl.textContent = text;
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", action.run);
      toastEl.append(button);
    }
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), action ? 8000 : 3200);
  }

  /** Signed out somewhere else: say so, and offer the way back to this same spot. */
  function relogin(draftToKeep) {
    if (draftToKeep) savePendingEdit(draftToKeep.key, draftToKeep.draft);
    window.location.assign("/api/auth/google");
  }

  function sayError(error, keep) {
    if (error.status === 401) {
      toast(t("dashboard.session_expired"), { label: t("dashboard.relogin"), run: () => relogin(keep) });
    } else if (error.status === 429) {
      toast(t("dashboard.too_many"));
    } else {
      toast(error.message);
    }
  }

  /* ---------- 목록 ---------- */
  function skeleton() {
    let n = 3;
    try {
      n = Math.max(1, Math.min(12, Number(localStorage.getItem(COUNT_KEY)) || 3));
    } catch {
      // storage off: three rows
    }
    listEl.innerHTML = Array.from({ length: n }, () => '<li class="dash-skel" aria-hidden="true"><i></i></li>').join("");
    listEl.setAttribute("aria-busy", "true");
  }


  const ordered = () => order.map((key) => items.find((item) => item.key === key)).filter(Boolean);
  const byKey = (key) => items.find((item) => item.key === key);
  const rowOf = (item) => listEl.querySelector(`[data-key="${CSS.escape(item.key)}"]`);

  function drawHead() {
    const used = items.length;
    const limit = Number.isFinite(user.subdomainLimit) ? user.subdomainLimit : null;
    countEl.textContent =
      limit !== null ? t("dashboard.count", { used, limit }) : t("dashboard.count_plain", { used });
    // «reached» only when it stops anything: with the limit not enforced the
    // home page still creates, so the button stays (services/quota.js).
    newSlot.innerHTML =
      limit !== null && user.subdomainLimitEnforced && used >= limit
        ? `<p class="dash-full">${esc(t("dashboard.limit_reached", { limit }))}</p>`
        : `<a class="dash-btn" href="/">${esc(t("dashboard.add"))}</a>`;
  }

  function renderList() {
    const list = ordered();
    listEl.innerHTML = list.length
      ? list.map((item) => rowHTML(item)).join("")
      : `<li class="dash-empty"><p>${esc(t("dashboard.empty"))}</p><a class="dash-btn solid" href="/">${esc(t("dashboard.add"))}</a></li>`;
    listEl.removeAttribute("aria-busy");
    drawHead();
    try {
      localStorage.setItem(COUNT_KEY, String(items.length));
    } catch {
      // nothing to remember the count in
    }
  }

  function redrawRow(item, opts) {
    const row = rowOf(item);
    if (row) row.outerHTML = rowHTML(item, opts);
    return rowOf(item);
  }

  const rowVisible = (row) => {
    if (!row) return false;
    const box = row.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight;
  };

  function showListProblem(error) {
    listEl.removeAttribute("aria-busy");
    if (error.status === 401) {
      listEl.innerHTML = `<li class="dash-empty"><p>${esc(t("dashboard.session_expired"))}</p><button class="dash-btn solid" type="button" data-relogin>${esc(t("dashboard.relogin"))}</button></li>`;
      return;
    }
    listEl.innerHTML = `<li class="dash-empty"><p>${esc(t("dashboard.load_error"))}</p><button class="dash-btn" type="button" data-retry>${esc(t("dashboard.retry"))}</button></li>`;
  }

  // The address and the value are drawn in Open Runde and JetBrains Mono. A
  // row painted before they arrive is repainted a moment later at another
  // width, and every column after it moves — so the first paint waits for
  // them, for as long as the list itself takes and at most a second.
  const fontsReady = document.fonts?.load
    ? Promise.race([
        Promise.all([
          document.fonts.load('600 20px "Open Runde"'),
          document.fonts.load('400 15px "JetBrains Mono"'),
        ]).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ])
    : Promise.resolve();

  async function load() {
    skeleton();
    try {
      const [data] = await Promise.all([apiFetch("/api/subdomains"), fontsReady]);
      items = (Array.isArray(data) ? data : []).map(fromApi);
      if (!order) order = sortKeys(items);
      else order = [...order.filter((key) => byKey(key)), ...items.map((i) => i.key).filter((k) => !order.includes(k))];
      renderList();
    } catch (error) {
      showListProblem(error);
      return;
    }

    if (target) {
      const item = byKey(target);
      if (item) openSheet(item, rowOf(item)?.querySelector("[data-edit]"), restoredDraft);
      else toast(t("dashboard.not_found", { fqdn: target }));
    }
  }

  listEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry]")) return load();
    if (event.target.closest("[data-relogin]")) return relogin(null);
    const row = event.target.closest(".dash-row");
    if (!row) return;
    const item = byKey(row.dataset.key);
    if (!item) return;
    const renewButton = event.target.closest("[data-renew]");
    if (renewButton) return renew(item, renewButton, "row");
    if (event.target.closest(".out")) return;
    if (event.target.closest("[data-edit]")) openSheet(item, row.querySelector("[data-edit]"));
  });

  async function renew(item, button, from) {
    // Dimmed while it works, same word on it — «갱신 중…» is wider than the
    // column the button sits in and would run into the date beside it.
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const result = await apiFetch(`/api/subdomains/${encodeURIComponent(item.sub)}/renew`, {
        method: "POST",
        body: { domain: item.dom },
      });
      item.exp = new Date(result.expires_at);
      item.renewedTo = item.exp;
      const row = redrawRow(item, { fresh: true });
      if (sheet.open && current === item) drawSheet();
      // A row on screen says it itself; only an unseen one needs the line.
      if (from !== "row" || !rowVisible(row)) {
        toast(t("dashboard.renew_success", { domain: item.key, date: isoDate(item.exp) }));
      }
    } catch (error) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (error.status === 409 && error.data?.renew_from) {
        toast(t("dashboard.renew_from_title", { date: monthDay(new Date(error.data.renew_from)) }));
      } else {
        sayError(error, null);
      }
    }
  }

  /* ---------- 관리 창 ---------- */
  let current = null;
  let opener = null;
  let draft = null;
  let mode = "edit"; // edit · delete · discard · signin
  let pushed = false;
  let expectPop = false;
  const phone = () => window.matchMedia("(max-width: 720px)").matches;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** The TXT value the window starts from for a type: the record's own when the name is the same one. */
  const baseTxt = (type) => (txtSlot(type) === txtSlot(current.type) ? current.txt : "");

  function dirty() {
    if (!draft || !current) return false;
    return (
      draft.value.trim() !== current.value ||
      draft.type !== current.type ||
      draft.txt.trim() !== baseTxt(draft.type)
    );
  }

  function liveLine(item) {
    if (item.checking) return esc(t("dashboard.status.checking"));
    const state = liveState(item);
    if (item.fresh) {
      return `<strong>${esc(t(`dashboard.status.${state}`))}</strong> · ${esc(t("dashboard.status.checked", { date: t("dashboard.status.now") }))}`;
    }
    if (state === "unknown") return esc(t("dashboard.status.unknown"));
    const parts = [`<strong>${esc(t(`dashboard.status.${state}`))}</strong>`];
    if (state === "down" && failedDays(item)) parts.push(esc(failedDays(item)));
    parts.push(esc(t("dashboard.status.checked", { date: monthDay(item.checked) })));
    return parts.join(" · ");
  }

  function expiryHTML(item) {
    if (item.renewedTo) {
      return `<span class="when"><span class="new">${esc(t("dashboard.renewed_line", { date: isoDate(item.exp) }))}</span></span>`;
    }
    if (!item.exp) return `<span class="when">${esc(t("dashboard.expires_never"))}</span>`;
    if (renewable(item)) {
      return `<span class="when soon">${esc(windowExpiry(item))}</span><button class="dash-btn solid" type="button" data-renew>${esc(t("dashboard.renew"))}</button>`;
    }
    return `<span class="when">${esc(windowExpiry(item))}</span>`;
  }

  function hitsHTML(item) {
    const text = hitsText(item);
    return text ? `<p class="sh-hits">${esc(text)}</p>` : "";
  }

  function confirmHTML(item) {
    const [before, after = ""] = t("dashboard.delete_confirm").split("{domain}");
    return `<div class="confirm" role="group" aria-labelledby="cf-text">
        <p id="cf-text">${esc(before)}<strong>${esc(item.key)}</strong>${esc(after)}</p>
        <div class="acts"><button class="dash-btn" type="button" data-keep>${esc(t("dashboard.cancel"))}</button><button class="dash-btn red" type="button" data-delete>${esc(t("dashboard.delete"))}</button></div>
      </div>`;
  }

  function drawSheet() {
    const item = current;
    const type = draft.type;
    const txtHost = type === "CNAME" ? `_vercel.${item.dom}` : item.key;
    const openTxt = Boolean(baseTxt(type) || draft.txt);

    // Keep the caret where it was — a «check now» answer redraws the window
    // while somebody may be typing in it.
    const active = document.activeElement;
    const keep = active && sheet.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;

    scrollEl.innerHTML = `
      <div class="sh-top">
        <h2 id="sheet-name"><a href="https://${esc(item.key)}" target="_blank" rel="noopener">${addrHTML(item)}<span class="ar" aria-label="${esc(t("dashboard.open_tab", { fqdn: item.key }))}">↗</span></a></h2>
        <button class="x" type="button" data-close aria-label="${esc(t("dashboard.close"))}">✕</button>
      </div>
      <p class="sh-live${liveState(item) === "down" && !item.checking ? " down" : ""}">${liveLine(item)}<button class="textbtn" type="button" data-recheck${item.checking ? " disabled" : ""}>${esc(t("dashboard.check_now"))}</button></p>
      ${hitsHTML(item)}
      <div class="sh-exp">${expiryHTML(item)}</div>

      <div class="form">
        <div class="field">
          <div class="lab"><label for="sheet-value">${esc(t("dashboard.target"))}</label><span class="tag">${TYPE_TAG[type]}</span><button class="retype" type="button" data-retype aria-expanded="${draft.showTypes ? "true" : "false"}">${esc(t("dashboard.retype"))}</button></div>
          ${draft.showTypes ? `<div class="types" role="group" aria-label="${esc(t("dashboard.types"))}">${TYPES.map((k) => `<button type="button" data-type="${k}" aria-pressed="${k === type}">${esc(t(TYPE_LABEL[k]))}</button>`).join("")}</div>` : ""}
          <input id="sheet-value" value="${esc(draft.value)}" placeholder="${VALUE_PLACEHOLDER[type]}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="${type === "A" ? "decimal" : "url"}" enterkeyhint="done"${draft.err ? ' class="bad" aria-invalid="true" aria-describedby="sheet-err"' : ""}>
          ${draft.err ? `<p class="err" id="sheet-err">${esc(draft.err)}</p>` : ""}
        </div>
        <details class="field"${openTxt ? " open" : ""}>
          <summary>${esc(t("dashboard.txt"))} <span class="opt">${esc(t("dashboard.txt_host", { host: txtHost }))}</span></summary>
          <textarea id="sheet-txt" rows="1" aria-label="${esc(t("dashboard.txt_value"))}" placeholder="${type === "CNAME" ? TXT_PLACEHOLDER.CNAME : TXT_PLACEHOLDER.SELF}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">${esc(draft.txt)}</textarea>
        </details>
      </div>

      <div class="danger">
        ${mode === "delete" ? confirmHTML(item) : `<button class="del" type="button" data-ask-delete>${esc(t("dashboard.delete_address"))}</button>`}
      </div>`;

    // While a delete is being confirmed there is one pair of decisions on
    // screen, not two.
    foot.hidden = mode === "delete";
    if (mode === "discard") {
      foot.innerHTML = `<span class="ask">${esc(t("dashboard.unsaved"))}</span><button class="dash-btn" type="button" data-stay>${esc(t("dashboard.keep_editing"))}</button><button class="dash-btn solid" type="button" data-discard>${esc(t("dashboard.discard"))}</button>`;
    } else if (mode === "signin") {
      foot.innerHTML = `<span class="ask">${esc(t("dashboard.session_expired"))}</span><button class="dash-btn solid" type="button" data-relogin>${esc(t("dashboard.relogin"))}</button>`;
    } else {
      foot.innerHTML = `<button class="dash-btn" type="button" data-close>${esc(t("dashboard.cancel"))}</button><button class="dash-btn solid" type="button" data-save${dirty() && !draft.saving ? "" : " disabled"}>${esc(draft.saving ? t("dashboard.saving") : t("dashboard.save"))}</button>`;
    }
    grow(document.getElementById("sheet-txt"));

    if (keep) {
      const again = document.getElementById(keep.id);
      if (again) {
        again.focus();
        try {
          if (keep.start !== null && keep.start !== undefined) again.setSelectionRange(keep.start, keep.end);
        } catch {
          // not a text field
        }
      }
    }
  }

  // field-sizing does it where it is known; elsewhere (some Safari) by hand.
  const autoSize = window.CSS?.supports?.("field-sizing", "content");
  function grow(area) {
    if (!area || autoSize || !area.offsetParent) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + 2}px`;
  }

  function openSheet(item, from, restored = null) {
    current = item;
    opener = from || null;
    mode = "edit";
    draft = restored
      ? { value: restored.value, txt: restored.txt, type: restored.type, showTypes: restored.type !== item.type, err: null, saving: false }
      : { value: item.value, txt: item.txt, type: item.type, showTypes: false, err: null, saving: false };
    draft.txtBySlot = { [txtSlot(item.type)]: item.txt };
    drawSheet();
    sheet.classList.remove("closing");
    sheet.setAttribute("tabindex", "-1");
    sheet.showModal();
    // On a phone the keyboard does not come up first — most come to look, check or renew.
    if (phone()) {
      sheet.focus();
      history.pushState({ sheet: 1 }, "");
      pushed = true;
    } else {
      const input = document.getElementById("sheet-value");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    fitViewport();
  }

  function closeSheet(force = false, after = null) {
    if (!sheet.open) return true;
    if (!force && dirty() && mode !== "discard") {
      mode = "discard";
      drawSheet();
      foot.querySelector("[data-stay]")?.focus();
      return false;
    }
    const key = current?.key;
    sheet.classList.add("closing");
    setTimeout(() => {
      sheet.close();
      sheet.classList.remove("closing");
      if (pushed) {
        pushed = false;
        expectPop = true;
        history.back();
      }
      current = null;
      draft = null;
      mode = "edit";
      if (after) return after();
      const back = key && listEl.querySelector(`[data-key="${CSS.escape(key)}"] [data-edit]`);
      (back || opener)?.focus?.();
    }, reduced() ? 0 : 180);
    return true;
  }

  // Back on a phone closes the sheet, not the page under it.
  setBackHandler(() => {
    if (!document.contains(sheet)) return false;
    if (expectPop) {
      expectPop = false;
      return true;
    }
    if (!sheet.open) return false;
    pushed = false;
    if (dirty()) {
      history.pushState({ sheet: 1 }, "");
      pushed = true;
      mode = "discard";
      drawSheet();
      return true;
    }
    closeSheet(true);
    return true;
  });

  function check(type, raw) {
    const value = raw.trim();
    if (type === "CNAME" && IPV4_REGEX.test(value)) {
      return { valid: false, message: t("dashboard.ip_needs_a"), offerTypes: true };
    }
    const result = validateRecordValue(type, value, { subdomain: current.sub, domain: current.dom });
    if (!result.valid && type === "A") result.offerTypes = true;
    return result;
  }

  async function save() {
    const item = current;
    if (draft.saving || !dirty()) return;
    const type = draft.type;

    if (type === "CNAME" && item.type !== "CNAME" && item.txt) {
      draft.err = t("dashboard.txt_blocks_cname");
      drawSheet();
      return;
    }
    const result = check(type, draft.value);
    if (!result.valid) {
      draft.err = result.message;
      if (result.offerTypes) draft.showTypes = true;
      drawSheet();
      document.getElementById("sheet-value")?.focus();
      return;
    }

    const body = { domain: item.dom, value: result.value };
    if (type !== item.type) body.recordType = type;
    const txt = draft.txt.trim();
    // Same TXT name as before: the box is the record's TXT, and empty clears
    // it. A type change that moves to the other name only writes when
    // something was typed there.
    const sameSlot = txtSlot(type) === txtSlot(item.type);
    if (sameSlot || txt) body.txtValue = txt;

    draft.saving = true;
    drawSheet();
    try {
      const response = await apiFetch(`/api/subdomains/${encodeURIComponent(item.sub)}`, { method: "PUT", body });
      const moved = result.value !== item.value || type !== item.type;
      item.value = result.value;
      item.type = type;
      item.txt = sameSlot || txt ? txt : "";
      // The nightly run of failed days was about the old target; until the
      // night looks again the row says only what this save saw.
      if (moved) {
        item.fresh = { reachable: Boolean(response.reachable) };
        item.warn = 0;
      }
      closeSheet(true, () => {
        const row = redrawRow(item, { flash: true });
        row?.querySelector("[data-edit]")?.focus();
        toast(
          !moved
            ? t("dashboard.update_success", { domain: item.key })
            : response.reachable
              ? t("dashboard.saved_ok", { domain: item.key })
              : t("dashboard.saved_down", { domain: item.key })
        );
      });
    } catch (error) {
      draft.saving = false;
      if (error.status === 401) {
        mode = "signin";
      } else if (error.code === "CNAME_CANNOT_HOLD_TXT") {
        draft.err = t("dashboard.txt_blocks_cname");
      } else if (error.status === 429) {
        draft.err = t("dashboard.too_many");
      } else {
        draft.err = error.message;
      }
      drawSheet();
    }
  }

  async function recheck() {
    const item = current;
    item.checking = true;
    drawSheet();
    try {
      const result = await apiFetch(`/api/subdomains/${encodeURIComponent(item.sub)}/check`, {
        method: "POST",
        body: { domain: item.dom },
      });
      item.warn = Number(result.warning_count || 0);
      if (result.last_checked_at) item.checked = new Date(result.last_checked_at);
      item.fresh = { reachable: Boolean(result.reachable) };
    } catch (error) {
      if (error.status === 401) mode = "signin";
      else sayError(error, null);
    }
    item.checking = false;
    if (sheet.open && current === item) drawSheet();
    redrawRow(item);
  }

  async function remove(button) {
    const item = current;
    button.disabled = true;
    try {
      await apiFetch(`/api/subdomains/${encodeURIComponent(item.sub)}`, {
        method: "DELETE",
        body: { domain: item.dom },
      });
    } catch (error) {
      button.disabled = false;
      if (error.status === 401) {
        mode = "signin";
        drawSheet();
      } else {
        sayError(error, null);
      }
      return;
    }
    const list = ordered();
    const index = list.indexOf(item);
    closeSheet(true, () => {
      rowOf(item)?.classList.add("gone");
      setTimeout(() => {
        items = items.filter((other) => other !== item);
        order = order.filter((key) => key !== item.key);
        renderList();
        const rest = ordered();
        const next = rest[Math.min(index, rest.length - 1)];
        (next ? rowOf(next)?.querySelector("[data-edit]") : listEl.querySelector(".dash-empty a"))?.focus();
        toast(t("dashboard.delete_success", { domain: item.key }));
      }, reduced() ? 0 : 200);
    });
  }

  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) return closeSheet(); // the backdrop
    const hit = (selector) => event.target.closest(selector);
    if (hit("[data-close]")) return closeSheet();
    if (hit("[data-save]")) return save();
    if (hit("[data-renew]")) return renew(current, hit("[data-renew]"), "sheet");
    if (hit("[data-recheck]")) return recheck();
    if (hit("[data-retype]")) {
      draft.showTypes = !draft.showTypes;
      drawSheet();
      return;
    }
    if (hit("[data-type]")) {
      const next = hit("[data-type]").dataset.type;
      if (next === draft.type) return;
      // The TXT box follows the name it writes to: what was typed for the old
      // name is kept for it, the other name starts from what we know of it.
      draft.txtBySlot[txtSlot(draft.type)] = draft.txt;
      draft.type = next;
      draft.txt = draft.txtBySlot[txtSlot(next)] ?? "";
      draft.err = next === "CNAME" && current.type !== "CNAME" && current.txt ? t("dashboard.txt_blocks_cname") : null;
      drawSheet();
      document.getElementById("sheet-value")?.focus();
      return;
    }
    if (hit("[data-ask-delete]")) {
      mode = "delete";
      drawSheet();
      sheet.querySelector("[data-keep]")?.focus();
      sheet.querySelector(".confirm")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (hit("[data-keep]")) {
      mode = "edit";
      drawSheet();
      sheet.querySelector("[data-ask-delete]")?.focus();
      return;
    }
    if (hit("[data-delete]")) return remove(hit("[data-delete]"));
    if (hit("[data-stay]")) {
      mode = "edit";
      drawSheet();
      return;
    }
    if (hit("[data-discard]")) return closeSheet(true);
    if (hit("[data-relogin]")) {
      return relogin({ key: current.key, draft: { value: draft.value, txt: draft.txt, type: draft.type } });
    }
  });

  sheet.addEventListener("input", (event) => {
    if (!draft) return;
    if (event.target.id === "sheet-value") {
      draft.value = event.target.value;
      if (draft.err) {
        draft.err = null;
        event.target.classList.remove("bad");
        event.target.removeAttribute("aria-invalid");
        sheet.querySelector(".err")?.remove();
      }
    }
    if (event.target.id === "sheet-txt") {
      draft.txt = event.target.value;
      grow(event.target);
    }
    const saveButton = foot.querySelector("[data-save]");
    if (saveButton) saveButton.disabled = !dirty() || draft.saving;
  });

  sheet.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("input") && dirty()) {
      event.preventDefault();
      save();
    }
  });
  sheet.addEventListener("toggle", (event) => {
    if (event.target.matches("details")) grow(document.getElementById("sheet-txt"));
  }, true);
  sheet.addEventListener("cancel", (event) => {
    event.preventDefault(); // Esc — through the same «unsaved changes» question
    closeSheet();
  });

  // Phone sheet: the height follows the visible viewport when the keyboard
  // comes up; dragging the handle down past 80px and letting go closes it.
  function fitViewport() {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty("--vvh", `${viewport ? viewport.height : window.innerHeight}px`);
  }
  window.visualViewport?.addEventListener("resize", fitViewport);
  sheet.addEventListener("focusin", (event) => {
    if (phone() && event.target.matches("input, textarea")) {
      setTimeout(() => event.target.scrollIntoView({ block: "center" }), 250);
    }
  });
  const grabber = sheet.querySelector(".grab");
  let startY = null;
  grabber.addEventListener("pointerdown", (event) => {
    startY = event.clientY;
    grabber.setPointerCapture(event.pointerId);
    sheet.style.transition = "none";
  });
  grabber.addEventListener("pointermove", (event) => {
    if (startY === null) return;
    sheet.style.transform = `translateY(${Math.max(0, event.clientY - startY)}px)`;
  });
  grabber.addEventListener("pointerup", (event) => {
    const moved = event.clientY - (startY ?? event.clientY);
    startY = null;
    sheet.style.transition = "transform 0.2s var(--h-ease)";
    if (moved > 80 && closeSheet() !== false) return;
    sheet.style.transform = "";
  });
  sheet.addEventListener("close", () => {
    sheet.style.transform = "";
    sheet.style.transition = "";
  });

  load();
}
