---
title: Vercel에 무료 서브도메인 붙이기
slug: vercel-custom-domain
description: sitey에서 받은 주소를 Vercel 프로젝트에 붙이는 법. CNAME과 TXT를 왜 둘 다 요구하는지, 배포 전에 미리 주소를 잡아두는 법까지.
date: 2026-09-14
---

Vercel에 올린 사이트에 `myapp.sitey.my` 같은 주소를 붙이는 방법이에요. 5분이면 됩니다.

## 먼저 — 순서를 뒤집어도 됩니다

보통은 배포부터 하고 도메인을 붙이죠. 그런데 **주소를 먼저 잡아두고 나중에 배포해도 됩니다.**

sitey는 가리키는 곳이 아직 아무것도 응답하지 않아도 주소를 만들어줘요. 응답에 `reachable: false`라고 알려주기만 합니다. 이름을 먼저 확보하고 천천히 만드셔도 된다는 뜻이에요.

## 1. sitey에서 주소 만들기

sitey.my에 접속해 원하는 이름을 검색하고, 비어 있으면 만듭니다. 로그인 없이도 됩니다.

이 단계에서 **CNAME**을 고르고, 값은 일단 `cname.vercel-dns.com`을 넣으세요. 정확한 값은 다음 단계에서 Vercel이 알려줍니다.

## 2. Vercel에 도메인 추가하기

Vercel 프로젝트에서 **Settings → Domains → Add Domain**으로 들어가 방금 만든 주소를 넣습니다.

그러면 Vercel이 **CNAME 값**을 알려줘요. 요즘은 프로젝트마다 다른 값을 줍니다.

```
d1d4fc829fe7bc7c.vercel-dns-017.com
```

이런 모양이면 그게 맞습니다. 예전 글에 나오는 `cname.vercel-dns.com`이 아니어도 놀라지 마세요. **화면에 나온 값을 그대로** 쓰시면 됩니다.

## 3. CNAME 값 바꾸기

sitey 대시보드에서 아까 만든 주소의 값을 Vercel이 준 값으로 바꿉니다.

여기까지 하면 보통 몇 분 안에 연결됩니다.

## 4. TXT를 요구하면 — 정상입니다

Vercel이 이런 걸 요구할 때가 있어요.

```
_vercel   TXT   vc-domain-verify=myapp.sitey.my,abc123...
```

**이건 오류가 아니라 정상 절차입니다.**

Vercel 공식 문서에 이렇게 적혀 있어요.

> If the domain is in use by another Vercel account, you will need to verify access to the domain, with a TXT record.

즉 **그 도메인을 이미 다른 Vercel 계정이 쓰고 있으면** 소유 확인을 한 번 더 받습니다.

sitey는 `sitey.my` 하나를 여러 사람이 나눠 쓰는 서비스예요. 그러니 **두 번째 사용자부터는 언제나 이 상황**입니다. 특이한 경우가 아니라 기본 경로예요.

### 넣는 법

sitey 대시보드에서 그 주소의 TXT 추가를 누르고, Vercel이 준 값을 그대로 붙여넣으면 됩니다. 앞의 `_vercel`은 자동으로 붙습니다.

남의 값을 덮어쓰지 않으니 안심하세요. 같은 자리에 여러 사람의 확인 값이 나란히 쌓이게 돼 있습니다.

## 잘 안 될 때

**「Invalid Configuration」이 뜬다**

CNAME 값이 Vercel이 준 것과 다를 가능성이 큽니다. 다른 프로젝트의 값을 복사해 오면 안 돼요.

**TXT를 넣었는데 확인이 안 된다**

DNS가 퍼지는 데 시간이 걸립니다. 몇 분 기다렸다 다시 눌러보세요.

**apex 도메인을 붙이고 싶다**

`sitey.my` 자체는 발급 대상이 아닙니다. sitey는 서브도메인만 드려요.

## 정리

1. sitey에서 이름 만들기 — 배포 전에 해도 됩니다
2. Vercel에 도메인 추가 → CNAME 값 받기
3. sitey에서 그 값으로 바꾸기
4. TXT를 요구하면 그대로 넣기
