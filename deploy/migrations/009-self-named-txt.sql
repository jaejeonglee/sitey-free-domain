-- 009 — adopt the TXT record that was placed in the zone by hand.
--
-- 🔴 OPTIONAL, and it needs one thing checked first. See "before you run it".
--
-- There is no schema change here, and that is the point worth writing down.
-- A TXT on the subdomain's own name is stored as an ordinary row of
-- `subdomain_txt_records` with `host_prefix = '@'`:
--
--   * '@' is what a zone file calls the name it is already at, so it is the
--     conventional spelling of "no prefix — this name itself";
--   * it is the one value `validateHostPrefix` could never produce before
--     (a DNS label cannot contain '@'), so no row already in the table can be
--     holding it and no prefix a caller invents can collide with it;
--   * which means it shares the existing UNIQUE (subdomain_id, host_prefix)
--     instead of needing a column, and every path that reads, writes, deletes
--     or reconciles a TXT row keeps working unchanged. `bind.txtRecordName`
--     turns '@' into the subdomain on the way to the zone file, so the marker
--     never appears in the zone.
--
-- So the application needs nothing applied. What this file is for is the one
-- record that already exists in the zone without a row behind it.
--
-- ---------------------------------------------------------------------------
-- What it adopts
-- ---------------------------------------------------------------------------
--
-- `test.sitey.my IN TXT "v=MCPv1; ..."` was written into the zone by hand on
-- 2026-09-22 (zone serial 177 -> 178, backup db.sitey.my.pre-mcptxt-065448),
-- before the feature existed. With no row behind it:
--
--   * the dashboard shows an empty TXT box for `test`, and saving anything
--     there would append a second line rather than replace this one;
--   * the nightly reconciler says nothing about it either way — a name no row
--     has ever claimed is not the app's to judge (plugins/reconciler.js), so
--     if it disappears from the zone nobody finds out;
--   * deleting the `test` subdomain leaves the TXT line behind forever, since
--     `deleteSubdomain` removes the lines its rows name and this one has none.
--
-- One row fixes all three.
--
-- ---------------------------------------------------------------------------
-- 🔴 Before you run it
-- ---------------------------------------------------------------------------
--
-- The value below has to match the zone line **character for character**.
-- Deletion finds a TXT line by its value — the apex name is shared, so the
-- value is the only handle — and the reconciler compares by value too. A row
-- that disagrees with the zone reports as drift every night and its delete
-- silently removes nothing. Check it first:
--
--   dig +short TXT test.sitey.my
--   grep -n '^test' /etc/bind/db.sitey.my
--
-- If the line reads differently, change the value here rather than the zone:
-- the zone is what the world is already reading.
--
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/009-self-named-txt.sql

-- ---------------------------------------------------------------------------

INSERT INTO subdomain_txt_records (subdomain_id, host_prefix, txt_value)
SELECT s.id, '@',
       'v=MCPv1; k=ed25519; p=G72mfmBr3XwUBjR0G3ehT4un5XxkVO9gnaMHTr3Kpnk='
  FROM subdomains s
  JOIN managed_domains m ON s.domain_id = m.id
 WHERE s.subdomain = 'test'
   AND m.domain_name = 'sitey.my'
ON DUPLICATE KEY UPDATE txt_value = VALUES(txt_value);

-- Idempotent twice over: the SELECT finds nothing if `test` is gone, and the
-- unique key turns a second run into an update to the value it already holds.

-- Check:
--   SELECT s.subdomain, t.host_prefix, t.txt_value
--     FROM subdomain_txt_records t
--     JOIN subdomains s ON t.subdomain_id = s.id
--    WHERE t.host_prefix = '@';
