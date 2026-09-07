# deploy — 서버 적용 절차

이 디렉토리의 파일은 **저장소에만 있고 서버에는 아직 반영되지 않았다.**
아래 절차를 서버(`139.59.126.52`)에서 직접 실행해야 적용된다.

| 파일 | 용도 |
|---|---|
| ~~`dns-controller.service`~~ | ⛔ **쓰지 않는다.** 이 서버는 **PM2** 로 운영한다(2026-09-07 Jay 결정). 참고용으로만 남긴다 — 1절 |
| `caddy-canonical.snippet` | `sitey.one`·`www.*` → `sitey.my` 301 리다이렉트 |
| `migrate-vercel-txt.js` | 덮어쓰기로 사라진 TXT 값을 DB 기준으로 복구 + `--prune-orphans` 로 주인 없는 줄 정리 (둘 다 dry-run 기본) |

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
