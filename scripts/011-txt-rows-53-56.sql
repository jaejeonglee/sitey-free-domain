-- 011 제안 — subdomain_txt_records 의 옛 행 53·56 (존에 없는 행) 정리. 🔴 실행은 자비스가 판단한다.
-- 2026-10-07 작성. 아무 데서도 자동 실행되지 않는다.
--
-- 이 파일을 쓴 쪽은 운영 DB 를 보지 못했다. 두 행이 «무엇인지» 모르므로 지우기 전에 갈래를 가른다.
--   ① 옛 재시도 행(같은 subdomain_id·host_prefix 에 더 큰 id 가 있다) → 아무도 안 읽는 이력. 지워도 된다.
--      대조기·prune 은 이미 이 행을 무시한다(services/txt-records.js liveTxtRows).
--   ② 살아 있는 행(그 레코드의 최신 행) → 지우면 안 된다. 주인은 아직 그 TXT 가 있다고 믿는다.
--      대조기가 매일 txt-db-only(error)로 찍고 있을 것이다. 고치는 길은 «존에 다시 쓰기»:
--        node deploy/migrate-vercel-txt.js            # dry-run — 53·56 이 «추가할 것»에 나오는지
--        node deploy/migrate-vercel-txt.js --apply
--      (주인의 서브도메인이 CNAME 이고 host_prefix 가 '@' 면 존에 쓸 수 없다 — 그때는 Jay 에게 묻는다)
--
-- ── 1. 본다 ─────────────────────────────────────────────────────────────
SELECT t.id, t.subdomain_id, s.subdomain, m.domain_name, s.record_type, t.host_prefix,
       LEFT(t.txt_value, 60) AS value_head,
       (SELECT MAX(t2.id) FROM subdomain_txt_records t2
         WHERE t2.subdomain_id = t.subdomain_id AND t2.host_prefix = t.host_prefix) AS newest_id_of_record
  FROM subdomain_txt_records t
  LEFT JOIN subdomains s ON s.id = t.subdomain_id
  LEFT JOIN managed_domains m ON m.id = s.domain_id
 WHERE t.id IN (53, 56);
-- newest_id_of_record > id  → ①  (지워도 된다)
-- newest_id_of_record = id  → ②  (지우지 말고 위의 backfill)
-- subdomain 이 NULL        → 주인 없는 행. FK 가 있으면 생길 수 없다 — 이 경우는 지워도 된다(아래 3)

-- ── 2. 백업 (지우기 전에 반드시) ─────────────────────────────────────────
--   mysqldump -u <user> -p <db> subdomain_txt_records --where="id IN (53,56)" \
--     > /root/backup-txt-53-56-$(date +%Y%m%d-%H%M%S).sql

-- ── 3. ①인 것만 지운다 ────────────────────────────────────────────────────
-- 조건이 갈래를 대신 확인한다: 같은 레코드에 더 새 행이 있을 때만 지운다.
-- ②(최신 행)는 이 문장으로 지워지지 않는다 — 영향 행 수가 기대보다 적으면 1번 결과를 다시 본다.
DELETE t FROM subdomain_txt_records t
  JOIN (SELECT subdomain_id, host_prefix, MAX(id) AS newest
          FROM subdomain_txt_records GROUP BY subdomain_id, host_prefix) live
    ON live.subdomain_id = t.subdomain_id AND live.host_prefix = t.host_prefix
 WHERE t.id IN (53, 56) AND t.id < live.newest;
-- 주인 없는 행(1번에서 subdomain 이 NULL)이었다면:
-- DELETE FROM subdomain_txt_records WHERE id IN (53, 56)
--   AND subdomain_id NOT IN (SELECT id FROM subdomains);

-- ── 4. 확인 ─────────────────────────────────────────────────────────────
-- SELECT id FROM subdomain_txt_records WHERE id IN (53, 56);   -- ①였던 것은 사라져야 한다
-- 다음 자정 대조기 로그에 53·56 의 값이 더 나오지 않는지:
--   grep '"evt":"reconcile"' /root/.pm2/logs/server-out.log | tail -20
