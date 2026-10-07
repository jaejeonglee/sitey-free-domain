-- 010 — a blocklist, and somewhere for an abuse report to land.
--
-- 2026-10-06/07: an anonymous caller (calling itself "catikteam") published a
-- malware contact point through sitey. Its address was blocked at the edge
-- and it came back from another one the next day. This gives the
-- application its own list — names, owner tokens, addresses — asked on every
-- create, value change and TXT write (services/blocklist.js), and a table for
-- the reports that /abuse now accepts from anyone (routes/abuse.js).
--
-- 🔴 Apply BEFORE restarting the application on the commit that adds them.
-- The blocklist check is fail-close: without the table every create, update
-- and TXT write answers 500. That is deliberate — the alternative is a check
-- that silently lets everything through while it is missing.
--
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/010-blocklist-abuse-reports.sql
--
-- Check first:
--   SHOW TABLES LIKE 'blocklist';
--   SHOW TABLES LIKE 'abuse_reports';

CREATE TABLE IF NOT EXISTS blocklist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- name  — found anywhere in the subdomain (LOCATE), so a digit added after
  --         a refusal does not get round it.
  -- token — sha256 hex of an owner token, the shape of
  --         subdomains.owner_token_hash. Exact.
  -- ip    — request.ip as the application sees it (after the trusted proxy).
  --         Exact.
  kind ENUM('name','token','ip') NOT NULL,
  value VARCHAR(255) NOT NULL,
  -- Why, for whoever reads this table next. Free text.
  reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_blocklist_kind_value (kind, value),
  -- An empty name would be found inside every name and refuse everybody.
  -- MySQL 8.0.16+ enforces this; older versions parse and ignore it, so do not
  -- insert one either way.
  CONSTRAINT chk_blocklist_value CHECK (value <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS abuse_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- What the reporter typed as the address — a URL or a hostname. Not
  -- validated beyond length: a report about something we do not recognise is
  -- still a report.
  target VARCHAR(512) NOT NULL,
  reason TEXT NOT NULL,
  -- Optional. An email or anything else the reporter wants to be reached at.
  contact VARCHAR(255) NULL,
  -- The reporter's address, hashed the way the access log hashes it (iph), so
  -- repeated reports from one place can be seen without keeping the address.
  reporter_iph VARCHAR(64) NULL,
  -- 'new' until somebody has looked. Nothing in the application changes it.
  status ENUM('new','done') NOT NULL DEFAULT 'new',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_abuse_reports_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Seed — what we already know (2026-10-07)
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO blocklist (kind, value, reason) VALUES
  ('name', 'catikteam',      '2026-10-06 malware contact point via anonymous self-named TXT'),
  ('ip',   '31.76.1.17',     '2026-10-06 catikteam'),
  ('ip',   '94.156.115.193', '2026-10-07 catikteam, returned from a new address');

-- ---------------------------------------------------------------------------
-- Check before leaving
-- ---------------------------------------------------------------------------
--   SELECT kind, value, reason FROM blocklist;          -- 3 rows
--   SHOW CREATE TABLE abuse_reports\G
--
-- Adding one later (until the admin screen exists):
--   INSERT INTO blocklist (kind, value, reason) VALUES ('ip', '<addr>', '<why>');
--   -- a token: the hash, never the token itself
--   INSERT INTO blocklist (kind, value, reason)
--     SELECT 'token', owner_token_hash, '<why>' FROM subdomains
--      WHERE subdomain = '<name>' AND owner_token_hash IS NOT NULL;
--
-- Reading the reports:
--   SELECT id, created_at, target, LEFT(reason, 80), contact FROM abuse_reports
--    WHERE status = 'new' ORDER BY id DESC;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- Roll the code back FIRST: the running code refuses to write without
-- `blocklist`. Then:
--
--   DROP TABLE blocklist;
--   DROP TABLE abuse_reports;   -- reports in it are lost; export them first
