import { apiFetch, getCurrentUser } from "./api.js";
import { navigateTo } from "./router.js";
import { showMessage, setButtonLoading, clearButtonLoading, resetMessage } from "./ui.js";
import { validateRecordValue } from "./util.js";
import { SUBDOMAIN_REGEX, IPV4_REGEX, RECORD_TYPE_UI } from "./constants.js";
import { savePendingClaim, takeHeldClaim } from "./pending-claim.js";
import { t } from "./i18n.js";

// 350ms — 한 글자 칠 때마다 묻지 않을 만큼 길고, 멈췄다는 걸 사람이 느끼기
// 전에 답이 오는 길이다.
const SEARCH_DEBOUNCE_MS = 350;

// «이미 씀» 아래 추천은 덤이다. 이보다 늦으면 칩 없이 끝낸다 — 늦게 튀어나온
// 칩이 다른 이름을 치고 있는 사람의 손 밑으로 들어오면 안 된다.
const SUGGEST_TIMEOUT_MS = 2500;

// /api/managed-domains 가 답하기 전, 또는 답을 못 받았을 때의 꼬리.
const FALLBACK_DOMAIN = "sitey.my";

// style.css 의 폰 구간과 같은 수다.
const PHONE = "(max-width: 720px)";

// 주소 글자 크기의 범위 (px). 화면 폭에 맞춰 이 안에서 고른다.
// floor 는 이름 «하나만으로» 한 줄을 넘을 때만 쓴다(데스크톱 45자·폰 18자 남짓부터).
// 글자가 작아지는 것보다 이름 앞이 잘려 안 보이는 쪽이 더 나쁘다.
const SIZE = { desk: [64, 152], phone: [34, 76] };
const FLOOR = { desk: 40, phone: 22 };

const HANGUL = /[ㄱ-ㅎㅏ-ㅣ가-힣]/;

/**
 * Where the site lives. The chip decides the record type and what the value
 * box offers; the value is checked by the same validateRecordValue the server
 * mirrors.
 *
 * Lovable: nothing in this repository says how Lovable connects, and its own
 * documentation (docs.lovable.dev/features/custom-domain, read 2026-11-10)
 * hands out an IP for an A record, or a lovable.app name for a CNAME behind a
 * proxy. Rather than guess one, the box takes «the value Lovable gives you»
 * and the type follows what was pasted: an IPv4 is an A record, anything else
 * a CNAME.
 */
const HOSTS = [
  { id: "vercel", name: "Vercel", type: "CNAME", preset: "cname.vercel-dns.com", hint: "home.hint.vercel", where: "home.agent.where.vercel" },
  { id: "netlify", name: "Netlify", type: "CNAME", example: "home.example.netlify", where: "home.agent.where.netlify" },
  { id: "github", name: "GitHub Pages", type: "CNAME", example: "home.example.github", where: "home.agent.where.github" },
  { id: "lovable", name: "Lovable", type: "A", either: true, example: "home.example.lovable", hint: "home.hint.lovable", where: "home.agent.where.lovable" },
  { id: "server", label: "home.host.server", type: "A", where: "home.agent.where.server" },
  { id: "redirect", label: "home.host.redirect", type: "REDIRECT", where: "home.agent.where.redirect" },
];

const hostById = (id) => HOSTS.find((host) => host.id === id) || null;
const hostName = (host) => (host.label ? t(host.label) : host.name);

// The box's label is the record's own word where it has one.
function fieldLabel(host) {
  if (host.either) return t("home.field.value");
  return { A: "IP", CNAME: "CNAME", REDIRECT: "URL" }[host.type];
}

function fieldPlaceholder(host) {
  if (host.example) return t(host.example);
  return RECORD_TYPE_UI[host.type].placeholder.replace(/^e\.g\. /, "");
}

/** createElement with attributes and children; text is always text, never HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** One sentence: what happened in bold, what to do in plain. */
function say(lead, rest, { bad = false } = {}) {
  const line = el("p", { class: bad ? "say bad" : "say" });
  if (lead) line.append(el("strong", {}, lead));
  if (lead && rest) line.append(" ");
  if (rest) line.append(rest);
  return line;
}

/** Candidates for a taken name: name-site, name-<year>, my-name. */
function suggestionsFor(name) {
  const base = name.replace(/-?\d+$/, "") || name;
  const year = new Date().getFullYear();
  return [`${base}-site`, `${base}-${year}`, `my-${base}`].filter(
    (candidate, i, all) =>
      candidate !== name &&
      candidate.length <= 63 &&
      SUBDOMAIN_REGEX.test(candidate) &&
      all.indexOf(candidate) === i
  );
}

// Listeners on window/document belong to one rendering of the page. The router
// builds the home page again on every visit, so the previous set is dropped
// first instead of piling up.
let pageListeners = null;

export function initializeLandingPage() {
  resetMessage();

  const home = document.getElementById("home");
  const hero = document.getElementById("home-hero");
  const addr = document.getElementById("addr");
  const input = document.getElementById("subdomain");
  const tld = document.getElementById("addr-tld");
  const openLink = document.getElementById("addr-open");
  const status = document.getElementById("home-status");
  const prompt = document.getElementById("agent-prompt");
  if (!home || !hero || !addr || !input || !tld || !openLink || !status || !prompt) return;

  const mirror = addr.querySelector(".mirror");
  const tail = addr.querySelector(".tail");

  pageListeners?.abort();
  pageListeners = new AbortController();
  const { signal } = pageListeners;

  /* ============================================
     What is on screen

     The address is the input: `name` + `.` + `domain`. The dot between them is
     the light — idle (ink), checking (grey), free (blue), taken or invalid
     (red), error (grey, with the words), made (blue).

     🔴 A row without a verdict (`error: "zone_unavailable"`) is "we could not
     tell", never "taken": telling somebody a free name is gone is the one
     thing this screen must not do.
     ============================================ */

  let state = "idle";
  let domain = FALLBACK_DOMAIN; // the tail after the dot
  let domains = []; // what /api/managed-domains handed out
  let results = null; // the last answer, one row per domain
  let checkedName = ""; // the name `results` is about
  let hostId = null; // the chip
  let draft = ""; // what is in the value box — kept across redraws
  let made = null; // { name, domain, value } once created
  let domainChosen = false; // the tail was picked by hand (or by a claim)
  let view = ""; // which layout the status area holds
  let searchTimer = null;
  let latestRequest = 0;

  function setState(next) {
    state = next;
    addr.dataset.state = next;
    syncPrompt();
  }

  function setDomain(next) {
    domain = next;
    tld.textContent = next;
    fit();
    syncPrompt();
  }

  /* ---------- The size of the address ----------
     As large as the line allows, between SIZE's two ends. A name too long for
     one line at the smallest size puts the tail on a second line; on a phone
     the tail always has its own line. */
  function fit() {
    const phone = window.matchMedia(PHONE).matches;
    const [min, max] = phone ? SIZE.phone : SIZE.desk;
    const floor = phone ? FLOOR.phone : FLOOR.desk;
    const text = input.value || input.placeholder;
    const style = getComputedStyle(hero);
    const avail = hero.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);

    addr.classList.remove("wrap");
    addr.style.setProperty("--size", `${max}px`);
    mirror.textContent = text;
    const nameWidth = mirror.getBoundingClientRect().width;
    const tailWidth = tail.getBoundingClientRect().width;

    let size;
    if (phone) {
      size = Math.floor((max * avail) / (Math.max(nameWidth, tailWidth) + 8));
    } else {
      size = Math.floor((max * avail) / (nameWidth + tailWidth + 8));
      if (size < min) {
        addr.classList.add("wrap");
        size = Math.floor((max * avail) / (Math.max(nameWidth, tailWidth) + 8));
      }
    }
    // Below the range only when the name alone is wider than the line.
    const nameFits = Math.floor((max * avail) / (nameWidth + 8));
    size = Math.max(Math.min(min, Math.max(floor, nameFits)), Math.min(max, size));
    addr.style.setProperty("--size", `${size}px`);
    input.style.width = `${Math.ceil(mirror.getBoundingClientRect().width + 2)}px`;
  }

  /* ---------- The status area ---------- */

  function render(nodes, nextView) {
    view = nextView;
    status.classList.remove("enter");
    status.replaceChildren(...nodes.filter(Boolean));
    // Restarting the animation needs a reflow between the two class changes.
    void status.offsetWidth;
    status.classList.add("enter");
    if (home.classList.contains("typing")) status.scrollIntoView({ block: "nearest" });
  }

  function drawIdle() {
    setState("idle");
    render([say(null, t("home.say.idle"))], "idle");
  }

  function drawInvalid(lead, rest) {
    setState("invalid");
    render([say(lead, rest, { bad: true })], "invalid");
  }

  function drawError() {
    setState("error");
    const line = say(null, t("home.say.error"));
    line.append(" ", el("button", { type: "button", class: "textbtn retry" }, t("home.say.retry")));
    render([line], "error");
  }

  /** The quiet line under the verdict: the same name under the other roots. */
  function othersLine() {
    const others = (results || []).filter((row) => row.domain !== domain);
    if (!others.length) return null;
    const line = el("p", { class: "others" }, t("home.others"));
    others.forEach((row, i) => {
      const key =
        row.isAvailable === true
          ? "home.others.free"
          : row.isAvailable === false
            ? "home.others.taken"
            : "home.others.unknown";
      if (i) line.append(el("span", { class: "sep", "aria-hidden": "true" }, "·"));
      line.append(
        " ",
        el(
          "button",
          {
            type: "button",
            class: "textbtn other",
            "data-domain": row.domain,
            "aria-label": `${t(key, { domain: row.domain })} — ${t("home.others.use", { domain: row.domain })}`,
          },
          t(key, { domain: row.domain })
        )
      );
    });
    return line;
  }

  function hostChips() {
    const group = el("div", { class: "hosts", role: "group", "aria-label": t("home.hosts_label") });
    for (const host of HOSTS) {
      group.append(
        el(
          "button",
          { type: "button", class: "chip host", "data-host": host.id, "aria-pressed": String(host.id === hostId) },
          hostName(host)
        )
      );
    }
    return group;
  }

  /** The value box and the one button, for the chosen chip. */
  function connectRow() {
    const host = hostById(hostId);
    if (!host) return null;
    const signedIn = Boolean(getCurrentUser());

    const value = el("input", {
      type: "text",
      id: "home-value",
      autocomplete: "off",
      autocapitalize: "none",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: "go",
      inputmode: RECORD_TYPE_UI[host.type].inputMode,
      placeholder: fieldPlaceholder(host),
    });
    value.value = draft;

    const go = el(
      "button",
      { type: "button", class: "go", id: "home-go", disabled: !draft.trim() },
      signedIn ? t("home.create") : t("home.continue_google")
    );

    const row = el(
      "div",
      { class: "connect" },
      el("div", { class: "field" }, el("label", { for: "home-value" }, fieldLabel(host)), value),
      go,
      host.hint ? el("span", { class: "hint" }, t(host.hint)) : null
    );
    const wrap = el("div", { class: "connect-wrap" }, row, el("p", { class: "err", role: "alert", hidden: true }));
    return wrap;
  }

  function drawFree() {
    setState("free");
    // Same layout already up (another free name, or a domain switch): swap
    // the line that changed and leave the chips and the value box alone —
    // redrawing them would drop what was typed and replay the entrance.
    if (view === "free") {
      const old = status.querySelector(".others");
      const next = othersLine();
      if (old && next) old.replaceWith(next);
      else if (old) old.remove();
      else if (next) status.querySelector(".say")?.after(next);
      return;
    }
    render(
      [say(t("home.say.free"), t("home.say.free_ask")), othersLine(), hostChips(), connectRow()],
      "free"
    );
  }

  function drawTaken() {
    setState("taken");
    const line = say(t("home.say.taken"), null, { bad: true });
    render([line, othersLine()], "taken");
    offerSuggestions(checkedName, domain, line);
  }

  /** The verdict for the name under the current tail. */
  function drawVerdict() {
    let row = results.find((r) => r.domain === domain);
    if (!row) {
      // The tail is not one the server answered for (the list changed under
      // us). Show the first one it did answer for rather than nothing.
      row = results[0];
      setDomain(row.domain);
    }
    if (row.isAvailable === true) drawFree();
    else if (row.isAvailable === false) drawTaken();
    else drawError();
  }

  /**
   * Up to three free names like the taken one, each asked of the server —
   * a suggestion nobody checked could be taken too. Late or failed: nothing.
   */
  async function offerSuggestions(name, root, line) {
    const candidates = suggestionsFor(name);
    if (!candidates.length) return;

    const ask = Promise.all(
      candidates.map((candidate) =>
        apiFetch("/api/check-availability", { method: "POST", body: { subdomain: candidate } })
          .then((data) => {
            const row = (data?.results || []).find((r) => r.domain === root);
            return row?.isAvailable === true ? candidate : null;
          })
          .catch(() => null)
      )
    );
    const late = new Promise((resolve) => setTimeout(() => resolve(null), SUGGEST_TIMEOUT_MS));
    const answer = await Promise.race([ask, late]);

    // Still the same question on screen?
    if (!answer || state !== "taken" || checkedName !== name || domain !== root || !line.isConnected) return;
    const free = answer.filter(Boolean);
    if (!free.length) return;

    line.append(" ", t("home.say.taken_more"));
    const chips = el("div", { class: "suggest" });
    free.forEach((candidate) =>
      chips.append(el("button", { type: "button", class: "chip pick", "data-name": candidate }, candidate))
    );
    line.after(chips);
  }

  function drawMade(name, root, value) {
    made = { name, domain: root, value };
    input.readOnly = true;
    input.blur();
    home.classList.remove("typing");
    openLink.href = `https://${name}.${root}`;
    openLink.setAttribute("aria-label", t("home.open", { name: `${name}.${root}` }));
    openLink.hidden = false;
    setState("made");
    fit();
    addr.classList.remove("lit");
    void addr.offsetWidth;
    addr.classList.add("lit");

    render(
      [
        say(t("home.say.made"), t("home.say.made_more")),
        el("p", { class: "made-to" }, `→ ${value}`),
        el(
          "p",
          { class: "made-links" },
          el("button", { type: "button", class: "textbtn again" }, t("home.again")),
          el("a", { href: "/dashboard" }, t("home.manage"))
        ),
      ],
      "made"
    );
  }

  function startOver() {
    made = null;
    input.readOnly = false;
    input.value = "";
    openLink.hidden = true;
    hostId = null;
    draft = "";
    results = null;
    checkedName = "";
    fit();
    drawIdle();
    input.focus();
  }

  /* ---------- The agent's sentence ----------
     It follows the typed name only while that name is one you could have —
     free, being checked, or just made. Otherwise it says myapp. */
  function syncPrompt() {
    const live = state === "free" || state === "checking" || state === "made";
    const name = made ? made.name : live && input.value ? input.value : "myapp";
    const root = made ? made.domain : domain;
    const host = hostById(hostId);
    const where = t(host ? host.where : "home.agent.where.default");

    const [before, after = ""] = t("home.agent.prompt").split("{name}");
    prompt.replaceChildren(
      before,
      el("span", { class: "sync" }, name),
      `.${root}`,
      after.replace("{where}", where)
    );
  }

  /* ============================================
     The search

     One request answers the whole list: POST /api/check-availability takes a
     name and returns a row per managed domain. Switching the tail re-reads
     the answer we already have instead of asking again.
     ============================================ */

  /**
   * Ask, and draw the answer.
   *
   * @returns the rows, or null when nothing was drawn from them — a stale
   *   answer, an error, an empty list. The caller resuming a claim needs the
   *   difference: "we could not ask" must not be reported as "somebody took it".
   */
  async function runSearch(name) {
    // Debounced requests can land out of order — a slow answer for "ja" must
    // not overwrite a fresh one for "jay". Only the newest token may draw.
    const token = ++latestRequest;
    clearTimeout(searchTimer);
    searchTimer = null;
    setState("checking");

    try {
      const data = await apiFetch("/api/check-availability", {
        method: "POST",
        body: { subdomain: name },
      });
      if (token !== latestRequest) return null;
      const rows = Array.isArray(data?.results) ? data.results : [];
      if (!rows.length) {
        drawError();
        return null;
      }
      results = rows;
      checkedName = name;
      drawVerdict();
      return rows;
    } catch {
      if (token !== latestRequest) return null;
      drawError();
      return null;
    }
  }

  /** Every change to the name comes through here, after IME composition ends. */
  function onName() {
    if (made) return;
    const raw = input.value;
    const name = raw.toLowerCase().replace(/\s+/g, "");
    if (name !== raw) input.value = name;
    fit();

    clearTimeout(searchTimer);
    searchTimer = null;
    latestRequest += 1; // drop anything still in flight

    if (!name) {
      results = null;
      drawIdle();
      return;
    }
    // Korean is said at once — it is a different keyboard, not a typo.
    if (HANGUL.test(name)) {
      drawInvalid(t("home.say.hangul"), t("home.say.hangul_more"));
      return;
    }
    // Everything else waits like a search would: "my-" on the way to "my-app"
    // is not worth a red light.
    setState("checking");
    searchTimer = setTimeout(() => {
      searchTimer = null;
      if (!SUBDOMAIN_REGEX.test(name)) {
        drawInvalid(t("home.say.bad"), t("home.say.bad_more"));
        return;
      }
      runSearch(name);
    }, SEARCH_DEBOUNCE_MS);
  }

  input.addEventListener("input", (event) => {
    if (!event.isComposing) onName();
  });
  input.addEventListener("compositionend", () => onName());

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (made) {
      window.open(openLink.href, "_blank", "noopener");
      return;
    }
    // Enter skips the wait.
    if (searchTimer) {
      const name = input.value;
      if (SUBDOMAIN_REGEX.test(name)) runSearch(name);
      else onName();
      return;
    }
    if (state === "free") {
      (status.querySelector("#home-value") || status.querySelector(".chip"))?.focus();
    }
  });

  /* ---------- Creating ---------- */

  async function create(go) {
    const name = input.value;
    const host = hostById(hostId);
    const value = status.querySelector("#home-value");
    const error = status.querySelector(".err");
    // The chips on screen can belong to the name before the last keystroke.
    if (!host || !value || state !== "free" || checkedName !== name) return;

    const raw = value.value.trim();
    const recordType = host.either ? (IPV4_REGEX.test(raw) ? "A" : "CNAME") : host.type;
    const check = validateRecordValue(recordType, raw, { subdomain: name, domain });
    if (!check.valid) {
      showError(error, check.message);
      value.focus();
      return;
    }

    // A person creates with an account. The name, the chip and the value are
    // put down for the way back (public/modules/pending-claim.js) — coming
    // back is one more press, never an automatic create.
    if (!getCurrentUser()) {
      savePendingClaim(name, domain, { host: host.id, recordType, value: raw });
      navigateTo("/login");
      return;
    }

    setButtonLoading(go, t("home.creating"));
    try {
      await apiFetch("/api/subdomains", {
        method: "POST",
        body: { subdomain: name, domain, recordType, value: check.value },
      });
      results = results.map((row) => (row.domain === domain ? { ...row, isAvailable: false } : row));
      drawMade(name, domain, check.value);
    } catch (failure) {
      clearButtonLoading(go);
      showError(error, failure.message);
    }
  }

  function showError(line, message) {
    if (!line) return;
    line.textContent = message;
    line.hidden = false;
  }

  /* ---------- Clicks inside the status area ---------- */

  status.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;

    if (button.classList.contains("retry")) {
      runSearch(input.value);
      return;
    }
    if (button.classList.contains("again")) {
      startOver();
      return;
    }
    if (button.classList.contains("pick")) {
      input.value = button.dataset.name;
      onName();
      if (!window.matchMedia(PHONE).matches) input.focus();
      return;
    }
    if (button.classList.contains("other")) {
      domainChosen = true;
      setDomain(button.dataset.domain);
      drawVerdict();
      // Keep a keyboard user where they were: on the line they just used.
      status.querySelector(".others button")?.focus();
      return;
    }
    if (button.classList.contains("host")) {
      if (hostId !== button.dataset.host) {
        hostId = button.dataset.host;
        draft = hostById(hostId).preset || "";
      }
      status.querySelectorAll(".host").forEach((chip) => {
        chip.setAttribute("aria-pressed", String(chip === button));
      });
      const next = connectRow();
      const old = status.querySelector(".connect-wrap");
      if (old) old.replaceWith(next);
      else status.append(next);
      syncPrompt();
      if (!draft) status.querySelector("#home-value")?.focus();
      return;
    }
    if (button.id === "home-go") {
      create(button);
    }
  });

  status.addEventListener("input", (event) => {
    if (event.target.id !== "home-value") return;
    draft = event.target.value;
    const go = status.querySelector("#home-go");
    if (go) go.disabled = !draft.trim();
    const error = status.querySelector(".err");
    if (error) error.hidden = true;
  });

  status.addEventListener("keydown", (event) => {
    if (event.target.id !== "home-value" || event.key !== "Enter" || event.isComposing) return;
    const go = status.querySelector("#home-go");
    if (go && !go.disabled) go.click();
  });

  // Made: the whole address opens the site, not just the arrow.
  addr.addEventListener("click", (event) => {
    if (!made || event.target.closest(".go-out")) return;
    event.preventDefault();
    window.open(openLink.href, "_blank", "noopener");
  });

  /* ---------- Phone: keep the work above the keyboard ----------
     While the name is being typed the sentence above it and the band below
     fold away, so the verdict, the chips, the box and the button stay in view.
     They come back on a tap anywhere but the address and what is under it
     (the empty part of the screen counts as outside). Not on blur: iOS does not
     focus a tapped button, so a blur-based rule would unfold the page between
     the finger going down on a chip and the click landing — on whatever had
     moved under it. */
  input.addEventListener("focus", () => {
    if (window.matchMedia(PHONE).matches && !made) home.classList.add("typing");
  });
  const unfoldOutside = (event) => {
    if (!addr.contains(event.target) && !status.contains(event.target)) home.classList.remove("typing");
  };
  document.addEventListener("pointerdown", unfoldOutside, { signal });
  document.addEventListener("focusin", unfoldOutside, { signal });

  window.addEventListener("resize", fit, { signal });
  document.fonts?.ready.then(() => {
    if (!signal.aborted) fit();
  });

  wireAgentCopy();

  /* ---------- Which roots ---------- */

  const domainsReady = loadDomains().then((list) => {
    domains = list;
    if (signal.aborted || made || domainChosen) return;
    // The first root the server lists is the default tail.
    if (list.length && list[0] !== domain) {
      setDomain(list[0]);
      if (results) drawVerdict();
    }
  });

  fit();
  syncPrompt();

  /* ============================================
     Arriving, and arriving back

     ?check= fills the box — the blog's domain chips hand a name over that way
     and so does script.js after a sign-in, which is why the address is worth
     writing to: a reload shows the same search rather than an empty page.

     A held claim is the second case only. It carries what the address does
     not — which root, which chip, what value — and it asks about the name
     again: signing in takes long enough for somebody else to have taken it.
     It never creates by itself; it leaves one press of «Create».
     ============================================ */

  const claim = takeHeldClaim();
  const prefill = new URLSearchParams(window.location.search).get("check");

  if (claim) {
    resumeClaim(claim);
  } else {
    if (prefill && SUBDOMAIN_REGEX.test(prefill)) {
      input.value = prefill;
      fit();
      runSearch(prefill);
    }
    // A desktop visitor can start typing at once. A phone is not handed a
    // keyboard it did not ask for.
    if (window.matchMedia("(pointer: fine)").matches) input.focus({ preventScroll: true });
  }

  async function resumeClaim({ subdomain, domain: root, host, value }) {
    input.value = subdomain;
    fit();
    await domainsReady;

    // The stored root has to still be one we hand out. If it is not, the claim
    // cannot be honoured and there is nothing useful to say about it — the
    // dashboard is where this sign-in was going before we interfered.
    if (!domains.includes(root)) {
      navigateTo("/dashboard");
      return;
    }
    domainChosen = true;
    setDomain(root);
    if (hostById(host)) {
      hostId = host;
      draft = value || hostById(host).preset || "";
    }

    const rows = await runSearch(subdomain);
    // Null means the question did not get answered; the status line says so
    // already, and inventing a verdict on top of it would be worse than quiet.
    if (!rows) return;

    const row = rows.find((r) => r.domain === root);
    if (row?.isAvailable === true) {
      const go = status.querySelector("#home-go");
      if (go && !go.disabled) go.focus({ preventScroll: true });
      else (status.querySelector("#home-value") || status.querySelector(".chip"))?.focus({ preventScroll: true });
      return;
    }

    // Taken while they were away, or a zone we could not read just now. The
    // status line says which of the two; this says why there is no button.
    showMessage(t("home.claim_unavailable", { name: `${subdomain}.${root}` }), "error");
  }
}

/** The copy button beside the prompt an agent user pastes. */
function wireAgentCopy() {
  const button = document.getElementById("agent-copy");
  const prompt = document.getElementById("agent-prompt");
  if (!button || !prompt) return;

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(prompt.textContent.trim());
    } catch {
      // No clipboard (an http page, an old browser): select the text so a
      // long-press or Ctrl+C finishes the job, and say nothing false.
      const range = document.createRange();
      range.selectNodeContents(prompt);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    button.textContent = t("home.agent.copied");
    button.dataset.done = "";
    setTimeout(() => {
      button.textContent = t("home.agent.copy");
      delete button.dataset.done;
    }, 1600);
  });
}

/**
 * The roots we hand out, straight from the server — the list is a database
 * table, not a constant, and a hard-coded copy here would go stale the day a
 * new one is added. An empty list on failure: the tail stays sitey.my and the
 * search still answers for every root.
 */
async function loadDomains() {
  try {
    const data = await apiFetch("/api/managed-domains");
    return Array.isArray(data?.domains) ? data.domains.filter((d) => typeof d === "string" && d) : [];
  } catch {
    return [];
  }
}
