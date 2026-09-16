---
title: 링크에 주소 붙이기 — 서버 없이 서브도메인을 아무 URL로 넘기기
slug: redirect-a-subdomain-to-any-url
description: myapp.sitey.my로 온 방문자를 내가 고른 URL로 301 넘기는 법. 깃허브 저장소·설문 폼·프로필 페이지처럼 이미 URL이 있는 것에 내 이름을 붙이는 REDIRECT 레코드. 호출 하나, 서버 불필요, 목적지 규칙, 나중에 바꾸는 법.
date: 2026-09-16
---

A·CNAME 레코드는 반대편에 뭔가가 있어야 해요. IP가 있는 서버든, 호스트명을 주는 호스팅이든. 그런데 주소를 붙이고 싶은 것 중엔 둘 다 없는 게 많아요. 깃허브 저장소, 구글 폼, 링크트리, 노션 페이지, 캘린들리. 이미 URL은 있는데 내 이름으로 된 짧은 주소가 없을 뿐이죠.

`REDIRECT` 레코드가 그걸 해요. `myapp.sitey.my`를 잡고 URL을 주면, 그 이름으로 오는 모든 방문을 `301`로 그 URL에 넘깁니다. 내 것은 아무 데서도 돌지 않아요. 영어 원문에 호출이 전부 있고 여기서는 흐름만 적습니다.

## 호출 하나

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"REDIRECT","value":"https://github.com/you/myapp"}'
```

응답이 돌아온 순간부터 `https://myapp.sitey.my`는 (어느 경로로 오든) `301` + `Location: https://github.com/you/myapp`으로 답해요. 대시보드에서는 종류를 «Redirect (URL)»로 고르면 되고, MCP에서는 `create_subdomain`에 `"type": "REDIRECT"`을 넣으면 돼요.

`reachable`은 다른 두 종류와 뜻이 조금 달라요. 「목적지가 페이지로 답했나」예요. 404가 나는 목적지도 `reachable: false`와 함께 그대로 만들어지니, 곧 공개할 것을 미리 가리켜 둘 수 있어요.

## 목적지 규칙

세 가지고, 거절할 때 코드로 이유를 말해줘요.

- **`https://`로 시작하는 절대 URL.** `http://`는 거절(`400 INVALID_REDIRECT_URL`). 우리 이름이 방문자에게 암호화 안 된 경유지를 쥐여주는 셈이라서요. URL이 아닌 것, 2048자를 넘는 것도 같은 코드.
- **우리 도메인은 안 돼요.** `sitey.my`·`sitey.one`·`officials.my`·`officials.one` 아래를 가리키면 거절(`400 REDIRECT_LOOP`). 그런 레코드 둘이면 브라우저가 빙빙 돌아요.
- **경로와 쿼리는 그대로 따라가요.** `…/myapp?tab=readme`면 방문자가 딱 거기 떨어져요.

## 어떻게 되는 건가

DNS에 리다이렉트 레코드는 없어요. 존 파일에서 `myapp.sitey.my`는 sitey 서버를 가리키는 평범한 A 레코드예요. URL은 DB에만 있어요. 브라우저가 오면 서버가 `Host` 헤더를 읽고 그 이름의 REDIRECT 레코드를 찾아 `301`로 답해요. `Cache-Control: no-store`라 값을 바꾸면 다음 방문부터 바로 반영돼요.

## 바꾸기·지키기·돌려주기

전부 생성 때 받은 `Authorization: Bearer anon_…`(또는 API 키)을 붙여요.

- **다른 곳으로** — `PATCH /api/v1/subdomains/myapp/sitey.my`에 `value`만. 종류는 못 바꿔요. A나 CNAME으로 바꾸려면 지우고 다시 만드세요
- **기간 늘리기** — `POST …/renew`. 만료 14일 전부터
- **돌려주기** — `DELETE /api/v1/subdomains/myapp/sitey.my`

## 다른 레코드와 같은 것

한도(주인당 5개), 기간(계정 없이 1개월·계정으로 3개월), 갱신 창, TXT 규칙 전부 A·CNAME과 똑같이 적용돼요. 5개 중 하나예요. 숫자는 실제 설정에서 [/llms.txt](/llms.txt)로 만들어지고, 위 오류 코드 둘을 포함한 전체 명세는 [/openapi.json](/openapi.json)에 있어요.
