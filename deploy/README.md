# deploy — 서버 적용 절차

이 디렉토리의 파일은 **저장소에만 있고 서버에는 아직 반영되지 않았다.**
아래 절차를 서버(`139.59.126.52`)에서 직접 실행해야 적용된다.

| 파일 | 용도 |
|---|---|
| `dns-controller.service` | 앱을 systemd 서비스로 올린다 (재부팅·크래시 자동 복구) |
| `caddy-canonical.snippet` | `sitey.one`·`www.*` → `sitey.my` 301 리다이렉트 |
| `migrate-vercel-txt.js` | apex TXT → `<prefix>.<서브도메인>` 이관 (dry-run 기본) |

> 🔴 **이 저장소의 보안 수정 중 «TXT 이름 분리»는 PSL 등재 전에 배포하면 안 된다.**
> 아래 3절을 먼저 읽을 것. 나머지 수정과 systemd 유닛은 지금 적용해도 된다.

---

## 1. systemd 유닛 설치

### 왜 필요한가

지금 앱은 `node /root/dns-controller/server.js` 로 **프로세스 관리자 없이** 떠 있다
(2026-09-07 실측: 프로세스 52일째, systemd 유닛·pm2·`@reboot` cron 전부 없음).

- 앱이 죽으면 **아무도 살리지 않는다.**
- 재부팅하면 **서비스가 아예 뜨지 않는다.** sitey.my·sitey.one 에 물린 서브도메인 전부(jay.sitey.my 포함)가 멈춘다.
- 앱 로그 파일이 없다. journald 로 올리면 자동으로 받는다.

### 사전 확인

```bash
# node 실제 경로 — /usr/bin/node 가 아니면 유닛의 ExecStart 를 고쳐야 한다
command -v node

# 지금 떠 있는 프로세스 확인 (pid 를 적어둔다)
ps -o pid=,etime=,args= -C node | grep dns-controller

# 앱이 쓰는 외부 명령이 systemd 기본 PATH 안에 있는지
# (systemd 서비스 PATH = /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
command -v named-checkconf named-checkzone systemctl
```

⚠️ `command -v node` 결과가 `/usr/bin/node` 가 아니면 **유닛 파일의 `ExecStart` 를 그 경로로 고친 뒤** 진행한다.
(launchd 든 systemd 든 «맨 이름으로 부르면 못 찾는다»는 함정은 똑같다.)

### 설치

```bash
# 1) 저장소를 최신으로
cd /root/dns-controller && git pull

# 2) 유닛 배치
cp /root/dns-controller/deploy/dns-controller.service /etc/systemd/system/dns-controller.service
systemctl daemon-reload

# 3) 기존 맨손 프로세스 종료 (여기서 수 초간 API 가 끊긴다 — DNS 응답은 named 가 하므로 영향 없음)
kill <위에서 확인한 pid>
sleep 2
pgrep -af "dns-controller/server.js" || echo "정리됨"

# 4) 서비스로 기동 + 부팅 시 자동 시작 등록
systemctl enable --now dns-controller
```

📌 **3번에서 끊기는 것은 웹/API 뿐이다.** DNS 응답은 `named` 가 별도 프로세스로 계속 처리하므로
사용자 서브도메인은 이 작업 중에도 정상 동작한다.

### 검증 (이걸 통과해야 끝난 것)

```bash
# 서비스 상태 — active (running) 이어야 한다
systemctl status dns-controller --no-pager

# 부팅 자동 시작 등록 확인 — enabled 여야 한다
systemctl is-enabled dns-controller

# 로그가 journald 로 들어오는지
journalctl -u dns-controller -n 30 --no-pager

# 앱이 실제로 응답하는지 (managed_domains 목록이 나와야 한다)
curl -sS http://127.0.0.1:3000/api/managed-domains

# 밖에서도 살아 있는지
curl -sSI https://sitey.my/ | head -1

# 자동 복구가 실제로 도는지 — 죽여보고 5초 뒤 되살아나는지 확인
systemctl kill -s SIGKILL dns-controller
sleep 8
systemctl status dns-controller --no-pager | head -5   # active (running), 재시작 흔적
```

### 되돌리기

```bash
systemctl disable --now dns-controller
cd /root/dns-controller && nohup node server.js > /dev/null 2>&1 &
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
   - ③ `systemctl restart dns-controller`
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

## 3. 🔴 TXT 이름 분리 — PSL 등재 전에는 배포 금지

보안 수정 3번으로 TXT 레코드 이름 규칙이 `<prefix>`(도메인 apex 공유) →
**`<prefix>.<서브도메인>`** 으로 통일됐다. 근거는 `.claude/docs/decisions/0001-txt-record-naming.md`.

### 왜 지금 배포하면 안 되는가

Vercel 은 «등록 도메인» 기준으로 `_vercel` TXT 를 요구한다.
`sitey.my`·`sitey.one` 이 **Public Suffix List 에 없으므로** Vercel 은 `demo.sitey.my` 를
등록 도메인 `sitey.my` 의 하위로 보고 **apex 의 `_vercel.sitey.my`** 를 요구한다.

지금 배포하면 앱이 더 이상 apex 에 쓰지 않으므로 **Vercel 인증이 전원 불가**가 된다.
2026-09-07 실측 기준 TXT 28건이 **100% `_vercel`** 이다.

### 배포 순서 (이 순서를 지킨다)

1. `sitey.my` · `sitey.one` 을 **Public Suffix List 에 등재** (https://github.com/publicsuffix/list)
2. 등재가 Vercel 쪽에 반영됐는지 **서브도메인 하나로 실제 검증 성공**을 확인
3. 그 다음에 이 변경을 배포 (`git pull` → `systemctl restart dns-controller`)
4. 아래 마이그레이션 실행
5. apex 에 남은 옛 `_vercel` 줄은 **한동안 그대로 둔다** (기존 검증이 그걸 보고 있다)

### 마이그레이션

DB 에는 사용자별 토큰이 각각 보존돼 있다. 스크립트가 그걸 기준으로
각자의 TXT 를 자기 이름 자리에 복원한다.

```bash
cd /root/dns-controller

# 1) 계획만 본다 (아무것도 쓰지 않는다)
node deploy/migrate-vercel-txt.js

# 2) 출력이 납득되면 적용
node deploy/migrate-vercel-txt.js --apply

# 3) 검증
dig +short TXT _vercel.<서브도메인>.sitey.my @127.0.0.1
named-checkzone sitey.my /etc/bind/db.sitey.my
```

⚠️ 스크립트는 **apex 에 남아 있는 옛 줄을 지우지 않는다.** 보고만 한다.
그 줄이 누구 것인지(운영자가 손으로 넣은 것일 수도 있다) 확인한 뒤 사람이 판단해서 지운다.

### 그때까지 다른 수정만 먼저 배포하려면

나머지 다섯 건(입력 검증·신뢰 프록시·`/mcp` 레이트리밋·zone 원자적 쓰기·보상 플래그)은
PSL 과 무관하게 지금 적용해도 된다. 다만 같은 커밋에 묶여 있으므로
**분리해서 배포하려면 알려줄 것** — apex 쓰기를 유지하는 별도 커밋을 만들어 준다.
