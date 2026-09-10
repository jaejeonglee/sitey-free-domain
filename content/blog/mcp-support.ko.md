---
title: AI 에이전트가 서브도메인을 만들 수 있게 되었어요 (MCP 지원)
slug: mcp-support
description: sitey가 MCP를 지원합니다. Claude, Cursor 같은 AI 에이전트가 서브도메인을 직접 만들고 관리할 수 있어요.
date: 2026-04-15
---

이제 AI 에이전트가 sitey에서 서브도메인을 직접 만들고 관리할 수 있어요.

## MCP가 뭔가요

MCP(Model Context Protocol)는 AI 에이전트를 외부 서비스에 연결하는 표준입니다. Anthropic이 만들었고 Claude, Cursor, Windsurf 같은 도구가 지원해요.

에이전트에게 "서브도메인 하나 만들어줘"라고 말하면 에이전트가 sitey에 직접 만든다는 뜻이에요.

## 왜 만들었나요

에이전트가 코드를 쓰고, 빌드하고, 배포까지 합니다. 그런데 도메인만은 사람이 콘솔을 열어 손으로 넣어야 했어요. 그 한 칸을 없앤 것입니다.

## 연결하기

Claude Code는 터미널에서 한 줄이면 됩니다.

```bash
claude mcp add --transport http sitey https://sitey.my/mcp
```

Claude Desktop은 설정 파일에 넣으세요.

```json
{
  "mcpServers": {
    "sitey": {
      "url": "https://sitey.my/mcp"
    }
  }
}
```

Cursor는 Settings → MCP → Add Server 에서 URL 칸에 `https://sitey.my/mcp` 를 넣으면 됩니다.

## 시켜보기

연결한 뒤에는 이렇게 말하면 돼요.

- demo.sitey.my 를 1.2.3.4 로 연결해줘
- 내 서브도메인 목록 보여줘
- demo.sitey.my 를 5.6.7.8 로 바꿔줘
- demo.sitey.my 지워줘
- demo.sitey.my 를 Vercel 에 연결해줘

마지막 줄은 CNAME 과 TXT 두 개가 필요한 일인데, 에이전트가 두 단계를 이어서 처리합니다.

## 쓸 수 있는 도구

| 도구 | 하는 일 |
|---|---|
| `list_domains` | 발급 가능한 루트 도메인 목록 |
| `check_availability` | 이 이름을 쓸 수 있는지 확인 |
| `create_subdomain` | A 또는 CNAME 레코드 생성 |
| `list_subdomains` | 내가 만든 서브도메인 목록 |
| `renew_subdomain` | 만료 전에 기한 연장 |
| `update_subdomain` | 레코드 값 변경 |
| `delete_subdomain` | 서브도메인 삭제 |
| `create_txt_record` | TXT 레코드 생성 (Vercel 등 소유권 인증용) |
| `delete_txt_record` | TXT 레코드 삭제 |

## 기한이 있습니다

서브도메인은 드리는 게 아니라 빌려드리는 것이라 기한이 있어요. **에이전트가 만든 것은 한 달, 사람이 만든 것은 세 달**입니다.

에이전트에게는 만료 안내 메일이 가지 않습니다. `list_subdomains` 의 `expires_at` 을 읽고 그 전에 `renew_subdomain` 을 부르세요. 한 번 부르면 그날부터 다시 셉니다.

## 한도

가입 여부와 상관없이 **5개까지 무료**예요. 가입하지 않으면 IP를 기준으로, 가입하면 계정을 기준으로 셉니다.

가입하면 대시보드에서 한자리에 모아 보고 고칠 수 있어요.

admin, www, ns1 처럼 쓰면 안 되는 이름은 막혀 있습니다.

## 기술 정보

- 전송 방식 — MCP Streamable HTTP
- 엔드포인트 — `https://sitey.my/mcp`
- 디스커버리 — `https://sitey.my/.well-known/mcp.json`
- DNS 반영 — 즉시 (자체 BIND9 네임서버를 운영합니다)

질문이나 제안은 [텔레그램 커뮤니티](https://t.me/+yvrIFDbssJ0wNDJl)로 주세요.
