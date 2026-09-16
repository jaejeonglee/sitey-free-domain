---
title: 통과되는 서브도메인 이름 고르는 법
slug: how-to-pick-a-subdomain-name
description: sitey 서브도메인 이름이 통과하려면 지켜야 하는 규칙. 실제 검사 코드에서 그대로 옮겼어요. 길이·문자·하이픈·예약어·차단 키워드, 그리고 이미 있는 이름이면 어떻게 되는지.
date: 2026-09-16
---

`무엇.sitey.my`를 만들기 전에, 「무엇」 자리에 들어갈 수 있는 것을 정리했어요. 서버가 실제로 돌리는 검사를 순서대로 옮긴 것이라 여기서 통과하면 거기서도 통과합니다.

확인은 요청 하나, 계정 없이 됩니다.

```bash
curl https://sitey.my/api/v1/check/myapp/sitey.my
```

MCP에서는 `check_availability` 도구예요.

## 1. 모양 — DNS 라벨 하나

```
^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

- **소문자·숫자·하이픈만.** 밑줄·점·공백·한글 안 돼요
- **1~63자**
- **하이픈으로 시작하거나 끝나면 안 돼요.** `-app`·`app-`는 거절, `my-app`은 통과
- **대문자는 소문자로 바뀝니다.** `MyApp`은 `myapp`으로 만들어져요
- **라벨 하나만.** `api.myapp`은 점 때문에 두 라벨이라 거절

어기면 `400 INVALID_SUBDOMAIN`.

## 2. 예약어

도메인 자체나 메일에 쓰이는 이름이라 막혀 있어요.

```
admin  www  mail  ftp  ns1  ns2  api  mx  smtp  pop  imap  webmail
_dmarc  _acme-challenge  autoconfig  autodiscover
```

`400 BLACKLISTED`, 「This subdomain name is reserved.」

## 3. 차단 키워드

이 단어가 **어디든 포함되면** 거절이에요.

```
paypal  google-login  facebook-auth  bank  secure-login  signin  account-verify
```

부분 일치라 `mybank`·`bankroll`도 `bank`와 함께 막힙니다. 피싱 때문이에요. 누구에게나 `paypal-secure.sitey.my`를 내주는 도메인은 그 용도로 쓰이고, 루트 전체가 차단 목록에 오릅니다.

## 4. 이미 있는 이름

존 파일과 DB 두 곳을 다 보고, 둘 다 없을 때만 비어 있는 거예요. 있는 이름을 만들면 `409 SUBDOMAIN_TAKEN`.

주인이 지우거나 기간(계정 없이 1개월, 계정으로 3개월)이 끝나면 다시 비어요. 대기열이나 예약은 없습니다.

## 그럼 뭘 고르나

강제는 아니지만:

- **짧고 읽을 수 있게.** `blog`·`demo-3`·`jays-portfolio`
- **하이픈은 하나면 충분.** `my-cool-new-app-v2`는 되긴 하는데 아무도 못 외워요
- **시스템 이름처럼 보이는 건 피하기.** `login`·`auth`·`cdn`은 되지만 헷갈려요
- **에이전트가 고른다면** 먼저 check를 부르고, `SUBDOMAIN_TAKEN`이면 같은 이름을 재시도하지 말고 `myapp-2`처럼 접미사를 붙이게 하세요

## 한도

주인 하나(계정·토큰·주소)당 5개예요. 지금 한도와 넘었을 때 거절인지 기록만인지는 [/llms.txt](/llms.txt)에 실제 설정에서 만들어져 적혀 있어요.
