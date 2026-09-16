---
title: 가입 없이 HTTP 호출 한 번으로 받는 무료 서브도메인
slug: free-subdomain-without-signup
description: 계정도 이메일도 미리 받을 API 키도 없이 myapp.sitey.my 같은 주소를 받는 법. 그 요청 하나, 돌아오는 소유 토큰, 그 뒤에 할 수 있는 호출 전부.
date: 2026-09-16
---

무료 서브도메인 서비스는 대개 계정부터 만들라고 해요. sitey는 아니에요. 이름과 가리킬 곳을 담은 요청 하나를 보내면 응답에 레코드와 그 레코드의 열쇠가 같이 옵니다. 사람이 보내든 에이전트가 보내든 같아요. 영어 원문에 호출이 전부 있고 여기서는 흐름만 적습니다.

## 호출 하나

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"A","value":"203.0.113.10"}'
```

응답이 돌아온 순간 `myapp.sitey.my`는 sitey 네임서버에서 바로 풀려요. 호스팅이 IP 대신 호스트명을 준다면 `"type":"CNAME"`으로 보내세요.

## 소유 토큰이 곧 계정

계정이 없으니 누구 것인지 말해줄 게 필요하고, 그게 응답의 `owner_token`이에요. 첫 호출이 만들어서 한 번만 돌려주고, 해시만 저장하기 때문에 다시 조회할 수 없어요. 그 뒤 모든 호출에 `Authorization: Bearer anon_…`으로 돌려보냅니다.

- **토큰을 잃으면 그 레코드는 기간이 끝날 때까지 못 건드려요.** 같은 IP로도 안 돼요. 같은 회사·통신사 NAT 뒤의 남이 내 레코드에 손대지 못하게 하는 방법이 이거예요
- **토큰 하나로 여러 개를 가질 수 있어요.** 다음 생성에도 같이 보내면 같은 토큰 소유가 돼요

계정 아래에 두고 싶으면 사이트에서 로그인해 API 키(`styo_…`)를 만드세요. 한도가 더 큰 건 아니고, 로그인할 수 있는 무언가에 붙는 것뿐이에요.

## 만들기 전에 — 비어 있나

`GET /api/v1/check/myapp/sitey.my`. 있는 이름은 `409 SUBDOMAIN_TAKEN`, 규칙에 안 맞거나 예약어면 `400`. [이름 규칙](/blog/how-to-pick-a-subdomain-name)은 짧아요.

## 그 뒤에 할 수 있는 것

전부 `Authorization: Bearer anon_…` 헤더를 붙여요.

- **내 것 보기** — `GET /api/v1/subdomains`
- **다른 곳 가리키기** — `PATCH /api/v1/subdomains/myapp/sitey.my` (`value`만 바뀌고 타입은 못 바꿔요)
- **TXT 넣기** — `POST …/txt`, 접두사는 `_vercel`만
- **기간 늘리기** — `POST …/renew`. 만료 14일 전부터, 그 전엔 `409 RENEWAL_NOT_DUE`와 함께 언제부터 되는지 알려줘요
- **돌려주기** — `DELETE /api/v1/subdomains/myapp/sitey.my`

## MCP로도 같은 흐름

`https://sitey.my/mcp`를 연결하고 `create_subdomain`을 부르면 결과에 `owner_token`이 실려 와요. MCP에서는 헤더가 아니라 다음 도구 호출의 `owner_token` **인자**로 돌려보냅니다. POST 하나에 JSON-RPC 호출 여러 개가 실릴 수 있어서 호출별 헤더 자리가 없거든요. 도구 아홉 개는 [MCP 글](/blog/mcp-support)에 있어요.

## 「무료」에 딸려 오는 것

- 주인당 **5개**
- 계정 없이 **1개월**, 계정으로 3개월. 갱신은 호출 하나이고, 그 외의 이유로 지워지지 않아요
- 익명 생성 분당 3회, 주소당 분당 100요청
- A·CNAME만, A는 IPv4만. TXT는 `_vercel`만
- 이름은 검사하지만 가리키는 곳이 떠 있을 필요는 없어요. `reachable: false`는 「잡았고 아직 아무것도 안 뜬다」예요

이 숫자들은 실제 설정에서 [/llms.txt](/llms.txt)로 만들어져요. 바뀌면 그 파일이 먼저 바뀝니다.
