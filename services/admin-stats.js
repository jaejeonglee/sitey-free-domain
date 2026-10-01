// services/admin-stats.js — the numbers behind /admin. Read-only: nothing here
// writes, deletes or sends.
//
// Days are Seoul days (kstDay), computed here rather than with DATE() in SQL:
// the database's clock is UTC and a bucket cut there would start each day at
// 09:00 — the same mistake redirect_hits made and undid (2026-09-18).
// Creation times come back as UNIX_TIMESTAMP() — seconds since the epoch mean
// the same instant whatever time zone the DB session or this process is in.
const config = require("../configs/index");
const { kstDay } = require("./redirect-hits");
const {
  REMINDER_DAYS,
  daysUntil,
  reminderStageFor,
  shouldSendReminder,
} = require("./expiry");

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 30;

/**
 * Who gets a renewal mail, and when the first of those mails goes out.
 *
 * 🔴 Only records with an account. services/expiry-job.js reaches its rows
 * through `JOIN users`, so a record with no user_id never receives a mail —
 * reading expires_at alone counts those too and overstates the list. The rows
 * here come from a LEFT JOIN so the accountless ones can be counted beside
 * the list rather than vanish without a trace.
 *
 * "When" uses the job's own stage rules: the first stage this record has not
 * been sent yet, on the day it opens. A day already passed means "at the next
 * nightly run".
 *
 * @param {Array<{expires_at, renewal_notice_stage, user_id, email}>} rows
 */
function renewalOutlook(rows, now = new Date()) {
  const horizon = now.getTime() + REMINDER_DAYS[0] * DAY_MS;
  const due = [];
  let accountless = 0;
  let earliest = null;

  for (const row of rows) {
    if (!row.expires_at) continue;
    const expires = new Date(row.expires_at);
    const hasAccount = row.user_id != null && Boolean(row.email);
    const inWindow = expires.getTime() <= horizon;

    if (!hasAccount) {
      if (inWindow) accountless += 1;
      continue;
    }

    const next = nextNoticeAt(expires, row.renewal_notice_stage, now);
    if (next && (!earliest || next < earliest)) earliest = next;

    if (inWindow) {
      due.push({
        name: `${row.subdomain}.${row.domain_name}`,
        email: row.email,
        expiresAt: expires.toISOString(),
        daysLeft: daysUntil(expires, now),
        stage: reminderStageFor(daysUntil(expires, now)),
        sentStage: row.renewal_notice_stage ?? null,
        nextNoticeAt: next ? next.toISOString() : null,
      });
    }
  }

  due.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  return {
    windowDays: REMINDER_DAYS[0],
    remindersEnabled: config.expiry.remindersEnabled,
    count: due.length,
    accountlessInWindow: accountless,
    earliestNoticeAt: earliest ? earliest.toISOString() : null,
    items: due,
  };
}

/** The day the next unsent stage opens, never earlier than now. Null when all are sent. */
function nextNoticeAt(expires, sentStage, now) {
  for (const stage of REMINDER_DAYS) {
    if (!shouldSendReminder(stage, sentStage)) continue;
    const opens = new Date(expires.getTime() - stage * DAY_MS);
    return opens < now ? now : opens;
  }
  return null;
}

/** 30 Seoul days ending today, oldest first, people and accountless apart. */
function dailyTrend(rows, now = new Date()) {
  const days = [];
  const index = new Map();
  for (let i = TREND_DAYS - 1; i >= 0; i -= 1) {
    const day = kstDay(new Date(now.getTime() - i * DAY_MS));
    index.set(day, days.length);
    days.push({ day, people: 0, accountless: 0 });
  }
  for (const row of rows) {
    const at = index.get(kstDay(new Date(Number(row.created_ts) * 1000)));
    if (at === undefined) continue;
    if (row.user_id == null) days[at].accountless += 1;
    else days[at].people += 1;
  }
  return days;
}

const num = (value) => Number(value || 0);

async function collectStats(fastify, now = new Date()) {
  const db = fastify.mysql;

  const [
    [[users]],
    [[subs]],
    [trendRows],
    [typeRows],
    [recentRows],
    [expiryRows],
    [unreachableRows],
    [hitRows],
    [[keys]],
    [[txt]],
  ] = await Promise.all([
    db.execute(
      "SELECT COUNT(*) AS total, SUM(created_at >= NOW() - INTERVAL 30 DAY) AS d30 FROM users"
    ),
    db.execute(
      `SELECT COUNT(*) AS total,
              SUM(created_at >= NOW() - INTERVAL 30 DAY) AS d30,
              SUM(created_at >= NOW() - INTERVAL 7 DAY) AS d7,
              SUM(user_id IS NULL) AS accountless,
              SUM(user_id IS NULL AND created_at >= NOW() - INTERVAL 30 DAY) AS accountless30,
              SUM(user_id IS NULL AND created_at >= NOW() - INTERVAL 7 DAY) AS accountless7
         FROM subdomains`
    ),
    // One day of margin: a Seoul day starts nine hours before the UTC one.
    db.execute(
      `SELECT UNIX_TIMESTAMP(created_at) AS created_ts, user_id FROM subdomains
        WHERE created_at >= NOW() - INTERVAL ${TREND_DAYS + 1} DAY`
    ),
    db.execute(
      "SELECT record_type, COUNT(*) AS n FROM subdomains GROUP BY record_type ORDER BY n DESC"
    ),
    db.execute(
      `SELECT s.subdomain, m.domain_name, s.record_type, s.user_id, s.owner_type,
              UNIX_TIMESTAMP(s.created_at) AS created_ts
         FROM subdomains s
         JOIN managed_domains m ON s.domain_id = m.id
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 20`
    ),
    db.execute(
      `SELECT s.subdomain, m.domain_name, s.expires_at, s.renewal_notice_stage,
              s.user_id, u.email
         FROM subdomains s
         JOIN managed_domains m ON s.domain_id = m.id
         LEFT JOIN users u ON s.user_id = u.id
        WHERE s.expires_at IS NOT NULL
        ORDER BY s.expires_at`
    ),
    db.execute(
      `SELECT s.subdomain, m.domain_name, s.record_type, s.record_value, s.user_id,
              s.warning_count, s.last_checked_at, s.last_warning_at, s.unreachable_notified_at
         FROM subdomains s
         JOIN managed_domains m ON s.domain_id = m.id
        WHERE s.warning_count > 0 OR s.unreachable_notified_at IS NOT NULL
        ORDER BY s.last_warning_at DESC`
    ),
    db.execute(
      `SELECT s.subdomain, m.domain_name, s.record_value,
              SUM(h.hits) AS hits, MAX(h.last_hit_at) AS last_hit_at
         FROM redirect_hits h
         JOIN subdomains s ON h.subdomain_id = s.id
         JOIN managed_domains m ON s.domain_id = m.id
        GROUP BY h.subdomain_id, s.subdomain, m.domain_name, s.record_value
        ORDER BY hits DESC
        LIMIT 10`
    ),
    db.execute("SELECT COUNT(*) AS total FROM api_keys"),
    db.execute("SELECT COUNT(*) AS total FROM subdomain_txt_records"),
  ]);

  const iso = (value) => (value ? new Date(value).toISOString() : null);

  return {
    generatedAt: now.toISOString(),
    summary: {
      users: { total: num(users.total), last30: num(users.d30) },
      subdomains: {
        total: num(subs.total),
        last30: num(subs.d30),
        last7: num(subs.d7),
        accountless: num(subs.accountless),
        accountlessLast30: num(subs.accountless30),
        accountlessLast7: num(subs.accountless7),
      },
      apiKeys: num(keys.total),
      txtRecords: num(txt.total),
    },
    daily: dailyTrend(trendRows, now),
    recordTypes: typeRows.map((row) => ({ type: row.record_type, count: num(row.n) })),
    recent: recentRows.map((row) => ({
      name: `${row.subdomain}.${row.domain_name}`,
      type: row.record_type,
      accountless: row.user_id == null,
      ownerType: row.owner_type,
      createdAt: iso(Number(row.created_ts) * 1000),
    })),
    renewal: renewalOutlook(expiryRows, now),
    unreachable: {
      count: unreachableRows.length,
      items: unreachableRows.map((row) => ({
        name: `${row.subdomain}.${row.domain_name}`,
        type: row.record_type,
        value: row.record_value,
        accountless: row.user_id == null,
        warningCount: num(row.warning_count),
        lastCheckedAt: iso(row.last_checked_at),
        lastWarningAt: iso(row.last_warning_at),
        notifiedAt: iso(row.unreachable_notified_at),
      })),
    },
    topRedirects: hitRows.map((row) => ({
      name: `${row.subdomain}.${row.domain_name}`,
      target: row.record_value,
      hits: num(row.hits),
      lastHitAt: iso(row.last_hit_at),
    })),
  };
}

module.exports = { collectStats, renewalOutlook, dailyTrend };
