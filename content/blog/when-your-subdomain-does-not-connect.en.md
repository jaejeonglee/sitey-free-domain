---
title: My subdomain does not connect. What to check, in order
slug: when-your-subdomain-does-not-connect
description: A sitey subdomain that does not open is almost always one of six things. How to tell which with two dig commands and one curl, what sitey checks every night on its side, and what it will never do about it.
date: 2026-09-16
---

You created `myapp.sitey.my`, pointed it at your deployment, and the browser shows an error or the old page. Work down this list; each step takes a minute and names the next one.

For a record you created over the API, every check here can be run by an agent. The API reference is at [/openapi.json](/openapi.json) and the short version at [/llms.txt](/llms.txt).

## First, find out which side is wrong

Two questions decide everything: does the name resolve, and does the target answer.

```bash
dig +short @ns1.sitey.my myapp.sitey.my
dig +short myapp.sitey.my
curl -sI https://myapp.sitey.my | head -1
```

- **The first `dig` is empty.** The record is not on sitey. Go to "The record is not there".
- **The first answers, the second is empty or different.** Caching. Go to "Your resolver is behind".
- **Both answer, `curl` fails or shows the wrong thing.** DNS is fine; the target is the problem. Go to "The target does not know the name".

`@ns1.sitey.my` asks sitey's own nameserver, which skips every cache in between and reflects the record as it was the moment the API returned.

## The record is not there

Three ways this happens.

**It was never created.** A `409 SUBDOMAIN_TAKEN`, a `400 INVALID_SUBDOMAIN`, or a `400 BLACKLISTED` means the request was refused and nothing was written. The error body says which. [How to pick a subdomain name](/blog/how-to-pick-a-subdomain-name) lists the rules.

**The lease ended.** A record without an account is lent for one month, with an account for three. `GET /api/v1/subdomains` shows `expires_at` for everything you hold. Renewal opens 14 days before that date; after it, the name is free for anyone.

**It was removed by hand.** If you deleted it, or an agent holding your owner token did, it is gone and the name is free again.

Nothing else removes a record. In particular, a target that stops answering does not. More on that below.

## Your resolver is behind

DNS answers are cached for the record's TTL. A brand-new record is not in any cache, so it appears fast; a **changed** record can keep showing the old value until the cache expires, usually a few minutes.

You cannot speed that up from sitey's side. What you can do is confirm the record is right at the source and wait:

```bash
dig +short @ns1.sitey.my myapp.sitey.my CNAME
```

If that shows the new value, it is done, and everyone will see it once their cache turns over. Asking a public resolver such as `@1.1.1.1` is a second opinion.

## The target does not know the name

This is the most common case for CNAME records, and it is not a DNS problem.

A CNAME sends the browser to your host, and the host looks at the `Host` header to decide which site to serve. If your host has not been told about `myapp.sitey.my`, it serves a 404, a default page, or a certificate error. The fix is on the host:

- **Vercel:** Settings → Domains → Add `myapp.sitey.my`. Vercel then shows the CNAME value to use, and may ask for a `_vercel` TXT record. The full walk-through is [here](/blog/vercel-custom-domain).
- **GitHub Pages:** Settings → Pages → Custom domain. [Guide](/blog/github-pages-custom-subdomain).
- **Your own server:** the web server config must answer for that hostname, and the certificate must include it.

A certificate error a few minutes after adding the domain is normal; hosts issue the certificate after they first see the CNAME resolve.

## The CNAME value is wrong

Vercel and similar hosts show a **project-specific** CNAME target, such as `d1d4fc829fe7bc7c.vercel-dns-017.com`. A value copied from a guide, or from another project, resolves but goes nowhere useful. Compare what the host shows with what sitey has:

```bash
dig +short @ns1.sitey.my myapp.sitey.my CNAME
```

and if they differ, move it:

```bash
curl -X PATCH https://sitey.my/api/v1/subdomains/myapp/sitey.my \
  -H 'authorization: Bearer anon_…' \
  -H 'content-type: application/json' \
  -d '{"value":"d1d4fc829fe7bc7c.vercel-dns-017.com"}'
```

## The TXT record is not being seen

Hosts that ask for ownership proof look for it at the **root**: `_vercel.sitey.my`, not `_vercel.myapp.sitey.my`. sitey writes it there, next to everyone else's values on the same name. Check it the same way:

```bash
dig +short @ns1.sitey.my _vercel.sitey.my TXT
```

Your value should be one of the lines. If it is, the host's check catches up within minutes.

## What sitey checks on its side, and what it does not do

Every record's target is probed once a night with an HTTP request that carries the subdomain as `Host` and SNI, which is how a CDN routes it. Any answer, including 401, 403 and 404, counts as alive; 502, 503, 504 and a connection failure count as dark. The number of consecutive dark days is kept per record.

**Nothing is removed for being dark.** That is a rule with a date on it. Until 2026-09-08, two failed nightly checks in a row removed the record, which meant that a deployment down for 48 hours lost its name, and a record created without an account lost it silently. That morning it happened to three of the operator's own subdomains, and the rule was replaced the same day. Now the count is kept, and a record whose owner has an email address can be sent a single notice after 14 dark days; a record with no account attached is left alone entirely. The only thing that removes a record is not renewing it.

The create call runs the same probe once, and tells you the answer as `reachable` in the response. `false` is not a failure and nothing was rolled back. It means the name resolves and nothing is serving at it yet, which is what you expect when the name is claimed before the deploy.

## A note on the one case that was ours

In September 2026, an audit of the zone found that 25 of 28 TXT verification values were missing. Each new Vercel verification had overwritten the previous one on the shared `_vercel` name, so only the last person to verify still passed. The write is now an append, deletion matches on the stored value, and a nightly reconciliation compares the zone to the database line by line and alerts on any drift. If you verified a domain with Vercel before that date and it stopped passing, adding the TXT record again fixes it.

## Still stuck

Send the name and what the three commands at the top print to the [Telegram group](https://t.me/+yvrIFDbssJ0wNDJl). The output tells us which side to look at.
