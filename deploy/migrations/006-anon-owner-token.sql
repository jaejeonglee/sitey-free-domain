-- 006 — what proves a record belongs to a caller with no account.
--
-- The address did, and it was wrong in both directions. An agent whose IP
-- moved lost its records (plugins/mcp.js told it to "sign up at sitey.my",
-- which an agent cannot do), and 🔴 two strangers behind one NAT shared an
-- address, so either could list, repoint and delete the other's records.
--
-- A caller now gets a token on its first create and proves ownership with
-- that. Only the sha256 of it is kept, the same way api_keys.key_hash keeps an
-- API key, so a copy of this table is not a set of working credentials.
--
-- 🔴 Apply this BEFORE restarting the application. The code does not tolerate
-- the column being absent: every anonymous read and write names it, and the
-- one degraded mode available — falling back to the address — is precisely the
-- bug being fixed here. A loud failure for the minutes between the two steps
-- is the cheaper mistake. (services/quota.js tolerates users.subdomain_limit
-- missing for the opposite reason: nothing is at stake there but a number.)
--
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/006-anon-owner-token.sql

ALTER TABLE subdomains
  ADD COLUMN owner_token_hash VARCHAR(64) NULL DEFAULT NULL AFTER owner_ip,
  ADD INDEX idx_owner_token (owner_token_hash);

-- ---------------------------------------------------------------------------
-- No backfill, on purpose
-- ---------------------------------------------------------------------------
-- The 41 rows already here stay NULL and keep being proved by owner_ip, which
-- is what their owners have. A token cannot be invented for them — nobody
-- would ever be told what it was, and the record would become unreachable the
-- moment the column was written. NULL is not a gap to be filled in later; it
-- means "this one predates tokens", and services/anon-token.js reads it that
-- way for as long as those rows live.
--
-- Check before leaving: every existing row still NULL, and the split visible.
--
--   SELECT owner_type,
--          COUNT(*)                                        AS rows,
--          SUM(owner_token_hash IS NULL)                   AS by_address,
--          SUM(owner_token_hash IS NOT NULL)               AS by_token
--     FROM subdomains GROUP BY owner_type;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- 🔴 Roll the code back first. Dropping this column under the running
-- application breaks every anonymous request, and dropping it after a caller
-- has been handed a token throws away the only proof that caller has — the
-- record goes back to being proved by whatever address it was made from, which
-- may be nobody's now.
--
--   ALTER TABLE subdomains DROP COLUMN owner_token_hash;
