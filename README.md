# sitey.my

Free subdomain service for developers. Get a subdomain in seconds — no credit card, no hassle.

## Features

- **Instant DNS** — A, CNAME, and TXT records, live in seconds
- **Google sign-in** — No passwords to manage
- **REST API** — Programmatic access via /api/v1/
- **Auto-cleanup** — Unreachable subdomains are removed after two warnings
- **Free** — No cost, no catch

## Quick Start

1. Visit [sitey.my](https://sitey.my)
2. Sign in with Google
3. Type a subdomain + IP address → done

## REST API

Programmatic access for developers and AI agents.

**Base URL:** `https://sitey.my/api/v1`

`sitey.one` and the `www.` hosts redirect here (308 for `/api/*`, so POST bodies survive).

### Authentication

| Mode | Auth | Limit |
|------|------|-------|
| Anonymous | None (IP-based) | 3 subdomains |
| API key | `Authorization: Bearer styo_xxx` | Unlimited |

Get an API key: sign in at sitey.my → Dashboard → API Keys.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /domains | List available root domains |
| GET | /check/:subdomain/:domain | Check availability |
| POST | /subdomains | Create A or CNAME record |
| GET | /subdomains | List your subdomains |
| PATCH | /subdomains/:sub/:domain | Update record value |
| DELETE | /subdomains/:sub/:domain | Delete subdomain |
| POST | /subdomains/:sub/:domain/txt | Create/update TXT record |
| DELETE | /subdomains/:sub/:domain/txt/:prefix | Delete TXT record |

### Example

```bash
# Check availability
curl https://sitey.my/api/v1/check/demo/sitey.my

# Create subdomain
curl -X POST https://sitey.my/api/v1/subdomains \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"demo","domain":"sitey.my","type":"A","value":"1.2.3.4"}'
```

### For AI Agents (MCP)

AI agents can use [free-domain-mcp](https://github.com/jaejeonglee/free-domain-mcp) — an MCP server that wraps this REST API.

```bash
claude mcp add --transport http sitey https://your-mcp-server/mcp
```

## Tech Stack

- **Runtime**: Node.js + Fastify
- **DNS**: Self-hosted BIND9 (authoritative nameserver)
- **Database**: MySQL
- **Auth**: Google OAuth2 + JWT

## How It Works

1. User (or API call) requests a subdomain
2. Server validates input + checks availability
3. A/CNAME/TXT record is appended to the BIND9 zone file
4. `named-checkzone` validates → `systemctl reload named` applies
5. DNS is live within seconds

We run our own authoritative nameservers (`ns1.sitey.one`, `ns2.sitey.one`) — no third-party DNS provider.

## Use Cases

- Deploy a side project to `myapp.sitey.my`
- Give hackathon demos a real URL
- Automate domain setup via REST API or MCP
- Share staging environments with teammates

## Support

- ☕ [Buy me a coffee](https://www.buymeacoffee.com/helpmeup)
- 💬 [Telegram community](https://t.me/+yvrIFDbssJ0wNDJl)

## License

[ISC](LICENSE)
