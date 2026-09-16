---
title: How to pick a subdomain name that will be accepted
slug: how-to-pick-a-subdomain-name
description: The exact rules a sitey subdomain name has to pass, taken from the code that checks it. Length, characters, hyphens, reserved words, blocked keywords, and what happens when the name is already taken.
date: 2026-09-16
---

Before you claim `something.sitey.my`, this is what "something" has to look like. The rules below are the ones the server runs, in the order it runs them, so a name that passes here passes there.

The check is one request, and it does not need an account:

```bash
curl https://sitey.my/api/v1/check/myapp/sitey.my
```

```json
{ "success": true, "data": { "available": true, "subdomain": "myapp", "domain": "sitey.my", "fqdn": "myapp.sitey.my" } }
```

Over MCP the same thing is the `check_availability` tool. The full API is at [/openapi.json](/openapi.json), the short version at [/llms.txt](/llms.txt).

## 1. Shape: the name is one DNS label

The pattern is:

```
^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

In words:

- **Lowercase letters, digits and hyphens.** Nothing else: no underscore, no dot, no space, no Unicode.
- **1 to 63 characters.** A one-character name is fine.
- **Cannot start or end with a hyphen.** `-app` and `app-` are refused; `my-app` is fine.
- **Uppercase is lowered first**, so `MyApp` becomes `myapp` and is accepted as that. Do not rely on the case surviving; it will not.
- **One label only.** `api.myapp` is refused, because a dot makes it two labels and the name has to be the part directly under `sitey.my`.

A name that fails this comes back as `400` with code `INVALID_SUBDOMAIN`.

## 2. Reserved names

These are refused outright because they mean something to the domain itself or to mail:

```
admin  www  mail  ftp  ns1  ns2  api  mx  smtp  pop  imap  webmail
_dmarc  _acme-challenge  autoconfig  autodiscover
```

The answer is `400` with code `BLACKLISTED` and the message "This subdomain name is reserved."

## 3. Blocked keywords

A name that **contains** any of these, anywhere in it, is refused:

```
paypal  google-login  facebook-auth  bank  secure-login  signin  account-verify
```

This is a substring match, so `mybank` and `bankroll` are both refused along with `bank`. The reason is phishing: a shared domain that hands out `paypal-secure.sitey.my` to anyone will be used for exactly that, and the whole root gets blocklisted for it. The answer is `400 BLACKLISTED` with "This subdomain name is blocked by security policy."

## 4. Is it taken

Availability is checked in two places, the DNS zone and the database, and the name is free only if it is absent from both. Creating a name that exists returns `409` with code `SUBDOMAIN_TAKEN`. The check endpoint above tells you in advance.

A taken name becomes free again when its owner deletes it or lets the lease run out: one month for a record created without an account, three months with one. There is no waiting list and no way to reserve a name that someone else holds.

## What to pick, then

Practical advice, none of it enforced:

- **Short and pronounceable.** You will type it and say it. `blog`, `demo-3`, `jays-portfolio` all work.
- **Hyphens are fine, but one is plenty.** `my-cool-new-app-v2` is legal and nobody will remember it.
- **Avoid things that look like a system name** even when they are not on the reserved list: `login`, `auth`, `cdn`. They are allowed; they just confuse people.
- **Do not lean on case or Unicode.** Both are gone by the time the record is written.
- **If an agent is choosing,** have it call the check first and fall back to a suffix (`myapp-2`) on `SUBDOMAIN_TAKEN` rather than retrying the same name.

## The limit

Each owner holds up to five subdomains, whether the owner is an account, an owner token, or an address. The current allowance, and whether going over is refused or only recorded, is always stated in [/llms.txt](/llms.txt), which is generated from the running configuration.
