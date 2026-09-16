---
title: A free custom subdomain for GitHub Pages
slug: github-pages-custom-subdomain
description: Put myapp.sitey.my on a GitHub Pages site instead of username.github.io. The CNAME value GitHub wants, the one call that creates it, where to enter the domain on GitHub, and how to confirm it before switching on HTTPS.
date: 2026-09-16
---

GitHub Pages serves your site at `username.github.io` or `username.github.io/repo`. You can give it `myapp.sitey.my` instead, for free, in three steps: one API call on sitey, one field on GitHub, one checkbox once the certificate exists.

The machine-readable version of the sitey side is at [/llms.txt](/llms.txt) and [/openapi.json](/openapi.json).

## What GitHub wants from DNS

For a **subdomain** custom domain, GitHub asks for a single CNAME record pointing at your GitHub Pages hostname:

```
myapp.sitey.my   CNAME   username.github.io
```

The target is always `username.github.io` (or `orgname.github.io` for an organization), **not** `username.github.io/repo` and not the repository name. The repository is selected on GitHub's side, by the CNAME file it writes into the publishing source.

## 1. Create the record on sitey

No account and no key needed:

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"CNAME","value":"username.github.io"}'
```

The response is `201`. It will say `reachable: false` if GitHub does not know the domain yet, which is expected at this point and changes nothing. It also carries an `owner_token`; **save it**. It is shown once and is the only way to change or delete this record later, sent back as `Authorization: Bearer anon_…`.

If the name is taken you get `409 SUBDOMAIN_TAKEN`. `GET /api/v1/check/myapp/sitey.my` tells you beforehand.

## 2. Tell GitHub the domain

In the repository: **Settings → Pages → Custom domain**, enter `myapp.sitey.my`, **Save**.

GitHub commits a file named `CNAME` containing the domain to your publishing branch. If you deploy with an action that rebuilds the site from scratch, make sure that file survives the build, or set the domain in the action's configuration instead. A vanished `CNAME` file is the usual reason a Pages custom domain "stops working" after a deploy.

GitHub then runs a DNS check against the domain. It passes once it sees the CNAME above.

## 3. Confirm, then switch on HTTPS

Ask sitey's nameserver, then a public resolver:

```bash
dig +short @ns1.sitey.my myapp.sitey.my CNAME
dig +short myapp.sitey.my CNAME
```

Both should print `username.github.io.`. The first is right immediately; the second may lag by a few minutes of caching.

Once GitHub's check passes it requests a certificate for the domain. When the **Enforce HTTPS** checkbox on the Pages settings page becomes available, tick it. GitHub says this can take up to a day; it is usually minutes.

```bash
curl -sI https://myapp.sitey.my | head -1
```

`200` means you are done.

## Domain verification on GitHub is not available here

GitHub offers an optional "verified domain" step that asks for a TXT record named `_github-pages-challenge-username`. sitey accepts only the `_vercel` prefix for TXT records, so that step cannot be completed for a sitey subdomain. It is optional: Pages serves the custom domain without it. What verification adds is a guard against someone else claiming the domain on GitHub if you ever release it, and the lease on a sitey name covers that case in its own way: when the lease ends the name is free for anyone, so delete the domain from the repository first if you let a name go.

## The lease

A name created without an account is lent for one month, with an account for three. `expires_at` is in every API response, and `POST /api/v1/subdomains/myapp/sitey.my/renew` extends it once you are inside the last 14 days. If you keep the site, keep the name renewed; if you drop the name, remove it from the Pages settings too.

## If it does not work

- **GitHub says "DNS check unsuccessful".** The first `dig` above is empty or shows the wrong value. Re-check the create call; the value must be `username.github.io`.
- **404 from GitHub at the custom domain.** The `CNAME` file is missing from the published output, or the domain was entered on a different repository.
- **Certificate error.** Wait for the HTTPS checkbox; do not enforce HTTPS before it is available.

The general checklist is in [When your subdomain does not connect](/blog/when-your-subdomain-does-not-connect).
