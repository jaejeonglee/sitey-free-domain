-- 008 — how many people a REDIRECT name actually sent.
--
-- One row per subdomain per day, not a counter on `subdomains`. Three columns
-- there (hit_count, hit_count_month, last_hit_at) would have been fewer
-- writes, but "this month" then needs somebody to zero it on the 1st: a job
-- that has to run, that has never run, and whose failure looks exactly like a
-- quiet month. Here "this month" is a WHERE clause over rows that are already
-- dated, so nothing has to happen at midnight on the 1st for the number to be
-- right — and the same rows answer "last week" or a graph later without
-- another migration.
--
-- The cost is a table that grows: one row per redirecting name per day it is
-- used. 44 records, all redirecting, all used every day, is 16k rows a year.
-- deleteRowsOlderThan below caps it at redirect.hitRetentionDays (400).
--
-- 🔴 Apply BEFORE restarting the application on the commit that adds counting.
-- Without the table every flush fails; the 301 still goes out (the counter is
-- swallowed and logged — plugins/redirect.js), but the dashboard shows zeros
-- for as long as the gap lasts, and those visits are not recoverable.
--
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/008-redirect-hits.sql

-- ---------------------------------------------------------------------------
-- Check FIRST — do not assume the running schema
-- ---------------------------------------------------------------------------
-- 007 stated in its own comments that record_type was VARCHAR(10) "so nothing
-- has to be altered". In production it was ENUM('A','CNAME'), and the first
-- REDIRECT insert failed with "Data truncated for column 'record_type'". The
-- file was describing schema/init.sql, not the database.
--
-- So: read the real thing before running this, because two facts below are
-- borrowed from it and a mismatch is a hard error, not a warning.
--
--   SHOW CREATE TABLE subdomains\G
--
-- ① `subdomains.id` — schema/init.sql says INT AUTO_INCREMENT. The foreign key
--    below will only be accepted if `redirect_hits.subdomain_id` has the *same*
--    type and signedness. If the real column is BIGINT, or UNSIGNED, change
--    the column below to match before running (MySQL error 3780 otherwise).
--
--      SHOW COLUMNS FROM subdomains LIKE 'id';
--
-- ② engine and charset — the FK needs both tables on InnoDB. The clause below
--    says InnoDB/utf8mb4 explicitly rather than relying on the server default,
--    but if `subdomains` turns out to be something else the FK will be refused
--    and that is the signal to stop and ask, not to drop the FK.
--
--      SELECT ENGINE, TABLE_COLLATION FROM information_schema.TABLES
--       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subdomains';
--
-- ③ the table is not already there from a half-finished attempt:
--
--      SHOW TABLES LIKE 'redirect_hits';

CREATE TABLE IF NOT EXISTS redirect_hits (
  -- Matches subdomains.id — see ① above. ON DELETE CASCADE because a deleted
  -- name has no page to show these numbers on, and an orphan row would keep a
  -- stranger's visit count alive under an id that gets reused.
  subdomain_id INT NOT NULL,
  -- The server's date, written by MySQL (CURDATE()) rather than by Node, so
  -- "what day is it" has one answer even if the two disagree about timezone.
  -- Named hit_day, not `day`: DAY() is a function and an unquoted `day` reads
  -- badly in every query that follows.
  hit_day DATE NOT NULL,
  -- BIGINT UNSIGNED, not INT: a link that goes round once costs nothing here,
  -- and a counter that silently stops at 4.2 billion is the kind of bug found
  -- years later. The rows are cheap.
  hits BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- The last visit inside this day. MAX() over the rows is what "last seen"
  -- means for a record, so no second place has to be kept in step.
  last_hit_at DATETIME NOT NULL,
  -- (subdomain_id, hit_day) is the identity, and the upsert depends on it:
  -- INSERT ... ON DUPLICATE KEY UPDATE hits = hits + VALUES(hits) is what adds
  -- a batch to the day's running total.
  PRIMARY KEY (subdomain_id, hit_day),
  -- The nightly delete scans by date across every subdomain.
  INDEX idx_redirect_hits_day (hit_day),
  FOREIGN KEY (subdomain_id) REFERENCES subdomains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- No backfill
-- ---------------------------------------------------------------------------
-- Nothing was counted before this, and there is nowhere to recover it from:
-- the 301s that have already gone out left a log line (evt:"redirect") and no
-- row. An empty table is the honest starting point — the dashboard says "not
-- clicked yet" rather than a number invented from log greps.

-- ---------------------------------------------------------------------------
-- Check before leaving
-- ---------------------------------------------------------------------------
--   SHOW CREATE TABLE redirect_hits\G
--   SELECT COUNT(*) FROM redirect_hits;                       -- 0, for now
--
-- Then, after the application is restarted, visit a REDIRECT name once and:
--
--   SELECT s.subdomain, h.hit_day, h.hits, h.last_hit_at
--     FROM redirect_hits h JOIN subdomains s ON s.id = h.subdomain_id;
--
-- Up to redirect.hitFlushMs (10s by default) passes before the row appears —
-- visits are batched in memory. If nothing arrives after a minute, look for
-- `evt:"redirect_hits"` at warn level in the journal: that is the counter
-- failing without touching the redirect itself.

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- Safe in either order — the counter's failure path is already "warn and carry
-- on", so the running code survives the table disappearing. Roll the code back
-- too, or the log fills with one warn line every flush.
--
--   DROP TABLE redirect_hits;
