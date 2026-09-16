---
title: A free subdomain with no signup, in one HTTP call
slug: free-subdomain-without-signup
description: How to get an address like myapp.sitey.my with no account, no email, no API key to fetch first. The one request that does it, the owner token it returns, and every call you might make after that.
date: 2026-09-16
---

Most free subdomain services want an account before they give you anything. sitey does not. You send one request with the name and where it should point, and the response contains the record and the key to it. Nothing to sign up for, nothing to fetch first, and it works the same whether a person or an agent is sending it.

This page is that flow, complete. The same thing in the form an agent reads is at [/llms.txt](/llms.txt); the full reference is [/openapi.json](/openapi.json).

## The one call

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"A","value":"203.0.113.10"}'
```

```json
{
  "success": true,
  "data": {
    "fqdn": "myapp.sitey.my",
    "type": "A",
    "value": "203.0.113.10",
    "expires_at": "2026-10-16T02:11:40.000Z",
    "reachable": true,
    "owner_token": "anon_3f9c…",
    "owner_token_note": "Save this now. It is shown once and cannot be looked up again …"
  }
}
```

`myapp.sitey.my` now resolves to `203.0.113.10`, served by sitey's own nameservers from the moment this returns. For a host that gives you a hostname instead of an IP, send `"type":"CNAME"` and the hostname as `value`.

## The owner token is the account

There is no account, so something has to say who owns the record. That is the `owner_token`. It is minted by this first call and returned once; only its hash is stored, so it cannot be looked up again. Every later call about the record sends it back:

```
Authorization: Bearer anon_3f9c…
```

Two consequences, both deliberate:

- **Lose the token and the record is frozen** until its lease ends. Not even the same IP address can touch it. That is what keeps another caller behind the same office or carrier NAT out of your records.
- **One token can hold several records.** Send it on the next create too, and the new record belongs to the same token. Leave it off and you get a fresh token for a separate record.

If you would rather have records under an account, sign in on the site and make an API key (`styo_…`). It is not a larger allowance; it is the same limit, attached to something you can log in to.

## Before you create: is the name free

```bash
curl https://sitey.my/api/v1/check/myapp/sitey.my
```

`available: true` or `false`. Creating a taken name returns `409 SUBDOMAIN_TAKEN`; an invalid or reserved one returns `400` with `INVALID_SUBDOMAIN` or `BLACKLISTED`. [The naming rules](/blog/how-to-pick-a-subdomain-name) are short.

## Everything you can do afterwards

All of these carry the `Authorization: Bearer anon_…` header.

**See what you hold**

```bash
curl https://sitey.my/api/v1/subdomains -H 'authorization: Bearer anon_3f9c…'
```

**Point it somewhere else**

```bash
curl -X PATCH https://sitey.my/api/v1/subdomains/myapp/sitey.my \
  -H 'authorization: Bearer anon_3f9c…' -H 'content-type: application/json' \
  -d '{"value":"203.0.113.11"}'
```

The type cannot change, only the value.

**Add the TXT record a host asks for** (Vercel does; [why](/blog/vercel-custom-domain))

```bash
curl -X POST https://sitey.my/api/v1/subdomains/myapp/sitey.my/txt \
  -H 'authorization: Bearer anon_3f9c…' -H 'content-type: application/json' \
  -d '{"host_prefix":"_vercel","value":"vc-domain-verify=myapp.sitey.my,abc123…"}'
```

**Keep it**

```bash
curl -X POST https://sitey.my/api/v1/subdomains/myapp/sitey.my/renew \
  -H 'authorization: Bearer anon_3f9c…'
```

Opens 14 days before `expires_at`; earlier returns `409 RENEWAL_NOT_DUE` with the date to come back on.

**Give it back**

```bash
curl -X DELETE https://sitey.my/api/v1/subdomains/myapp/sitey.my \
  -H 'authorization: Bearer anon_3f9c…'
```

## The same flow over MCP

Connect the endpoint once (`claude mcp add --transport http sitey https://sitey.my/mcp`, or the URL `https://sitey.my/mcp` in any MCP client) and the first call is:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_subdomain",
    "arguments": { "subdomain": "myapp", "domain": "sitey.my", "type": "A", "value": "203.0.113.10" }
  }
}
```

The result carries `owner_token`. Over MCP it goes back as the `owner_token` **argument** on later tool calls rather than as a header, because one HTTP POST can carry several JSON-RPC calls and there is no per-call header to put it in. The nine tools are listed in [the MCP post](/blog/mcp-support).

## What "free" comes with

- **Five subdomains per owner** (per token, per address for records made before tokens existed, or per account).
- **A lease of one month** for a record made without an account, three with one. Renewal is one call, and nothing is removed for any other reason: a target that goes dark is counted, not deleted.
- **Three creates a minute** per anonymous caller, 100 requests a minute per address.
- **A and CNAME only**, IPv4 for A. TXT only under `_vercel`.
- **The name is checked, the target is not required to be up.** `reachable: false` in the response means "claimed, nothing serving yet", which is the normal order: address first, deploy second.

Those numbers are read from the running configuration into [/llms.txt](/llms.txt), so if they ever change, that file changes with them and this post may not.
