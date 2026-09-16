---
title: What sitey is, and what it is not
slug: about-sitey
description: A free subdomain for anything you have deployed, without buying a domain. What sitey does, what it refuses to do, how long a name is lent, and who runs it.
date: 2026-09-14
---

sitey gives you an address without buying a domain. You take a name like `myapp.sitey.my`, free, and point it at whatever you have built.

## Who it is for

Most things get built before they have an address.

- A side project on Vercel whose only URL is `xxx-git-main-abc123.vercel.app`
- A prototype that is not worth a domain purchase yet
- A demo that needs a link for a week
- An agent that just deployed something and was asked to "put a proper address on it"

A name is enough for all of these. Buying a domain and setting up DNS for each one is not. sitey fills that gap.

## What it does

- **A and CNAME records** send the name to an IP address or another hostname.
- **TXT records** hold the ownership proof a host such as Vercel asks for.
- **A website and an API, both.** Click through the dashboard, or call [`/api/v1`](/openapi.json) from code.
- **Agents can use it.** Over [MCP](/blog/mcp-support), an agent creates and manages the record itself. No account, no key: the first create returns an owner token.

## What it does not do

Written down so nobody has to find out later.

- **It does not sell domains.** Only subdomains, and only lent.
- **It does not host anything.** Deploy elsewhere; take the address from here.
- **It does not give out the root.** `sitey.my` itself is not available.

## A name is lent, not given

A name nobody uses, kept forever, is a name nobody else can have. So every record has a lease.

- Created with an account: **3 months**
- Created without one: **1 month**

Account holders get a reminder email with a renew button. Records made without an account carry `expires_at` in every API response instead, and one call renews them. Renewal opens 14 days before the date.

A name whose target stops answering is **not** removed. It is counted every night and left alone. Not renewing is the only thing that removes a record.

## You can claim the name before you deploy

sitey creates the record even when nothing is answering at the target yet. The response says `reachable: false` and that is all. Claim the address first, deploy to it second; that is the order both people and agents usually need.

## Who runs it

One person. It was built for personal use, opened up, and is now used by a few dozen people and their agents.

Contact: `ljj5256@gmail.com`
