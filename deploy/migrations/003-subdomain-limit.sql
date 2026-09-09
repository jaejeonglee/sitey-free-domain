-- 003 — how many subdomains one account may hold.
--
-- NULL means "whatever SUBDOMAIN_LIMIT_DEFAULT says" (3 today), so the number
-- everybody gets can be moved with an environment variable and a restart, and
-- this column is only ever written to make an exception of one account.
--
-- 🔴 An exception is a number in this column, never a name in the source. The
-- two accounts we already intend to exempt are people, and a service that
-- hard-codes who its friends are cannot be handed to anyone else — nor can the
-- exception be undone without a deploy. Same reason the rest of this service
-- records facts in the database and rules in the code.
--
-- Measured 2026-09-09: 14 of 38 accounts hold anything at all. One holds 11,
-- one holds 8, one holds 4, and everybody else holds three or fewer.
--
-- The free allowance was raised to 5 and switched on the same evening. At 5
-- only the 11 and the 8 are over, and both already carry an exception, so
-- enforcing refuses nobody who is here today. See deploy/README.md §7.
--
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/003-subdomain-limit.sql

ALTER TABLE users
  ADD COLUMN subdomain_limit INT NULL DEFAULT NULL AFTER picture;

-- ---------------------------------------------------------------------------
-- Granting an exception
-- ---------------------------------------------------------------------------
-- One statement per account, run by hand, with the reason in the commit or the
-- runbook rather than in the schema:
--
--   UPDATE users SET subdomain_limit = 20 WHERE email = '<address>';
--
-- And to take it back, put it to NULL rather than to the default — then the
-- account follows SUBDOMAIN_LIMIT_DEFAULT again if that number ever moves:
--
--   UPDATE users SET subdomain_limit = NULL WHERE email = '<address>';

-- Check before leaving: everybody on the default, nobody accidentally at 0.
--
--   SELECT subdomain_limit, COUNT(*) FROM users GROUP BY subdomain_limit;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- Safe to drop with the code still deployed: services/quota.js tolerates the
-- column being absent and falls back to SUBDOMAIN_LIMIT_DEFAULT, because the
-- code may equally arrive before this file is run. Dropping it does discard
-- every exception, so write them down before you do.
--
--   ALTER TABLE users DROP COLUMN subdomain_limit;
