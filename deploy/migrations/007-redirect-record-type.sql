-- 007 — the third record type, REDIRECT.
--
-- A REDIRECT row holds a URL where an A row holds an address; the zone gets an
-- A record for this server and the app answers the visit with a 301
-- (plugins/redirect.js). Two things in the schema have to make room for it:
--
--   record_type  VARCHAR(10)  — 'REDIRECT' is eight characters, so it already
--                               fits. The column is a string, not an ENUM, and
--                               the code is what refuses anything else
--                               (services/bind.js normalizeRecordType). Nothing
--                               to alter; this file says so rather than leave
--                               the question open.
--   record_value VARCHAR(255) — a URL is longer than a hostname. The code
--                               accepts up to 2048 (configs/index.js
--                               redirect.maxUrlLength), so the column has to.
--
-- Apply BEFORE restarting the application on the commit that adds REDIRECT.
-- The widened column is harmless to the running code; the running code with
-- the narrow column would truncate the first long URL somebody sends — MySQL
-- in strict mode refuses the INSERT, which is the better of the two failures
-- but still a failure a caller sees.
--
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/007-redirect-record-type.sql

ALTER TABLE subdomains
  MODIFY COLUMN record_value VARCHAR(2048) NOT NULL;

-- 🔴 2026-09-16 운영 적용 중 발견 — 위 주석과 달리 운영 DB 의 record_type 은
-- ENUM('A','CNAME') 이었다. 첫 REDIRECT INSERT 가 "Data truncated for column
-- 'record_type'" 으로 실패했고, 존·DB 에는 아무것도 남지 않았다. 아래 한 줄을
-- 손으로 적용해 해결(18:12). 새 환경에서는 이 파일 그대로 돌리면 된다.
ALTER TABLE subdomains
  MODIFY COLUMN record_type ENUM('A','CNAME','REDIRECT') NOT NULL DEFAULT 'A';

-- ---------------------------------------------------------------------------
-- Check before leaving
-- ---------------------------------------------------------------------------
-- The column is wider and every existing row still reads back unchanged.
--
--   SHOW COLUMNS FROM subdomains LIKE 'record_value';
--   SELECT record_type, COUNT(*) FROM subdomains GROUP BY record_type;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- 🔴 Only once no REDIRECT row is longer than 255 characters — narrowing the
-- column truncates (or, in strict mode, refuses) anything longer. Check first:
--
--   SELECT COUNT(*) FROM subdomains WHERE CHAR_LENGTH(record_value) > 255;
--
--   ALTER TABLE subdomains MODIFY COLUMN record_value VARCHAR(255) NOT NULL;
