-- 005 — a TXT value may sit under a name once, not three times.
--
-- Found because the dashboard drew the same domain three times (Jay,
-- 2026-09-11). The rows were real: `kgld-master-admin` held the identical
-- `_vercel` value three times, written at 07:01:28, 07:03:13 and 07:04:25 on
-- 2026-06-25. Somebody pressed save three times and nothing said no.
--
-- The key is (subdomain_id, host_prefix, txt_value) and not the pair
-- (subdomain_id, host_prefix), because a name legitimately holds more than one
-- value. Two subdomains here do — DNS returns TXT as a value list and the
-- original author put the record at the apex for exactly that reason. Keying
-- on the pair would delete a real second verification token and call it
-- cleanup.
--
-- Deleting first, then locking: the index cannot be created while duplicates
-- exist, and doing it in this order means the constraint proves the delete
-- worked rather than the delete being taken on trust.

-- Keep the earliest row of each identical group. Earliest rather than latest
-- because they are byte-identical — the only thing that differs is when it was
-- written, and the first one is the one the zone file was built from.
DELETE t FROM subdomain_txt_records t
JOIN (
  SELECT MIN(id) AS keep_id, subdomain_id, host_prefix, txt_value
  FROM subdomain_txt_records
  GROUP BY subdomain_id, host_prefix, txt_value
  HAVING COUNT(*) > 1
) dupes
  ON  t.subdomain_id = dupes.subdomain_id
  AND t.host_prefix  = dupes.host_prefix
  AND t.txt_value    = dupes.txt_value
  AND t.id          <> dupes.keep_id;

-- txt_value is long enough that the three columns together can exceed the
-- index length limit, so the value is keyed by a prefix. 255 bytes is well
-- past any verification token in the table and past what providers issue.
ALTER TABLE subdomain_txt_records
  ADD UNIQUE KEY uniq_txt_record (subdomain_id, host_prefix, txt_value(255));
