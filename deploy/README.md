# deploy — 서버 적용 절차

이 디렉토리의 파일은 **저장소에만 있고 서버에는 아직 반영되지 않았다.**
아래 절차를 서버(`139.59.126.52`)에서 직접 실행해야 적용된다.

| 파일 | 용도 |
|---|---|
| ~~`dns-controller.service`~~ | ⛔ **쓰지 않는다.** 이 서버는 **PM2** 로 운영한다(2026-09-07 Jay 결정). 참고용으로만 남긴다 — 1절 |
| `caddy-canonical.snippet` | `sitey.one`·`www.*` → `sitey.my` 301 리다이렉트 |
| `migrate-vercel-txt.js` | 덮어쓰기로 사라진 TXT 값을 DB 기준으로 복구 + `--prune-orphans` 로 주인 없는 줄 정리 (둘 다 dry-run 기본) |
| `migrations/001-unreachable-notice.sql` | `subdomains.unreachable_notified_at` 추가 — 4절 |
| `migrations/002-subdomain-expiry.sql` | `expires_at`·`renewal_notice_stage` 추가 + **시행일 기준 백필** — 4절 |
| `migrations/003-subdomain-limit.sql` | `users.subdomain_limit` 추가 (계정별 한도·예외) — 7절 |
| `migrations/004-credit-ledger.sql` | `credit_entries` 생성 (결제 기록 = 잔액) — 7절 |
| `cleanup-unreachable.js` | 지금 죽어 있는 것들의 **일회성** 정리 (dry-run 기본) — 5절 |
| `preview-emails.js` | 나가는 메일·갱신 화면을 **발송 없이** HTML 파일로 렌더 (환경변수 불필요) — 4절 |

> 🔴 **존에 인프라 레코드를 손으로 추가했으면 `configs/index.js` 의 `infraRecords` 도 같이 고친다.**
> reconciler 는 존과 DB 를 매일 밤 대조하는데, 인프라 레코드는 DB 에 행이 없다 —
> 목록에 없으면 **매일 밤 「DB 에 없는 레코드」 경고가 하나씩 늘어난다.**
> 2026-09-08 메일용 레코드 넷(`send`·`rsend`·`_dmarc`·`resend._domainkey`)을 넣고 여기서 걸렸다.

> ✅ **PSL 등재 선행조건은 없어졌다** (2026-09-07 재조사).
> 이전 판은 TXT 이름을 서브도메인별로 나누려 했고, 그러면 PSL 등재 전까지 검증이 전원 불가해졌다.
> 지금은 이름을 그대로 두고 **덮어쓰기만** 고쳤다 — 3절 참고. 세 파일 모두 지금 적용해도 된다.

---

## 1. 프로세스 관리자 — PM2 (systemd 아님)

> 🔴 **2026-09-07 정정.** 이 절은 원래 「프로세스 관리자가 없으니 systemd 를 넣자」였다. **둘 다 틀렸다.**
> **PM2 가 2026-04-11 부터 돌고 있었다.** 앱만 보고(`ps -C node`) 부모를 안 본 것이 원인이다(`ps -o ppid=` 한 줄이면 나왔다).
> 그리고 Jay 결정 — **PM2 를 쓴다.** systemd 유닛은 서버에서 제거했다. 둘을 같이 두면 포트 3000 을 두고 싸운다(실측: `EADDRINUSE` 재시작 루프).

### 진짜 고장은 무엇이었나

PM2 는 돌고 있었지만 **부팅 등록이 안 돼 있었다.**

- `pm2-root.service` **not-found** → 재부팅하면 **PM2 자체가 안 뜬다**
- `/root/.pm2/dump.pm2` **없음** → PM2 를 되살려도 **앱 목록이 비어 있다**

→ 「재부팅하면 서비스가 안 뜬다」는 **맞았고 이유만 틀렸다.** 명령 두 줄로 끝난다.

### 적용 (2026-09-07 완료)

```bash
export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH   # node 가 nvm 아래에 있다

cd /root/dns-controller && git pull
NODE_ENV=production pm2 restart server --update-env    # 없으면 pm2 start server.js --name server --time

pm2 startup systemd -u root --hp /root   # 부팅 시 PM2 자동 기동
pm2 save                                  # 프로세스 목록 저장 (이게 없으면 부팅 후 빈 목록)

pm2 install pm2-logrotate                 # 로그 압축 보관 (Jay 지시: 삭제 말고 압축)
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:retain 90
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:rotateInterval "0 0 * * *"
```

⚠️ **`NODE_ENV=production` 을 빠뜨리지 마라.** 없으면 pino 가 pino-pretty 로 **여러 줄** 출력을 내고,
`services/access-log.js` 가 만드는 **탈주 로그가 파싱 불가 형태**가 된다(2026-09-07 실측 — 배포 직후 눈으로 확인해서 잡았다).
📌 **프로세스 관리자를 바꾸면 환경변수가 따라오지 않는다.**

⚠️ `node` 는 `/usr/bin/node` 가 아니라 **`/root/.nvm/versions/node/v24.11.0/bin/node`** 다.
nvm 으로 업그레이드하면 경로가 바뀐다 — 확인: `readlink -f /proc/$(pgrep -f dns-controller/server.js)/exe`

### 검증 (이걸 통과해야 끝난 것)

```bash
pm2 list                                  # server online, pm2-logrotate online
systemctl is-enabled pm2-root             # enabled
ls -la /root/.pm2/dump.pm2                # 존재해야 한다

# 로그가 JSON 한 줄인지 — 여러 줄이면 NODE_ENV 가 빠진 것이다
tail -1 /root/.pm2/logs/server-out.log

curl -sSI https://sitey.my/ | head -1     # 밖에서도 살아 있는지

# 자동 복구가 실제로 도는지
pm2 describe server | grep restarts
```

---

## 2. 정본 도메인 301 리다이렉트 (Caddy)

`sitey.one` · `www.sitey.one` · `www.sitey.my` → **`sitey.my`** 로 301.
정본을 `sitey.my` 로 정한 것은 Jay 결정(2026-09-07).

### 왜 앱이 아니라 Caddy 인가

- Caddy 가 이미 이 네 호스트의 TLS 를 종단한다. 여기서 처리하면 **Node 까지 오지 않는다.**
- **앱이 죽어 있어도 리다이렉트는 동작한다.** 앱에서 처리하면 앱이 죽는 순간 정본 도메인도 같이 죽는다.
- 앱이 «어느 호스트로 불렸는지»는 `Host` 헤더로만 알 수 있는데, 그걸 신뢰하려면 프록시 신뢰 문제가 또 생긴다.

### ⚠️ 적용 전에 반드시 확인할 것

1. **`*.sitey.my` 서브도메인은 리다이렉트 대상이 아니다.**
   사용자 서브도메인은 각자의 서버를 가리키는 A/CNAME 이라 이 서버의 Caddy 를 거치지 않는다.
   스니펫의 호스트 목록에 **와일드카드를 절대 넣지 말 것.**

2. **Google OAuth 콜백 URL 을 먼저 옮긴다.**
   `GOOGLE_CALLBACK_URL` 이 `sitey.one` 계열이면 리다이렉트를 켠 뒤 로그인 흐름이 도메인을 넘나든다.
   순서를 지킨다:
   - ① Google Cloud Console → OAuth 클라이언트 → 승인된 리디렉션 URI 에
     `https://sitey.my/api/auth/google/callback` **추가**(기존 것은 남겨둔다)
   - ② 서버 환경변수 파일의 `GOOGLE_CALLBACK_URL` 을 `https://sitey.my/...` 로 변경
   - ③ `NODE_ENV=production pm2 restart server --update-env`
   - ④ 실제로 구글 로그인 1회 성공 확인
   - ⑤ 그 다음에 아래 리다이렉트 적용
   - ⑥ 한동안 문제없으면 콘솔에서 옛 URI 제거

3. 현재 Caddyfile 내용을 모르므로 **덮어쓰지 말고 병합**한다. 백업부터.

### 적용

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%F)

# 스니펫을 보고 Caddyfile 에 «병합» (기존 sitey 블록이 있으면 그 자리를 대체)
cat /root/dns-controller/deploy/caddy-canonical.snippet

caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### 검증

```bash
# 셋 다 301 + Location: https://sitey.my/... 이어야 한다
curl -sSI https://sitey.one/         | head -3
curl -sSI https://www.sitey.one/docs | head -3
curl -sSI https://www.sitey.my/blog  | head -3

# API 는 308 이어야 한다 (301 이면 POST 가 GET 으로 바뀌어 기존 API 사용자가 깨진다)
curl -sSI https://sitey.one/api/v1/domains | head -3

# 정본은 200
curl -sSI https://sitey.my/ | head -1

# 경로별 canonical — 홈이 아니라 /docs 가 나와야 한다
curl -sS https://sitey.my/docs | grep -o '<link rel="canonical"[^>]*>'

# 없는 경로는 진짜 404 (soft 404 제거 확인)
curl -sSI https://sitey.my/no-such-page | head -1

# 사용자 서브도메인은 영향 없어야 한다
curl -sSI https://jay.sitey.my/ | head -1
```

### 되돌리기

```bash
cp /etc/caddy/Caddyfile.bak.<날짜> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

---

## 3. TXT 값 복구 (backfill)

보안 수정 3번이 다시 쓰였다. 근거는 `.claude/docs/decisions/0001-txt-record-naming.md`.

- **이름은 그대로 루트의 `_vercel`** — Vercel 이 `sitey.my` 의 서브도메인에 대해 읽는 자리는 여기 하나뿐이다
  (PSL 미등재라 등록 도메인이 `sitey.my` 로 판정된다). 실측 28/28 이 이 자리에 있다.
- **추가는 append** — 같은 (이름, 값)이 있으면 no-op, 그 밖에는 새 줄. 기존 줄을 지우지 않는다.
- **삭제는 값으로** — 이름이 같고 값이 일치하는 한 줄만. 못 찾으면 «성공»이라 하지 않는다.
- **루트에 쓸 수 있는 접두어는 `_vercel` 만** (`APEX_TXT_PREFIXES` 로 확장 가능).
  루트에 `_acme-challenge` 를 심으면 서브도메인 사용자 아무나 `sitey.my` 인증서를 받을 수 있기 때문이다.

### 왜 지금 배포해도 안전한가

**append 는 기존 줄을 건드리지 않는다.** 지금 통과 중인 `kgld-landing-dev.sitey.my` 는
그대로 살아 있고, 나머지는 잘되면 되살아나고 못해도 지금과 같다. **내려갈 여지가 없다.**

### 배포

```bash
export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH
cd /root/dns-controller && git pull
NODE_ENV=production pm2 restart server --update-env
```

### 복구 실행

DB(`subdomain_txt_records`)에 각자의 토큰이 남아 있다. 스크립트가 **존에 없는 값만 골라
루트 `_vercel` 아래에 덧붙인다.** 지우는 동작은 없다.

```bash
# 존 파일 백업부터 (--apply 는 줄을 추가만 하므로 되돌리려면 그 줄을 지우면 된다)
cp /etc/bind/db.sitey.my  /etc/bind/db.sitey.my.bak.$(date +%F)
cp /etc/bind/db.sitey.one /etc/bind/db.sitey.one.bak.$(date +%F)

cd /root/dns-controller

# 1) 계획만 본다 (아무것도 쓰지 않는다)
node deploy/migrate-vercel-txt.js

# 2) 출력이 납득되면 적용
node deploy/migrate-vercel-txt.js --apply

# 3) 검증 — 값이 여러 개 나와야 정상이다
dig +short TXT _vercel.sitey.my @127.0.0.1
named-checkzone sitey.my /etc/bind/db.sitey.my
```

출력 읽는 법:

- `ok` = 이미 존에 있는 값. 건드리지 않는다
- `ADD` = 존에 없어서 덧붙일 값
- 같은 서브도메인의 중복 행(재시도 흔적)은 **가장 최근 1건만** 쓴다
- 「claimed by no row」 = 존에는 있는데 **살아 있는 DB 행이 없는** 줄. 기본값은 **보고만 하고 지우지 않는다.**
  (`_vercel.stock.sitey.one` 은 옛 이름 규칙의 화석이다 — 그 서브도메인은 응답이 없다)

### 고아 TXT 정리 — `--prune-orphans`

**DB 에 주인이 없는 TXT 줄만** 지운다. 2026-09-07 실측으로 두 줄 남아 있다.

```
/etc/bind/db.sitey.one: _vercel        IN TXT "vc-domain-verify=udt.sitey.one,00d528..."
/etc/bind/db.sitey.one: _vercel.stock  IN TXT "vc-domain-verify=stock.sitey.one,012762..."
```

⚠️ **이름으로 지우지 않는다.** `_vercel` 한 이름을 28명이 공유하므로 이름으로 지우면 남의 검증까지
날아간다. 지우는 기준은 **값**이고, **살아 있는 DB 행**이 그 값을 가지고 있으면 목록에 오르지 않는다.

> 🔴 **2026-09-08 변경 — 「살아 있는 행」의 정의가 셋 다 같아졌다.**
> 이전 판은 **재시도로 남은 옛 행도 «주인»으로 쳤다.** 그래서 `_vercel.stock` 이 목록에서 빠졌고,
> reconciler 는 그 줄을 매일 밤 보고하는데 prune 은 지우지 않는 상태가 됐다.
> 이제 셋(복구·reconciler·prune)이 전부 `services/txt-records.js` 의 `liveTxtRows()` 를 쓴다 —
> **(subdomain_id, host_prefix) 별 `id` 최댓값 행만 주인이다.** 옛 재시도 값은 Vercel 이 더는 묻지 않는다.
> **DB 행은 지우지 않는다.** 읽는 쪽만 바뀌었다 — 이력은 그대로 남는다.

- **기본은 여전히 dry-run.** `--prune-orphans` 만 주면 무엇을 지울지 출력만 한다
- **`--prune-orphans --apply` 를 둘 다** 줘야 실제로 지운다
- 삭제는 앱과 같은 경로를 쓴다 — `named-checkzone` 통과한 임시 파일을 rename 으로 갈아끼우고 reload

```bash
# 존 파일 백업부터 — 이 명령은 «지우는» 동작이라 되돌리려면 백업이 필요하다
cp /etc/bind/db.sitey.my  /etc/bind/db.sitey.my.bak.$(date +%F)
cp /etc/bind/db.sitey.one /etc/bind/db.sitey.one.bak.$(date +%F)

cd /root/dns-controller

# 1) 무엇을 지울지 본다 (아무것도 쓰지 않는다)
node deploy/migrate-vercel-txt.js --prune-orphans

# 2) 목록이 위 두 줄과 같으면 적용
node deploy/migrate-vercel-txt.js --prune-orphans --apply

# 3) 검증 — 살아 있는 값들은 그대로 있고 고아만 빠져야 한다
dig +short TXT _vercel.sitey.one @127.0.0.1
dig +short TXT _vercel.stock.sitey.one @127.0.0.1   # 빈 응답이어야 한다
named-checkzone sitey.one /etc/bind/db.sitey.one
```

📌 **지우기 전에 reconciler 가 같은 것을 보는지 확인해도 된다.** 재시작 후 자정에 돌면
`txt-zone-only` 로 같은 두 줄이 로그에 남는다.

```bash
grep '"evt":"reconcile"' /root/.pm2/logs/server-out.log | jq -c 'select(.issue|startswith("txt"))'
```

---

---

## 4. 도달성 정책 변경 + 주기적 갱신 (2026-09-08)

> 🔴 **여기서 바뀐 것 한 줄** — **도달성으로는 이제 아무것도 지우지 않는다.**
> 지우는 길은 **갱신 미이행 하나뿐**이다.

### 왜

기존 정책은 **연속 2회 실패 시 삭제**였고 검사는 하루 한 번 돈다. 즉 **48시간 다운 = 도메인 소멸**.
2026-09-08 아침 Jay 본인 서브도메인 3개가 이렇게 사라졌고, 익명 레코드는 메일 주소가 없어 **아무 통보 없이** 사라진다.

게다가 판정이 틀렸다. CNAME 을 `dns.resolve(타깃)` 으로만 봤는데, **Vercel 에서 배포를 지워도 CDN 호스트명은 DNS 에 남는다.**
실측(2026-09-08): 발급 44개 중 **실제로 뜨는 것은 19개**인데 검사는 거의 전부를 「정상」으로 봤다.

### 판정표 (`services/reachability.js`)

| 응답 | 판정 |
|---|---|
| 2xx · 3xx · **401** · **403** · **404** | **살아있음** |
| 그 밖의 응답 (500 포함) | 살아있음 — 앱이 있고 죽은 것이다 |
| **502 · 503 · 504** | **죽음** — 뒤에 아무것도 없는 게이트웨이 |
| 연결 실패 (DNS 실패·TCP 거부·타임아웃) | **죽음** |

- **404 를 살아있음으로 친 것은 Jay 결정**이다. 루트만 404 인 정상 사이트가 흔하고, 틀렸을 때의 비용이 「멀쩡한 사이트 주인에게 죽었다고 알리는 것」이다.
- ⚠️ **그 결과 하나**: Vercel 에서 배포를 지운 도메인은 Vercel 이 404 를 돌려주므로 **살아있음으로 잡힌다.**
  아무것도 안 지우니 피해는 없지만, 5절 정리 목록에도 **안 올라온다.**
- 검사는 **A·CNAME 모두 실제 HTTP(S) 요청**이고, `Host`·SNI 에 **그 서브도메인 이름**을 넣는다(CDN 은 그 이름으로 라우팅한다).

### 죽어 있으면 무슨 일이 일어나나

1. `warning_count` 에 **연속 실패 «일수»** 가 쌓인다 (하루 1회 검사)
2. `UNREACHABLE_NOTICE_DAYS`(기본 **14**)를 넘으면 **소유자에게 안내 메일 1통.** 「N일째 안 열립니다」
3. **한 번 보내면 다시 열릴 때까지 재발송하지 않는다** (`unreachable_notified_at`)
4. **삭제는 없다.** 없다

로그로 확인:

```bash
grep '"evt":"validate"' /root/.pm2/logs/server-out.log | jq -c 'select(.result=="fail")'
# check(https/http) · status · detail · failure(며칠째) · action 이 한 줄에 들어 있다
```

### 갱신 주기

| 소유 | 수명 | 갱신 방법 | 알림 |
|---|---|---|---|
| `owner_type='user'` (39개) | **3개월** | 메일 안의 버튼 (`GET /renew/:token`) | **14일 전 · 3일 전 · 당일** |
| `owner_type='agent'` (5개) | **1개월** | `POST /api/v1/subdomains/:sub/:domain/renew` · MCP `renew_subdomain` | 없음 — 조회 응답의 `expires_at` |

- 갱신은 **오늘부터** 다시 센다(더해지지 않는다). 미리 눌러도 기간이 쌓이지 않는다.
- 갱신 링크 토큰은 **그 메일이 나열한 서브도메인 id 목록만** 담고, **JWT 와 다른 키**로 서명하며 **30일** 뒤 만료된다.
  그 토큰으로 할 수 있는 일은 **그 목록의 기간 연장 하나뿐**이다 — 행동·범위·사용자를 담는 칸이 없다.
- 「당일」 메일은 자정 실행에 나가고 **삭제는 그 다음 자정**에 일어난다(`expires_at < NOW()`). 하루의 여유가 여기서 생긴다.

### 🔴 알림은 «사람 + 단계» 로 묶인다 (2026-09-08)

이전 판은 **레코드마다 한 통**이었다. 마이그레이션 002 가 44개 만료일을 같은 날로 잡아놨으므로
**11개 가진 사람에게 하루 11통, 세 단계로 33통**이 나갔다. 그 사람이 누르는 버튼은 갱신이 아니라 수신 거부다.

- 묶는 기준은 **`user_id` + 알림 단계(14·3·0)** 다. 사람만으로 묶지 않는 이유 둘 —
  ①메일이 마감일을 한 개만 말할 수 있는데 날짜가 다르면 두 개가 된다
  ②`renewal_notice_stage` 는 **보낸 메일에 대해 레코드마다** 기록되는데, 한 번 보내고 서로 다른 단계를
  기록할 수는 없다. 너무 이르게 기록된 레코드는 **진짜 알림이 영영 안 나가는** 레코드가 된다
- 한 통에 **목록 + 버튼 하나**. 버튼 하나가 그 목록 전부를 연장한다
- 발송 성공 시 **그 메일이 나열한 레코드 전부**에 단계를 기록한다(`WHERE id IN (…)`). 하나만 기록하면 나머지는 다음 밤에 또 간다
- 발송 실패 시 **하나도 기록하지 않는다.** 다음 밤에 그 묶음을 다시 시도한다
- **에이전트 소유는 애초에 이 조회에 안 들어온다** — `JOIN users` 가 그 역할을 한다(`user_id` 가 NULL)
- 로그 한 줄에 `fqdns`(배열)·`records`(개수)·`stage`·`days_left` 가 들어간다.
  `evt:"email"` 쪽 `fqdn` 은 **그 메일이 다룬 이름 전부를 공백으로 이은 문자열**이다

**버튼을 눌렀을 때 — 있는 것만 갱신한다.** 목록 중 이미 사라진 레코드가 있어도 나머지는 갱신된다.
전부-아니면-전무로 하면 **사용자가 직접 지운 서브도메인 하나 때문에 나머지 열 개를 잃는다.**
레코드끼리 묶이는 불변식이 없고(각각 오늘부터 다시 셈), 다시 눌러도 해가 없다. **전부 실패했을 때만** 기존 「no longer here」 화면.

### 메일 문안 — `services/message-layout.js` 한 곳

세 가지(만료 안내·도달 불가 안내·갱신 완료 화면)가 **같은 뼈대**를 쓴다. 나중에 웹 디자인에 맞출 때 이 파일 하나만 고친다.
영어 전용(2026-09-08 Jay 결정 — 한국어 병기 안 함).

- 인라인 스타일·표 레이아웃만. **`<style>`·외부 CSS·자바스크립트·웹폰트·이미지 없음**
- 배경색과 글자색을 **항상 같이** 지정한다(다크모드에서 글자가 사라지지 않게) + `color-scheme` 메타
- 제목에서 `[Sitey]` 를 뺐다. 발신 주소가 이미 누구인지 말한다
- **보내기 전에 눈으로 본다** — 발송 없이 파일로 렌더한다:

```bash
node deploy/preview-emails.js [출력폴더]     # 기본 /tmp/sitey-email-preview
# → index.html 을 브라우저로 연다. 환경변수·키·DB 없이 돈다
```

### 💵 무엇을 파나 — 「5개 묶음, 1년, 1달러」 (Jay 결정 2026-09-09)

한 번 결제 = **서브도메인 5개가 1년 동안 더** 생긴다. 개당 요금이 아니다.

| | 값 | 설정 키 |
|---|---|---|
| 한 번에 늘어나는 개수 | **5** | `SUBDOMAIN_BUNDLE_SIZE` |
| 값 | **1.00** (백만분의 1 단위 = `1000000`) | `SUBDOMAIN_BUNDLE_PRICE_MICROS` |
| 기간 | **365일** | `SUBDOMAIN_BUNDLE_DAYS` |

- **쌓인다. 연장이 아니다.** 두 번 사면 **+10** 이고, 각 묶음이 **자기 1년을 따로** 센다.
  연장으로 만들면 「1년에 10개」가 아니라 「2년에 5개」가 되고, 나중 결제가 앞 결제의 뜻을 바꾼다.
- 만료 시각은 `credit_entries.expires_at` 에 **행마다** 적힌다. 한도 계산은 **아직 안 끝난 행만** 더한다.
- 만료 판정은 **DB 의 `NOW()`** 가 한다. 앱 서버 시계가 틀어져도 1년이 늘거나 줄지 않는다.
- **묶음 값이 안 되면 아무것도 안 준다.** 0.5달러로 2~3개가 생기지 않는다. 남는 금액은 계정에 남는다.

### 🔴 묶음이 끝나면 — 새 규칙이 없다. 있던 규칙이 그대로 답이다

**보유분은 안 뺏는다. 새로 만드는 것만 막힌다.**

8개 가진 사람의 묶음이 만료되면 → **8개 그대로 살아 있고 조회·수정·갱신·삭제 다 된다. 9번째만 거부.**
한도는 언제나 **«다음 것»에만** 걸리기 때문에 만료를 위한 코드가 따로 없다 — 한도가 3으로 내려갈 뿐이다.
(주소가 말없이 사라지는 경험은 이미 한 번 일어났다 — 4절)

⚠️ **다시 사면 한도는 3+5=8 로 돌아온다.** 8개를 들고 있던 사람은 **한 묶음을 더 사야** 9번째를 만든다.

### 🔴 마이그레이션 — 앱이 자동 실행하지 않는다. 손으로 두 줄

```bash
cd /root/dns-controller && git pull

# 백업부터. 스키마 변경이라 존 파일 백업과 달리 되돌리기가 비싸다
mysqldump -u <user> -p <db> subdomains > /root/subdomains.bak.$(date +%F).sql

mysql -u <user> -p <db> < deploy/migrations/001-unreachable-notice.sql
mysql -u <user> -p <db> < deploy/migrations/002-subdomain-expiry.sql
```

**되돌리기**

```bash
mysql -u <user> -p <db> -e "
  ALTER TABLE subdomains DROP COLUMN unreachable_notified_at;
  ALTER TABLE subdomains DROP COLUMN renewal_notice_stage, DROP COLUMN expires_at;"
```
⚠️ 되돌릴 때는 **코드도 같이 되돌린다**(`git revert`). 앱이 이 컬럼들을 읽는다.

**002 는 백필이 핵심이다** — 기존 44개를 **`created_at` 이 아니라 «실행한 날»** 기준으로 채운다.
생성일 기준이면 2025-11 부터의 것들이 **켜는 날 한꺼번에 만료**된다. `tests/expiry.test.js` 가 이 SQL 을 읽어서
`created_at` 을 참조하지 않는지 검사한다.

확인:

```sql
SELECT owner_type, COUNT(*), MIN(expires_at), MAX(expires_at) FROM subdomains GROUP BY owner_type;
SELECT COUNT(*) FROM subdomains WHERE expires_at IS NULL;   -- 0 이어야 한다
```

### 🔴 플래그 — 셋 다 기본 «꺼짐». 이 순서로 켠다

메일이 실제로 도착하는지 **우리는 아직 모른다.** 도착 확인 전에 삭제를 켜면
**아무 연락 없이 주소를 잃는 일**이 다시 생긴다 — 이 변경 전체가 그걸 막으려고 있는 것이다.

| 플래그 | 기본 | 켜면 |
|---|---|---|
| `UNREACHABLE_NOTICE_ENABLED` | `false` | 14일째 죽어 있는 것의 소유자에게 안내 메일 |
| `RENEWAL_REMINDERS_ENABLED` | `false` | 만료 14일·3일·당일 전 갱신 메일 |
| `EXPIRY_DELETION_ENABLED` | `false` | **만료된 것 실제 삭제** ← 마지막에 켠다 |

꺼져 있는 동안에도 **잡은 매일 돌고, 무엇을 했을 «뻔»했는지 로그에 남는다**(`action:"withheld"`).

```bash
# 무엇이 나갈 뻔했는지 미리 본다 (플래그 켜기 전)
grep -E '"evt":"(renewal_reminder|expire)"' /root/.pm2/logs/server-out.log | jq -c
```

**켜는 법** — 서버의 환경변수 파일(앱이 dotenv 로 읽는 그것)에 아래 한 줄을 넣고 재시작한다.
**한 번에 하나씩.**

```
RENEWAL_REMINDERS_ENABLED=true
```
```bash
NODE_ENV=production pm2 restart server --update-env
```

메일이 실제로 도착했는지 **받은 편지함에서** 확인한다. 로그만 보고 끝내지 않는다.

```bash
grep '"evt":"email"' /root/.pm2/logs/server-out.log | jq -c
#   -> {"evt":"email","kind":"renewal_reminder","provider":"resend","fqdn":"...","ok":true,"id":"..."}
#   ok:false 면 error 필드에 발송처가 준 거절 사유가 들어 있다
#   id 는 Resend 대시보드에서 그 한 통을 찾는 값이다
```

⚠️ **메일을 켜기 전에 6절(`RESEND_API_KEY`)을 먼저 한다.** 키가 없으면 잡은 돌지만 한 통도 안 나가고
`ok:false`·`error:"RESEND_API_KEY is not set..."` 만 쌓인다.

도착을 확인한 **뒤에야** 삭제를 켠다 — 같은 파일에 아래 한 줄을 더하고 다시 재시작.

```
EXPIRY_DELETION_ENABLED=true
```

기타 환경변수 (전부 기본값 그대로 두면 된다)

| 이름 | 기본 | 뜻 |
|---|---|---|
| `UNREACHABLE_NOTICE_DAYS` | `14` | 며칠 죽어 있으면 알리나 |
| `VALIDATION_HTTP_TIMEOUT_MS` | `5000` | 검사 요청 타임아웃. **`VALIDATION_TCP_TIMEOUT_MS` 를 대체한다** (옛 이름은 이제 무시됨) |
| `PUBLIC_ORIGIN` | `https://sitey.my` | 메일 속 갱신 링크가 가리킬 주소 |
| `EXPIRY_INTERVAL_MS` | `86400000` | 만료 잡 주기 |

### 배포

```bash
export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH
cd /root/dns-controller && git pull
NODE_ENV=production pm2 restart server --update-env
```

DNS·존 파일은 **건드리지 않는다.** 되돌리기는 `git revert` + 위 DROP COLUMN.

---

## 5. 지금 죽어 있는 것들의 일회성 정리 — `cleanup-unreachable.js`

4절의 상시 규칙은 **아무것도 지우지 않는다.** 그 규칙이 물려받은 **밀린 빚**이 이 스크립트다 —
몇 달 동안 잘못된 판정 때문에 쌓인, 지금 죽어 있는 20여 개.

⚠️ **자비스가 dry-run 출력을 보고 판단한 뒤에 돌린다. 그냥 실행하지 않는다.**

```bash
export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH
cd /root/dns-controller

# 1) 지금 죽어 있는 것 목록만 (아무것도 쓰지 않는다). 44개 전부 HTTP 로 찍어보므로 1~2분 걸린다
node deploy/cleanup-unreachable.js

# 2) 누구에게 메일이 갈지 (아직 안 보낸다)
node deploy/cleanup-unreachable.js --notify

# 3) 실제 발송 + 보낸 날짜 기록
node deploy/cleanup-unreachable.js --notify --apply

# 4) 14일 뒤 — 무엇이 지워질지 (아직 안 지운다)
node deploy/cleanup-unreachable.js --purge

# 5) 목록이 납득되면 삭제
node deploy/cleanup-unreachable.js --purge --apply
```

안전장치

- **모든 모드가 dry-run 기본.** `--apply` 없이는 아무것도 쓰지 않는다
- `--purge` 는 **안내를 받은 지 14일 지난 것만** 지운다. **안내를 안 받은 것은 영원히 안 지운다**
- `--purge` 는 **다시 찍어본다.** 그 사이 살아난 것은 목록에서 빠진다
- 메일은 **한 사람에게 한 번**만 — 이미 `unreachable_notified_at` 이 있으면 건너뛴다
- 판정은 4절 판정표와 **같은 코드**를 쓴다. 여기만 다른 기준을 쓰지 않는다

📌 **3·5단계 전에 존 파일 백업**을 뜬다. 삭제는 존 파일을 고친다.

```bash
cp /etc/bind/db.sitey.my  /etc/bind/db.sitey.my.bak.$(date +%F)
cp /etc/bind/db.sitey.one /etc/bind/db.sitey.one.bak.$(date +%F)
```


---

## 6. 메일 발송처 — Resend (2026-09-08)

**발신자가 Jay 개인 Gmail 계정이었다.** 갱신 안내·도달성 안내가 전부 거기서 나갔다.
이제 **`noreply@sitey.my`** 로 나간다. **바뀐 것은 «보내는 수단» 하나뿐** — 메일 내용·발송 시점·플래그는 그대로다.

### 서버에서 할 일 — 환경변수 한 줄

```
RESEND_API_KEY=re_...
```
```bash
NODE_ENV=production pm2 restart server --update-env
```

⚠️ **키는 환경변수 파일에만 둔다.** 저장소·문서·로그·테스트 어디에도 값이 없다(코드가 로그에 안 남긴다).

| 이름 | 기본 | 뜻 |
|---|---|---|
| `RESEND_API_KEY` | 없음 | Resend API 키. **없으면 한 통도 안 나간다**(조용히 넘어가지 않고 `ok:false` + 사유를 남긴다) |
| `EMAIL_FROM` | `noreply@sitey.my` | 받는 사람에게 보이는 발신 주소 |
| `EMAIL_PROVIDER` | `resend` | `resend` 또는 `gmail`. 그 밖의 값은 **발송 거부**(오타로 엉뚱한 곳에서 나가지 않게) |

### 존에 필요한 레코드 (2026-09-08 이미 넣었다)

```
rsend              IN CNAME rsend-apne1.forge.rmta.net.
send               IN CNAME send.forge.rmta.net.
resend._domainkey  IN TXT   "p=..."
_dmarc             IN TXT   "v=DMARC1; p=none;"
```

📌 이 넷은 **DB 에 행이 없다.** 그래서 `configs/index.js` 의 `infraRecords` 에 같이 넣었다 — 안 넣으면
reconciler 가 매일 밤 「DB 에 없는 레코드」로 보고한다. **존에 손으로 넣는 레코드는 항상 그 목록도 같이 고친다.**

### 되돌리기 — Gmail 로

```
EMAIL_PROVIDER=gmail
```
```bash
NODE_ENV=production pm2 restart server --update-env
```

Gmail 경로는 지우지 않고 남겨뒀다. **`EMAIL_FROM` 을 따로 지정하지 않았다면 Gmail 은 예전처럼
자기 계정 주소로 보낸다** — Gmail API 는 인증된 계정이 아닌 발신 주소를 거부하기 때문이다.

### 확인

```bash
# 실제 발송은 자비스가 한 통 시험 발송해서 받은 편지함으로 확인한다
grep '"evt":"email"' /root/.pm2/logs/server-out.log | jq -c 'select(.provider=="resend")'
```

---

## 7. 계정별 한도와 «관찰 모드» + 402 결제 경로 (2026-09-09)

> 🔴 **여기서 바뀐 것 한 줄** — **아무도 안 막힌다.** 한도를 «세기만» 한다.
> 스위치 둘 다 기본 꺼짐이고, 켜기 전까지 동작은 지금과 똑같다.

### 왜 지금 만드나 — 매출이 아니라 «수요 측정»이다

「돈 낼 사람이 있나」에 대한 데이터가 **0** 이다. 한도를 세면 그 데이터가 생긴다.

- **아무도 안 부딪히면** → 팔 것이 없다는 뜻이다. **결제를 안 켠 것이 이득이다**
- **누가 부딪히면** → **그것이 첫 실제 수요다.** 그때 그 사람에게 맞는 통로를 붙인다

실측(2026-09-09): 보유 계정 14 / 전체 가입 38. 1개 8명 · 2개 1명 · 3개 2명 · 4개 1명 · 8개 1명 · 11개 1명.
→ **한도 3이면 넘는 계정이 3개뿐이고 그중 둘은 예외 대상이다.** 지금 진짜로 막으면 얻는 것 없이 사용자만 잃는다.

### 무엇이 세어지나

| 주체 | 세는 기준 | 한도 | 강제되나 |
|---|---|---|---|
| 로그인 사용자 · API 키 | `subdomains.user_id` | `users.subdomain_limit` → 없으면 `SUBDOMAIN_LIMIT_DEFAULT`(3) | **`SUBDOMAIN_LIMIT_ENFORCED` 가 켜져야 막는다** |
| 익명 호출(에이전트) | `owner_ip` + `owner_type='agent'` | 같은 기본값 3 | **원래부터 막고 있었고 그대로 막는다** |

- **「사람이냐 에이전트냐」로 가르지 않는다.** 11개를 회사 서비스에 물린 사람과 같은 일을 하는 에이전트는 같은 고객이고,
  한도를 다르게 두면 **싼 쪽인 척하면 그만**이 된다. API 키가 「무제한」이던 것도 이 변경으로 없어졌다.
- ⚠️ **익명 IP 한도만 예외적으로 계속 강제한다.** 이건 가격이 아니라 **인증 없는 쓰기 엔드포인트의 자물쇠**다.
  이걸 관찰로 내리면 측정이 아니라 **자물쇠를 푸는 것**이 된다. 원래 값(3)·원래 동작 그대로다.
- **이미 가진 것은 절대 안 건드린다.** 한도는 «다음 것»에만 걸린다. 조회·수정·삭제·갱신은 초과 계정도 그대로 된다.
  (말없이 주소를 잃는 경험은 이미 한 번 일어났다 — 4절)

### 예외는 «코드»가 아니라 «숫자»로 준다

```sql
UPDATE users SET subdomain_limit = 20 WHERE email = '<주소>';   -- 예외 부여
UPDATE users SET subdomain_limit = NULL WHERE email = '<주소>'; -- 되돌리기(기본값을 다시 따라간다)
```

코드에 이름·이메일을 박으면 **되돌리는 데 배포가 필요하고, 이 서비스를 남에게 넘길 수도 없다.**

### 🔴 마이그레이션 — 앱이 자동 실행하지 않는다. 손으로 두 줄

```bash
cd /root/dns-controller && git pull

mysqldump -u <user> -p <db> users > /root/users.bak.$(date +%F).sql

mysql -u <user> -p <db> < deploy/migrations/003-subdomain-limit.sql
mysql -u <user> -p <db> < deploy/migrations/004-credit-ledger.sql
```

**되돌리기**

```bash
mysql -u <user> -p <db> -e "
  ALTER TABLE users DROP COLUMN subdomain_limit;
  DROP TABLE credit_entries;"
```

- **순서에 안 걸린다.** 코드가 먼저 올라가도 되고 마이그레이션이 먼저여도 된다 —
  `services/quota.js` 는 컬럼이 없으면 **기본값으로 돌면서 로그에 한 줄** 남기고, `services/credits.js` 는 테이블이 없으면 잔액 0으로 본다.
  (손으로 도는 마이그레이션이라 **코드가 먼저 도착하는 쪽이 정상 경로**다)
- ⚠️ `credit_entries` **에 행이 하나라도 있으면 DROP 하지 마라.** 그 행들은 결제 기록이다.
  (지금은 `X402_ENABLED` 가 꺼져 있어 **한 행도 안 생긴다**)
- 📌 **`004` 파일이 바뀌었다(2026-09-09). 새 `005` 를 만들지 않았다.**
  이 테이블은 **아직 어디에도 만들어진 적이 없다** — 손으로 도는 마이그레이션이고 서버에서 실행되지 않았으며,
  `X402_ENABLED` 가 꺼져 있어 행이 생길 수도 없었다. 없는 테이블을 `ALTER` 하는 파일을 하나 더 두는 것보다
  **한 테이블을 한 파일이 설명하는 쪽**이 낫다. 혹시 어딘가에 옛 판으로 만들어둔 게 있으면 `ALTER` 한 줄이 파일 안에 적혀 있다.

### 🔴 플래그 — 둘 다 기본 «꺼짐». 그리고 둘 다 켜져야 402 가 나간다

| 플래그 | 기본 | 켜면 |
|---|---|---|
| `SUBDOMAIN_LIMIT_ENFORCED` | `false` | **한도를 넘는 «새» 발급을 실제로 거부**(403 `LIMIT_REACHED`) |
| `X402_ENABLED` | `false` | 거부 대신 **402 + 「얼마를 어디로 내라」**. 결제 증명을 가져오면 통과 |

**AND 관계다.** 관찰 모드에서는 아무도 안 막히니 **돈을 요구할 자리 자체가 없다** —
`X402_ENABLED` 만 켜면 아무 일도 일어나지 않는다.

**켜는 법** — 환경변수 파일에 한 줄 넣고 재시작. **한 번에 하나씩.**

```
SUBDOMAIN_LIMIT_ENFORCED=true
```
```bash
NODE_ENV=production pm2 restart server --update-env
```

**끄는 법** — 그 줄을 지우거나 `false` 로 바꾸고 같은 재시작. **값이 비어 있어도 꺼짐이다.**

⚠️ **웹 대시보드에는 402 가 절대 안 나간다.** 402 로 내려면 지갑이 있어야 하는데
브라우저 앞의 사람에게 「지갑부터 만드세요」는 곧 이탈이다. 402 는 `POST /api/v1/subdomains` 한 곳뿐이고,
MCP 에도 없다(JSON-RPC 결과에는 상태코드를 담을 자리가 없다).

### 🔎 관찰 모드 로그를 어떻게 세나 — 이게 이 작업의 산출물이다

한도를 넘었는데 **통과시킨** 요청은 `action:"withheld"` 로 남는다. 누가 몇 번인지 세는 명령:

```bash
grep '"evt":"quota"' /root/.pm2/logs/server-out.log | jq -r 'select(.action=="withheld") | .sub // .iph' | sort | uniq -c | sort -rn
```

- 출력이 **비어 있으면 「한도에 부딪히는 사람이 없다」** — 팔 것이 없다는 답이고, 그것도 답이다
- `sub` 는 `u:<id>`(웹 로그인) 또는 `k:<id>`(API 키). 익명은 `sub` 이 없고 `iph`(IP 해시)로 잡힌다
- **`services/access-log.js` 의 `sub`·`iph` 와 같은 형식**이라 `evt:"http"` 줄과 같이 셀 수 있다

한 줄을 통째로 보려면:

```bash
grep '"evt":"quota"' /root/.pm2/logs/server-out.log | jq -c
#   -> {"evt":"quota","scope":"account","sub":"k:7","iph":"...","held":5,"limit":3,"paid_for":0,"action":"withheld"}
#   action:"blocked"  = 실제로 거부됨 (스위치가 켜졌거나 익명 IP)
#   action:"no_column" = 마이그레이션 003 이 아직 안 돌았다는 뜻
```

⚠️ **한도 안에 있는 요청은 한 줄도 안 남긴다.** 넘은 것만 남는다.

### 결제를 실제로 켜려면 (지금은 못 켠다)

**지갑이 없다.** 아래 셋(지갑·토큰 주소 최소 1개·facilitator) 중 하나라도 비어 있으면 **기능이 꺼진 채로 있고**,
부팅 로그에 **어느 값이 없는지** 찍힌다. 조용히 통과시키지 않는다 — 그냥 403 으로 거부한다.

| 이름 | 기본 | 뜻 |
|---|---|---|
| `X402_PAY_TO` | **없음** | 받을 지갑 주소. **아직 없다** |
| `X402_USDC_ADDRESS` | **없음** | USDC 컨트랙트 주소 |
| `X402_USDT_ADDRESS` | **없음** | USDT 컨트랙트 주소 |
| `X402_FACILITATOR_URL` | **없음** | 증명 검증·정산을 맡길 곳. **서명 검증을 우리가 하지 않는다** |
| `X402_NETWORK` | `base` | 토큰이 따로 안 정하면 이 체인 |
| `X402_USDC_NETWORK` · `X402_USDT_NETWORK` | `X402_NETWORK` | 그 토큰이 올라간 체인 |
| `X402_USDC_DECIMALS` · `X402_USDT_DECIMALS` | `6` | 그 토큰의 소수점 자리 |
| `X402_TIMEOUT_MS` | `10000` | facilitator 호출 타임아웃 |

### 🔴 받는 토큰 — USDC·USDT 둘 다 «이름만» 올라가 있다

**주소가 비어 있는 토큰은 402 응답의 `accepts` 에 아예 안 들어간다.** 대신 로그에 한 줄 남는다.

```bash
grep '"action":"asset_unset"' /root/.pm2/logs/server-out.log | jq -c
#   -> {"evt":"x402","action":"asset_unset","symbol":"USDT"}
```

⚠️ **USDT 가 실제로 정산되는지는 확인되지 않았다.** 받는 토큰은 **체인·facilitator 마다 다르고 우리 것은 아직 안 봤다.**
그래서 설정에 이름은 있지만 **주소를 넣기 전까지는 「받는다」고 말하지 않는다.**
확인 없이 제시하면 상대가 낸 돈이 정산 안 되고 **그 비용을 상대가 문다.**

- 값은 `SUBDOMAIN_BUNDLE_PRICE_MICROS` 하나다. 토큰 소수점 자리가 다르면 **그 토큰 단위로 환산해서** 제시한다
  (6자리면 그대로, 18자리면 뒤에 0 이 12개). 6자리 미만이면 **올림** — 값보다 적게 요구하지 않는다.
- 결제 증명은 **자기가 어느 토큰으로 냈는지 말해야 한다.** 제시하지 않은 토큰으로 낸 것은 facilitator 에 묻기도 전에 거부된다.
  토큰이 하나뿐일 때만 안 말해도 통과한다(고를 것이 없으니까).

부팅 로그로 확인:

```bash
grep '"evt":"x402"' /root/.pm2/logs/server-out.log | jq -c
#   -> {"evt":"x402","enabled":false,"reason":"X402_ENABLED is off"}
#   켜놓고 지갑이 없으면 action:"disabled" 줄에 missing:[...] 이 같이 나온다
```

📌 **규격이 아직 움직인다(v2 가 최근이다).** 그래서 프로토콜을 아는 코드는 **`services/x402.js` 한 파일뿐**이다.
규격이 바뀌면 그 파일만 고친다. 라우트는 「무엇으로 답하나」와 「이 증명이 유효한가」 둘만 묻는다.

⚠️ **세금** — 코인으로 받아도 **사업 소득이다.** 실제 수익이 생기는 시점에 세무사 확인이 필요하다.
「매출로 안 잡는 구조」를 전제로 설계하지 않았다.

### 배포

```bash
export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH
cd /root/dns-controller && git pull
NODE_ENV=production pm2 restart server --update-env
```

DNS·존 파일·네임서버·Caddy 는 **건드리지 않았다.** 되돌리기는 `git revert` + 위 DROP.
