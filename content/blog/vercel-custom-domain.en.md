---
title: How to put a free custom subdomain on a Vercel deployment
slug: vercel-custom-domain
description: Give a Vercel project an address like myapp.sitey.my without buying a domain. One API call to claim the name, the CNAME value to use, the TXT record Vercel asks for, and the commands that confirm it is live.
date: 2026-09-14
---

You deployed to Vercel and the only address you have is `myapp-git-main-abc123.vercel.app`. This is how to give it `myapp.sitey.my` instead: no domain purchase, no account, one HTTP call to claim the name and a couple of minutes of DNS.

If you are an agent doing this for someone, the whole flow is four requests. The machine-readable version of everything below is at [/llms.txt](/llms.txt) and [/openapi.json](/openapi.json).

## The order: claim the name first, then tell Vercel

Vercel wants the DNS record to exist before it will serve anything at the name, and sitey will create a record whose target is not answering yet. So the order is:

1. Claim `myapp.sitey.my` on sitey as a CNAME.
2. Add `myapp.sitey.my` to the Vercel project.
3. If Vercel shows a different CNAME value, point the record at that.
4. If Vercel asks for a TXT record, add it.

The response to step 1 will say `reachable: false`. That is expected, not an error: the name resolves, and Vercel does not know about it yet.

## 1. Claim the name

One request, no account, no key:

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"CNAME","value":"cname.vercel-dns.com"}'
```

The response is `201` with the record and an `owner_token`:

```json
{
  "success": true,
  "data": {
    "fqdn": "myapp.sitey.my",
    "type": "CNAME",
    "value": "cname.vercel-dns.com",
    "expires_at": "2026-10-16T02:11:40.000Z",
    "reachable": false,
    "note": "...",
    "owner_token": "anon_…",
    "owner_token_note": "Save this now. It is shown once …"
  }
}
```

**Save the `owner_token`.** It is returned once, only its hash is stored, and every later change to this record needs it. Send it back as `Authorization: Bearer anon_…`.

A `409` with code `SUBDOMAIN_TAKEN` means somebody has the name; pick another. `GET /api/v1/check/myapp/sitey.my` tells you in advance.

## 2. Add the domain in Vercel

In the Vercel project: **Settings → Domains → Add**, enter `myapp.sitey.my`.

Vercel then shows the CNAME value it wants. For newer projects it is project-specific and looks like this:

```
d1d4fc829fe7bc7c.vercel-dns-017.com
```

Older guides say `cname.vercel-dns.com`. Use **whatever the Vercel screen shows**; copying the value from a different project is the most common way this setup fails.

## 3. Point the record at Vercel's value

If the value Vercel showed is not the one you used in step 1, change it:

```bash
curl -X PATCH https://sitey.my/api/v1/subdomains/myapp/sitey.my \
  -H 'authorization: Bearer anon_…' \
  -H 'content-type: application/json' \
  -d '{"value":"d1d4fc829fe7bc7c.vercel-dns-017.com"}'
```

The record type stays CNAME; only the target moves.

## 4. If Vercel asks for a TXT record, that is normal

Vercel may show something like:

```
_vercel   TXT   vc-domain-verify=myapp.sitey.my,abc123…
```

Vercel's documentation says why:

> If the domain is in use by another Vercel account, you will need to verify access to the domain, with a TXT record.

`sitey.my` is one domain shared by many people, so from the second Vercel user onward this is the default path, not an edge case. Add the value exactly as shown:

```bash
curl -X POST https://sitey.my/api/v1/subdomains/myapp/sitey.my/txt \
  -H 'authorization: Bearer anon_…' \
  -H 'content-type: application/json' \
  -d '{"host_prefix":"_vercel","value":"vc-domain-verify=myapp.sitey.my,abc123…"}'
```

The record is written at `_vercel.sitey.my`, which is where Vercel looks for it. Other people's verification values sit next to yours on the same name; nothing is overwritten. `_vercel` is the only prefix accepted here.

## 5. Confirm it is live

Ask sitey's own nameserver, which skips every cache in between:

```bash
dig +short @ns1.sitey.my myapp.sitey.my CNAME
```

Then ask the resolver you actually use, and the site itself:

```bash
dig +short myapp.sitey.my CNAME
curl -sI https://myapp.sitey.my | head -1
```

The first `dig` is right the moment the API answered. The second can lag by the TTL of whatever your resolver cached, usually minutes. The `curl` returns `200` once Vercel has issued the certificate, which it does on its own a few minutes after the CNAME is seen.

## Doing the same thing from an agent

If the agent runtime speaks MCP, connect it once:

```bash
claude mcp add --transport http sitey https://sitey.my/mcp
```

and step 1 is a `create_subdomain` tool call with the same four fields (`subdomain`, `domain`, `type`, `value`). The result carries `owner_token`; pass it back as the `owner_token` argument to `update_subdomain` and `create_txt_record` for steps 3 and 4.

## When it does not work

- **"Invalid Configuration" in Vercel.** The CNAME value is not the one Vercel showed for this project. Compare, then `PATCH`.
- **TXT added but verification still pending.** Resolver caching. `dig +short @ns1.sitey.my _vercel.sitey.my TXT` shows your value immediately; Vercel's check will catch up within minutes.
- **You want `sitey.my` itself.** Not available. sitey lends subdomains only.

The longer list is in [When your subdomain does not connect](/blog/when-your-subdomain-does-not-connect).

## The lease

A name created without an account is lent for one month, with an account for three. Every response carries `expires_at`, and `POST /api/v1/subdomains/myapp/sitey.my/renew` extends it once you are inside the last 14 days. Renewing measures from today, so it cannot be stacked up in advance.
