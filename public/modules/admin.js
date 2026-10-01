// /admin — read-only numbers. The server only sends this page to ADMIN_EMAILS
// (routes/admin.js) and the API below answers everyone else with a 404, so a
// failed fetch here is drawn as "not found" and nothing more.
//
// Korean only: one reader, and the page is not part of the service.
// Every value that came from a user (names, targets) goes in as textContent.

const SEOUL = "Asia/Seoul";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const fmtNum = (n) => Number(n || 0).toLocaleString("ko-KR");

function fmtTime(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: SEOUL,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: SEOUL,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function section(title, note) {
  const box = el("section", "admin-section");
  const head = el("div", "admin-section-head");
  head.appendChild(el("h2", null, title));
  if (note) head.appendChild(el("span", "admin-note", note));
  box.appendChild(head);
  return box;
}

function tile(label, value, sub) {
  const box = el("div", "admin-tile");
  box.appendChild(el("p", "admin-tile-label", label));
  box.appendChild(el("p", "admin-tile-value", value));
  if (sub) box.appendChild(el("p", "admin-tile-sub", sub));
  return box;
}

/** One line of a list: the name, then small facts that wrap under it on a phone. */
function row(name, facts, tone) {
  const line = el("div", `admin-row${tone ? ` ${tone}` : ""}`);
  line.appendChild(el("span", "admin-row-name mono", name));
  const meta = el("span", "admin-row-meta");
  for (const fact of facts) {
    if (fact === null || fact === undefined || fact === "") continue;
    meta.appendChild(el("span", null, fact));
  }
  line.appendChild(meta);
  return line;
}

function list(items, toRow, empty) {
  const box = el("div", "admin-list");
  if (!items.length) {
    box.appendChild(el("p", "admin-empty", empty));
    return box;
  }
  items.forEach((item) => box.appendChild(toRow(item)));
  return box;
}

const SVG = "http://www.w3.org/2000/svg";

/** Two lines over 30 days. Inline SVG, stroke colours from the CSS tokens. */
function trendChart(daily) {
  const W = 600;
  const H = 160;
  const PAD = 8;
  const max = Math.max(1, ...daily.map((d) => Math.max(d.people, d.accountless)));
  const x = (i) => PAD + (i * (W - PAD * 2)) / Math.max(1, daily.length - 1);
  const y = (v) => H - PAD - (v / max) * (H - PAD * 2);

  const wrap = el("div", "admin-chart");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  const people = daily.reduce((n, d) => n + d.people, 0);
  const accountless = daily.reduce((n, d) => n + d.accountless, 0);
  svg.setAttribute("aria-label", `30일 생성: 사람 ${people}, 계정 없음 ${accountless}`);

  for (const v of [0, max]) {
    const grid = document.createElementNS(SVG, "line");
    grid.setAttribute("x1", 0);
    grid.setAttribute("x2", W);
    grid.setAttribute("y1", y(v));
    grid.setAttribute("y2", y(v));
    grid.setAttribute("class", "admin-chart-grid");
    svg.appendChild(grid);
  }

  for (const [key, cls] of [
    ["accountless", "admin-line-anon"],
    ["people", "admin-line-people"],
  ]) {
    const line = document.createElementNS(SVG, "polyline");
    line.setAttribute("points", daily.map((d, i) => `${x(i)},${y(d[key])}`).join(" "));
    line.setAttribute("class", cls);
    svg.appendChild(line);
  }
  wrap.appendChild(svg);

  const axis = el("div", "admin-chart-axis");
  axis.appendChild(el("span", null, daily[0]?.day.slice(5)));
  axis.appendChild(el("span", null, `최대 ${max}/일`));
  axis.appendChild(el("span", null, daily[daily.length - 1]?.day.slice(5)));
  wrap.appendChild(axis);

  const legend = el("div", "admin-legend");
  const key = (cls, label, n) => {
    const item = el("span");
    item.appendChild(el("i", cls));
    item.appendChild(document.createTextNode(`${label} ${fmtNum(n)}`));
    return item;
  };
  legend.appendChild(key("admin-key-people", "사람", people));
  legend.appendChild(key("admin-key-anon", "계정 없음", accountless));
  wrap.appendChild(legend);
  return wrap;
}

function typeBars(types) {
  const total = types.reduce((n, t) => n + t.count, 0) || 1;
  const box = el("div", "admin-bars");
  for (const t of types) {
    const line = el("div", "admin-bar");
    line.appendChild(el("span", "admin-bar-label mono", t.type));
    const track = el("span", "admin-bar-track");
    const fill = el("i");
    fill.style.width = `${(t.count / total) * 100}%`;
    track.appendChild(fill);
    line.appendChild(track);
    line.appendChild(el("span", "admin-bar-value", `${fmtNum(t.count)} · ${Math.round((t.count / total) * 100)}%`));
    box.appendChild(line);
  }
  return box;
}

function render(root, s) {
  const meta = root.querySelector("#admin-meta");
  meta.textContent = `${fmtTime(s.generatedAt)} 기준 (서울) · 읽기 전용`;

  const sum = s.summary;
  const tiles = el("div", "admin-tiles");
  tiles.appendChild(tile("가입자", fmtNum(sum.users.total), `30일 +${fmtNum(sum.users.last30)}`));
  tiles.appendChild(
    tile("주소", fmtNum(sum.subdomains.total), `30일 +${fmtNum(sum.subdomains.last30)} · 7일 +${fmtNum(sum.subdomains.last7)}`)
  );
  tiles.appendChild(
    tile(
      "계정 없이 생성",
      fmtNum(sum.subdomains.accountless),
      `7일 +${fmtNum(sum.subdomains.accountlessLast7)} · 30일 +${fmtNum(sum.subdomains.accountlessLast30)}`
    )
  );
  tiles.appendChild(
    tile(
      "갱신 메일 대상",
      fmtNum(s.renewal.count),
      s.renewal.earliestNoticeAt ? `가장 이른 발송 ${fmtDate(s.renewal.earliestNoticeAt)}` : "보낼 메일 없음"
    )
  );
  root.appendChild(tiles);

  const trend = section("일별 생성 · 30일");
  trend.appendChild(trendChart(s.daily));
  root.appendChild(trend);

  const types = section("레코드 종류", `API 키 ${fmtNum(sum.apiKeys)} · TXT ${fmtNum(sum.txtRecords)}`);
  types.appendChild(typeBars(s.recordTypes));
  root.appendChild(types);

  const r = s.renewal;
  const renewal = section(
    `만료 ${r.windowDays}일 내 · 갱신 메일 대상 ${fmtNum(r.count)}`,
    r.earliestNoticeAt ? `가장 이른 발송 ${fmtDate(r.earliestNoticeAt)}` : null
  );
  if (!r.remindersEnabled) {
    renewal.appendChild(el("p", "admin-callout", "⚠ 갱신 메일이 꺼져 있다(RENEWAL_REMINDERS_ENABLED) — 날짜가 와도 안 나간다."));
  }
  if (r.accountlessInWindow) {
    renewal.appendChild(
      el("p", "admin-callout is-info", `계정 없는 주소 ${fmtNum(r.accountlessInWindow)}개도 이 안에 만료되지만 메일 대상이 아니다(받을 주소가 없다).`)
    );
  }
  renewal.appendChild(
    list(
      r.items,
      (item) =>
        row(
          item.name,
          [
            item.daysLeft < 0 ? `${-item.daysLeft}일 지남` : `${item.daysLeft}일 남음`,
            fmtDate(item.expiresAt),
            item.sentStage === null ? "아직 안 보냄" : `${item.sentStage}일 안내 보냄`,
            item.email,
          ],
          item.daysLeft <= 3 ? "is-bad" : null
        ),
      "14일 안에 만료되는 계정 주소가 없다."
    )
  );
  root.appendChild(renewal);

  const un = section(`도달 안 되는 주소 ${fmtNum(s.unreachable.count)}`);
  un.appendChild(
    list(
      s.unreachable.items,
      (item) =>
        row(item.name, [
          `${item.type} → ${item.value}`,
          `경고 ${item.warningCount}회`,
          item.notifiedAt ? `안내 ${fmtDate(item.notifiedAt)}` : null,
          item.accountless ? "계정 없음" : null,
        ]),
      "없다."
    )
  );
  root.appendChild(un);

  const hits = section("리다이렉트 클릭 상위 10");
  hits.appendChild(
    list(
      s.topRedirects,
      (item) => row(item.name, [`${fmtNum(item.hits)}회`, `→ ${item.target}`, `마지막 ${fmtTime(item.lastHitAt)}`]),
      "아직 기록된 클릭이 없다."
    )
  );
  root.appendChild(hits);

  const recent = section("최근 생성 20");
  recent.appendChild(
    list(
      s.recent,
      (item) =>
        row(item.name, [item.type, item.accountless ? "계정 없음" : "사람", fmtTime(item.createdAt)]),
      "없다."
    )
  );
  root.appendChild(recent);

  root.classList.add("admin-ready");
}

export async function initializeAdminPage() {
  const root = document.getElementById("admin-root");
  if (!root) return;
  try {
    const response = await fetch("/admin/api/stats", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(String(response.status));
    render(root, await response.json());
  } catch {
    root.querySelector("#admin-meta").textContent = "Not found.";
  }
}
