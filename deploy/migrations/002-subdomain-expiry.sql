-- 002 — subdomains fall due and have to be renewed.
--
-- `expires_at` NULL means "never expires". That is the safe reading for any
-- row the backfill below did not touch: the expiry job skips NULL, so a row it
-- missed is left alone rather than removed on a technicality.
--
-- `renewal_notice_stage` holds the last reminder sent for the current period
-- (14, 3 or 0 days out) so the nightly job does not repeat one. Renewing
-- clears it back to NULL.
--
-- Run this together with 001-unreachable-notice.sql — see deploy/README.md §4.
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/002-subdomain-expiry.sql

ALTER TABLE subdomains
  ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL AFTER created_at,
  ADD COLUMN renewal_notice_stage TINYINT NULL DEFAULT NULL AFTER expires_at;

-- ---------------------------------------------------------------------------
-- Backfill — from the day this runs, NOT from created_at.
-- ---------------------------------------------------------------------------
-- The 44 records that exist today predate the whole idea; the oldest are from
-- 2025-11. Dating them from creation would expire almost all of them the
-- morning the job is switched on, before a single owner had been sent a
-- reminder or given a chance to press the button. Everyone starts with a full
-- period from today. services/expiry.js keeps the same rule for new records.
--
-- `expires_at IS NULL` makes this safe to run twice: a row that already has a
-- date, because it was created after the code shipped, is left where it is.

UPDATE subdomains
   SET expires_at = DATE_ADD(NOW(), INTERVAL 3 MONTH)
 WHERE expires_at IS NULL
   AND owner_type = 'user';

UPDATE subdomains
   SET expires_at = DATE_ADD(NOW(), INTERVAL 1 MONTH)
 WHERE expires_at IS NULL
   AND owner_type = 'agent';

-- Check before leaving: no row should be left without a date, and the two
-- groups should sit three months and one month out.
--
--   SELECT owner_type, COUNT(*), MIN(expires_at), MAX(expires_at)
--     FROM subdomains GROUP BY owner_type;
--   SELECT COUNT(*) FROM subdomains WHERE expires_at IS NULL;   -- expect 0

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- Roll the code back with it: services/expiry.js and routes/renewal.js read
-- these names. Dropping the columns discards the dates, so a re-run of the
-- backfill afterwards restarts everybody's clock — which is harmless, but it
-- means nobody is ever removed for a period they were never told about.
--
--   ALTER TABLE subdomains
--     DROP COLUMN renewal_notice_stage,
--     DROP COLUMN expires_at;
