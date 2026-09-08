-- 001 — remember that an owner was told their site is dark.
--
-- Reachability no longer deletes anything (services/validation.js). It counts
-- consecutive failed daily checks in `warning_count` and, once that run passes
-- UNREACHABLE_NOTICE_DAYS, mails the owner once. This column is what stops it
-- mailing them again every night; it is cleared the moment the site answers.
--
-- A new column rather than reusing `last_warning_at`: rows already carry a
-- `last_warning_at` set by the old two-strike policy, and reading those as
-- "already notified" would silence the notice for exactly the records that
-- have been down longest.
--
-- Run this together with 002-subdomain-expiry.sql — see deploy/README.md §4.
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/001-unreachable-notice.sql

ALTER TABLE subdomains
  ADD COLUMN unreachable_notified_at TIMESTAMP NULL DEFAULT NULL AFTER last_warning_at;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- The application tolerates the column being absent only if the code is rolled
-- back with it: services/validation.js selects and writes this name.
--
--   ALTER TABLE subdomains DROP COLUMN unreachable_notified_at;
