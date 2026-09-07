# deploy — 서버 적용 절차

이 디렉토리의 파일은 **저장소에만 있고 서버에는 아직 반영되지 않았다.**
아래 절차를 서버(`139.59.126.52`)에서 직접 실행해야 적용된다.

| 파일 | 용도 |
|---|---|
| `dns-controller.service` | 앱을 systemd 서비스로 올린다 (재부팅·크래시 자동 복구) |

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
