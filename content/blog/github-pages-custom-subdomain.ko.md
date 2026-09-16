---
title: GitHub Pages에 무료 서브도메인 붙이기
slug: github-pages-custom-subdomain
description: username.github.io 대신 myapp.sitey.my를 GitHub Pages 사이트에 붙이는 법. GitHub이 원하는 CNAME 값, 만드는 호출 하나, GitHub에서 입력할 자리, HTTPS 켜기 전 확인법.
date: 2026-09-16
---

GitHub Pages 사이트에 `myapp.sitey.my`를 무료로 붙이는 방법이에요. sitey 호출 하나, GitHub 입력칸 하나, 인증서가 나온 뒤 체크박스 하나. 영어 원문에 명령이 전부 있고 여기서는 요점만 적습니다.

## GitHub이 DNS에 원하는 것

서브도메인이면 CNAME 하나예요.

```
myapp.sitey.my   CNAME   username.github.io
```

값은 항상 `username.github.io`(조직이면 `orgname.github.io`)예요. 저장소 이름이나 `/repo`는 안 들어가요. 어느 저장소인지는 GitHub이 배포 브랜치에 써넣는 `CNAME` 파일로 정해집니다.

## 1. sitey에서 레코드 만들기

계정도 키도 없이:

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"CNAME","value":"username.github.io"}'
```

응답의 `reachable: false`는 GitHub이 아직 도메인을 모른다는 뜻이고 이 단계에선 당연해요. `owner_token`은 **저장하세요.** 한 번만 보여주고, 나중에 고치거나 지울 유일한 열쇠예요.

## 2. GitHub에 도메인 알리기

저장소 **Settings → Pages → Custom domain**에 `myapp.sitey.my` 입력 → Save.

GitHub이 배포 브랜치에 `CNAME` 파일을 커밋해요. 액션으로 매번 새로 빌드한다면 그 파일이 살아남는지 확인하세요. 배포 뒤 커스텀 도메인이 「갑자기 안 되는」 이유의 대부분이 이 파일이 사라진 거예요.

## 3. 확인하고 HTTPS 켜기

```bash
dig +short @ns1.sitey.my myapp.sitey.my CNAME
dig +short myapp.sitey.my CNAME
```

둘 다 `username.github.io.`가 나와야 해요. GitHub 검사가 통과하면 인증서를 요청하고, Pages 설정의 **Enforce HTTPS**가 켤 수 있게 되면 체크하세요. 보통 몇 분이에요.

## GitHub 도메인 인증은 여기선 안 돼요

GitHub의 선택 기능인 「verified domain」은 `_github-pages-challenge-username`이라는 TXT를 요구하는데, sitey는 TXT 접두사로 `_vercel`만 받아요. 그래서 그 단계는 못 합니다. 선택이라 Pages는 인증 없이도 동작해요. 대신 이름을 놓을 때는 Pages 설정에서 도메인을 먼저 지우세요. 기간이 끝나면 누구나 그 이름을 가질 수 있어요.

## 기간

계정 없이 1개월, 계정으로 3개월. `expires_at`이 응답마다 실려 오고, 만료 14일 전부터 `renew`로 늘릴 수 있어요.

## 안 될 때

- **「DNS check unsuccessful」** → 첫 dig가 비었거나 값이 틀린 거예요. `username.github.io`인지 확인
- **커스텀 도메인에서 GitHub 404** → `CNAME` 파일이 배포물에 없거나 다른 저장소에 입력한 것
- **인증서 오류** → HTTPS 체크박스가 켤 수 있게 될 때까지 기다리세요

일반 점검 목록은 [서브도메인이 안 열릴 때](/blog/when-your-subdomain-does-not-connect)에 있어요.
