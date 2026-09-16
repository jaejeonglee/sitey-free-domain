---
title: Let your AI agent create a subdomain (MCP support)
slug: mcp-support
description: sitey speaks MCP. Claude Code, Claude Desktop, Cursor and any other MCP client can claim a free subdomain, point it at a deployment, add a TXT record and renew it, with no account and no key to fetch first.
date: 2026-04-15
---

Agents write the code, build it and deploy it. Until now the address was the one step a person still had to do by hand in a DNS console. sitey removes that step: an agent can claim `demo.sitey.my`, point it somewhere, and manage it later, over MCP or plain REST.

## What MCP is, in one paragraph

Model Context Protocol is the standard for connecting an AI agent to an outside service. Anthropic published it; Claude, Cursor, Windsurf and most agent runtimes implement it. Once sitey is connected, "give this deployment an address" becomes something the agent can just do.

## Connect it

Claude Code, one line:

```bash
claude mcp add --transport http sitey https://sitey.my/mcp
```

Claude Desktop, in the config file:

```json
{
  "mcpServers": {
    "sitey": {
      "url": "https://sitey.my/mcp"
    }
  }
}
```

Cursor: **Settings → MCP → Add Server**, URL `https://sitey.my/mcp`.

The manifest an agent runtime reads is at [/.well-known/mcp.json](/.well-known/mcp.json). The plain-text introduction is [/llms.txt](/llms.txt).

## Nothing to sign up for

Call with no key and no header at all. The first `create_subdomain` result carries an `owner_token`, once:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_subdomain",
    "arguments": {
      "subdomain": "demo",
      "domain": "sitey.my",
      "type": "A",
      "value": "203.0.113.10"
    }
  }
}
```

Keep that token. Pass it back as the `owner_token` argument on every later call about the record. It is shown once, only its hash is stored, and without it the record cannot be changed or deleted from any address. That is deliberate: it is what keeps another caller behind the same network out of your records.

An API key from the dashboard (`Authorization: Bearer styo_…`) puts records under an account instead. It is not a bigger allowance; both hold the same number.

## Things you can say to the agent

- Point demo.sitey.my at 1.2.3.4
- List my subdomains
- Move demo.sitey.my to 5.6.7.8
- Delete demo.sitey.my
- Connect demo.sitey.my to my Vercel project

The last one is a CNAME plus a TXT record, and the agent chains the two calls. The exact steps are in [the Vercel guide](/blog/vercel-custom-domain).

## The nine tools

| Tool | What it does |
|---|---|
| `list_domains` | The roots you may create under |
| `check_availability` | Is this name free |
| `create_subdomain` | Create an A or CNAME record |
| `list_subdomains` | What this caller holds |
| `update_subdomain` | Change the value a record points at |
| `delete_subdomain` | Give the name back |
| `renew_subdomain` | Extend the lease |
| `create_txt_record` | Add a TXT record (Vercel verification) |
| `delete_txt_record` | Remove it |

They are the same nine operations as the REST API at `/api/v1`, documented in [/openapi.json](/openapi.json).

## Names are lent

A record created without an account is lent for one month; with an account, three. No mail goes to an agent, because there is no address to send it to, so the expiry date rides along in every response as `expires_at`. Read it, and call `renew_subdomain` inside the last 14 days. Renewing measures from today, not from the old date.

## Limits

Five subdomains per owner, whether that owner is a token, an address or an account. Anonymous creates are limited to three a minute per caller, and everything is limited to 100 requests a minute per address.

Names such as `admin`, `www` and `ns1` are reserved. [How to pick a subdomain name](/blog/how-to-pick-a-subdomain-name) has the full rules.

## Technical notes

- Transport: MCP Streamable HTTP, stateless. One POST per JSON-RPC message; `GET /mcp` answers 405.
- Endpoint: `https://sitey.my/mcp`
- Discovery: `https://sitey.my/.well-known/mcp.json`
- DNS: served by our own BIND9 nameservers, so a new record is answered the moment the call returns.

Questions and suggestions: the [Telegram group](https://t.me/+yvrIFDbssJ0wNDJl).
