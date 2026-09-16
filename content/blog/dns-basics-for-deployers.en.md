---
title: DNS basics for people who just deployed something
slug: dns-basics-for-deployers
description: A, CNAME and TXT records, TTL and propagation, explained by what they mean for the person who has a deployment and wants an address on it. No history, no theory beyond what you need to debug your own setup.
date: 2026-09-16
---

You have a deployment. It has an ugly URL. You want `myapp.sitey.my` on it. Between those two sits DNS, and you need about four ideas from it. This is those four.

## A name is a question, and the answer has a type

When a browser opens `myapp.sitey.my`, it asks the DNS system "what is myapp.sitey.my?" The answer is a **record**, and the record has a type that says what kind of answer it is. Three types matter to you.

### A record: "it is this IP address"

```
myapp.sitey.my   A   203.0.113.10
```

Use an A record when you have a server with a fixed IPv4 address: a VPS, a home box behind a port forward, a cloud VM. The browser connects straight to that address.

sitey accepts an IPv4 address here and nothing else. IPv6 is not offered.

### CNAME record: "it is the same as that other name"

```
myapp.sitey.my   CNAME   d1d4fc829fe7bc7c.vercel-dns-017.com
```

Use a CNAME when a host runs your site and gives you a hostname rather than an IP: Vercel, Netlify, GitHub Pages, Render, Fly, a load balancer. The browser resolves the other name and connects to whatever it points at, which lets the host move its servers without you changing anything.

Two rules that come from the protocol, not from sitey:

- A CNAME cannot point at itself, and sitey refuses the attempt.
- The host at the other end has to know your name. A CNAME sends the connection over; it does not introduce you. The host still needs `myapp.sitey.my` added in its own settings, or it will answer with a 404 or a certificate error. This is the single most common "DNS is broken" report, and DNS is fine.

### TXT record: "here is some text, for whoever asked"

```
_vercel.sitey.my   TXT   "vc-domain-verify=myapp.sitey.my,abc123…"
```

A TXT record carries a string. Hosts use it to make you prove you control a name: they hand you a token, you publish it in DNS, they read it back. Vercel does this when a domain is already in use by another Vercel account, which on a shared root such as `sitey.my` is most of the time.

Where the record goes matters. Vercel looks for it at the root, `_vercel.sitey.my`, not under your subdomain, so that is where sitey writes it. Many people's values sit on that one name together; yours is appended, never overwriting anyone's.

## TTL: how long an answer may be remembered

Every record carries a **time to live**, in seconds. A resolver that has asked once may reuse the answer for that long without asking again. This is why DNS is fast and also why a change is not instant.

What it means for you:

- **A new name shows up quickly.** Nobody had cached "no such name" for long, if at all.
- **A changed name can lag.** Resolvers that already hold the old answer keep serving it until their copy expires. Minutes, usually; longer if the old TTL was long.
- **You cannot flush someone else's cache.** You can only confirm the source is right and wait.

## Propagation: there is no propagation

The word suggests your record slowly spreads across the internet. It does not. The record lives in one place, sitey's nameservers, and is correct there the instant the API returns. Everything else is caches expiring at their own pace. "Propagation delay" is TTL, seen from the outside.

That gives you a clean way to debug:

```bash
dig +short @ns1.sitey.my myapp.sitey.my     # the source. Right immediately, or the record is wrong
dig +short @1.1.1.1 myapp.sitey.my          # a public resolver. Right once its cache turns over
dig +short myapp.sitey.my                   # your resolver. Same, plus your OS cache
```

If the first line is right and the others are not, wait. If the first line is wrong or empty, the record is wrong or missing, and waiting will not help.

## Reachable is not the same as resolving

Resolving means the name has an answer. Reachable means something at that answer serves a page. A name can resolve to a server that is off, or to a host that has not been told about it. DNS has done its job either way.

sitey tells you the difference when you create a record: the response carries `reachable`, and `false` means "the name resolves, nothing is answering yet." That is the normal state when you claim a name before you deploy, and nothing is refused or rolled back because of it.

## The address, in one call

If you have read this far you know enough to do it:

```bash
curl -X POST https://sitey.my/api/v1/subdomains \
  -H 'content-type: application/json' \
  -d '{"subdomain":"myapp","domain":"sitey.my","type":"A","value":"203.0.113.10"}'
```

Swap `type` for `CNAME` and `value` for the hostname your host gave you if that is what you have. The response carries an `owner_token`; save it, it is the only key to the record and it is shown once. The rest of the API, including TXT records and renewal, is at [/openapi.json](/openapi.json), and the short version an agent reads is [/llms.txt](/llms.txt).

## Vocabulary you will meet

- **Zone:** the file, or database, that holds every record under a domain. `sitey.my` is one zone; your subdomain is a line in it.
- **Nameserver:** the server that answers questions about a zone. sitey runs its own (`ns1.sitey.my`, `ns2.sitey.my`).
- **Resolver:** the server your computer asks. It asks nameservers on your behalf and caches what it learns.
- **Apex, or root:** the domain with nothing in front of it, `sitey.my`. sitey does not give this out, and a CNAME cannot be placed there anyway.
- **Label:** one dot-separated piece of a name. Your subdomain is exactly one label, which is why it cannot contain a dot.
