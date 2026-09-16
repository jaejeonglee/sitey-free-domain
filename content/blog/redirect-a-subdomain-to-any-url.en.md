---
title: Give a link an address — redirect a subdomain to any URL, no server needed
slug: redirect-a-subdomain-to-any-url
description: How to make myapp.sitey.my send every visitor to a URL you choose with a 301 — a GitHub repo, a form, a profile — using a REDIRECT record. One request, no server of your own, the rules the target has to meet, and how to change it later.
date: 2026-09-16
---

A and CNAME records need something at the other end: a server with an IP, or a host that gives you a hostname. Plenty of things you might want an address for have neither. A GitHub repository. A Google Form. A Linktree, a Notion page, a Calendly. They already have a URL; what they do not have is a short name of your own in front of it.

That is what a `REDIRECT` record is for. You claim `myapp.sitey.my` and give it a URL. Every visit to the name is answered with a `301 Moved Permanently` to that URL. The browser goes there. Nothing of yours is running anywhere.

## The one call

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"REDIRECT","value":"https://github.com/you/myapp"}'
```

```json
{
  "success": true,
  "data": {
    "fqdn": "myapp.sitey.my",
    "type": "REDIRECT",
    "value": "https://github.com/you/myapp",
    "expires_at": "2026-10-16T08:30:12.000Z",
    "reachable": true,
    "owner_token": "anon_3f9c…",
    "owner_token_note": "Save this now. It is shown once and cannot be looked up again …"
  }
}
```

From that moment `https://myapp.sitey.my` — any path under it — answers `301` with `Location: https://github.com/you/myapp`. The same call works from the dashboard (pick *Redirect (URL)* as the type) and over MCP (`create_subdomain` with `"type": "REDIRECT"`).

`reachable` here means something slightly different from the other two types: it says whether the *destination* answered with a page. A target that returns 404 is written all the same, with `reachable: false`, so you can point at something you are about to publish.

## What the target has to be

Three rules, and the API names each refusal so you can act on it:

- **An absolute `https://` URL.** `http://` is refused (`400 INVALID_REDIRECT_URL`) — a name of ours would otherwise be handing every visitor an unencrypted hop. So is anything that is not a URL, and anything over 2048 characters.
- **Not one of ours.** A target under `sitey.my`, `sitey.one`, `officials.my` or `officials.one` is refused (`400 REDIRECT_LOOP`). Two such records could send a browser round until it gave up.
- **The path and query travel with it.** `https://github.com/you/myapp?tab=readme` is kept exactly; the visitor lands there.

The URL is stored as the WHATWG parser writes it back — lower-cased host, percent-encoded path — which is what goes in the `Location` header.

## How it works, in one paragraph

DNS has no redirect record. In the zone, `myapp.sitey.my` is an ordinary A record pointing at sitey's own server. The URL lives only in the database. When a browser arrives, the server reads the `Host` header, looks up the REDIRECT record under that name, and answers `301` with `Cache-Control: no-store`. The `no-store` is what makes the next section true.

## Changing it, keeping it, giving it back

All of these carry the `Authorization: Bearer anon_…` header from the create (or your API key).

**Point it somewhere else** — live on the next visit, nothing cached:

```bash
curl -X PATCH https://sitey.my/api/v1/subdomains/myapp/sitey.my \
  -H 'authorization: Bearer anon_3f9c…' -H 'content-type: application/json' \
  -d '{"value":"https://github.com/you/myapp/releases"}'
```

The type cannot change: a REDIRECT stays a REDIRECT. To turn the name into an A or CNAME, delete it and create it again.

**Keep it** — `POST …/renew`, which opens 14 days before `expires_at`. **Give it back** — `DELETE /api/v1/subdomains/myapp/sitey.my`.

## What is the same as every other record

The limit (five per owner), the lease (one month without an account, three with one), the renewal window and the TXT rules apply to a REDIRECT exactly as to an A or CNAME. It is one of your five. Those numbers are read from the running configuration into [/llms.txt](/llms.txt); the full reference, including the two error codes above, is [/openapi.json](/openapi.json).
