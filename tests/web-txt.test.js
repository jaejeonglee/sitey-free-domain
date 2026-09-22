import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const Fastify = require2("fastify");
const domainRoutes = require2("../routes/domain.js");
const bindMod = require2("../services/bind.js");

// ---------------------------------------------------------------------------
// The browser's TXT route, POST /api/subdomains/:subdomain/txt.
//
// It wrote `_vercel` and nothing else, because `_vercel` was the only name a
// TXT record could have. Now the caller may ask for "@" — the subdomain's own
// name — and that is the one case DNS can refuse: nothing may share a name
// with a CNAME. The refusal has to happen here, before the zone write, or the
// person gets a 500 from named-checkzone refusing the whole file.
// ---------------------------------------------------------------------------

const DOMAIN = "example.com";
const DOMAIN_ID = 1;
const USER_ID = 7;

let txtCalls;
let origAdd;

beforeEach(() => {
  txtCalls = [];
  origAdd = bindMod.addTxtRecord;
  bindMod.addTxtRecord = vi.fn(async (subdomain, domain, hostPrefix, value, previousValue = null) => {
    txtCalls.push({ subdomain, domain, hostPrefix, value, previousValue });
    return { name: `${hostPrefix}.${domain}`, content: value };
  });
});

afterEach(() => {
  bindMod.addTxtRecord = origAdd;
});

/** The web routes with the auth guard already satisfied. */
function webApp({ recordType = "A", existingTxt = [] } = {}) {
  const queries = [];
  const execute = vi.fn(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM managed_domains")) return [[{ id: DOMAIN_ID, domain_name: DOMAIN }]];
    if (/^SELECT id, record_type FROM subdomains/.test(sql)) {
      return [[{ id: 42, record_type: recordType }]];
    }
    if (sql.includes("FROM subdomain_txt_records")) return [existingTxt];
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });

  const app = Fastify({ logger: false });
  app.decorate("mysql", { execute });
  app.decorate("authenticate", async (request) => {
    request.user = { id: USER_ID };
  });
  app.register(domainRoutes, { prefix: "/api" });
  return { app, queries };
}

function postTxt(app, body) {
  return app.inject({ method: "POST", url: "/api/subdomains/demo/txt", payload: body });
}

describe("POST /api/subdomains/:subdomain/txt", () => {
  const MCP_VALUE = "v=MCPv1; k=ed25519; p=G72mfmBr3XwUBjR0G3ehT4un5XxkVO9gnaMHTr3Kpnk=";

  // The behaviour 28 owners depend on, and the reason the field is optional:
  // a caller that says nothing gets exactly what this route did before.
  it("writes _vercel when no prefix is given", async () => {
    const { app } = webApp({ recordType: "CNAME" });

    const res = await postTxt(app, { domain: DOMAIN, txtValue: "vc-domain-verify=mine" });

    expect(res.statusCode).toBe(200);
    expect(txtCalls).toEqual([
      {
        subdomain: "demo",
        domain: DOMAIN,
        hostPrefix: "_vercel",
        value: "vc-domain-verify=mine",
        previousValue: null,
      },
    ]);
    await app.close();
  });

  it("writes @ on the subdomain's own name", async () => {
    const { app, queries } = webApp({ recordType: "A" });

    const res = await postTxt(app, { domain: DOMAIN, txtValue: MCP_VALUE, hostPrefix: "@" });

    expect(res.statusCode).toBe(200);
    expect(txtCalls[0].hostPrefix).toBe("@");
    expect(txtCalls[0].value).toBe(MCP_VALUE);
    // stored under the same marker, which is what makes it findable again
    const insert = queries.find((q) => q.sql.startsWith("INSERT INTO subdomain_txt_records"));
    expect(insert.params).toEqual([42, "@", MCP_VALUE]);
    await app.close();
  });

  // 🔴 Nothing may share a name with a CNAME (RFC 1034), and BIND refuses the
  // whole zone rather than the one line. Caught before the write.
  it("refuses @ on a CNAME record with a sentence about the record", async () => {
    const { app } = webApp({ recordType: "CNAME" });

    const res = await postTxt(app, { domain: DOMAIN, txtValue: MCP_VALUE, hostPrefix: "@" });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("CNAME_CANNOT_HOLD_TXT");
    expect(res.json().error).toMatch(/A record/);
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("accepts @ on a REDIRECT, whose zone line is an A record", async () => {
    const { app } = webApp({ recordType: "REDIRECT" });

    const res = await postTxt(app, { domain: DOMAIN, txtValue: MCP_VALUE, hostPrefix: "@" });

    expect(res.statusCode).toBe(200);
    expect(txtCalls[0].hostPrefix).toBe("@");
    await app.close();
  });

  // The apex allow-list still holds for everything that is a prefix:
  // `_acme-challenge` at the root would get the caller a certificate for the
  // root domain itself.
  it("still refuses a prefix that would claim the root domain", async () => {
    const { app } = webApp({ recordType: "A" });

    const res = await postTxt(app, {
      domain: DOMAIN,
      txtValue: "token",
      hostPrefix: "_acme-challenge",
    });

    expect(res.statusCode).toBe(400);
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("still refuses a prefix that would inject zone directives", async () => {
    const { app } = webApp({ recordType: "A" });

    const res = await postTxt(app, {
      domain: DOMAIN,
      txtValue: "token",
      hostPrefix: "_vercel\tIN\tA\t1.2.3.4\n@",
    });

    expect(res.statusCode).toBe(400);
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("still refuses a TXT value that would break out of the quoted field", async () => {
    const { app } = webApp({ recordType: "A" });

    const res = await postTxt(app, {
      domain: DOMAIN,
      txtValue: 'x" IN A 6.6.6.6 ;',
      hostPrefix: "@",
    });

    expect(res.statusCode).toBe(400);
    expect(txtCalls).toHaveLength(0);
    await app.close();
  });

  it("hands the caller's stored value to the zone write so the old line goes", async () => {
    const { app } = webApp({ recordType: "A", existingTxt: [{ txt_value: "v=MCPv1; p=old" }] });

    await postTxt(app, { domain: DOMAIN, txtValue: MCP_VALUE, hostPrefix: "@" });

    expect(txtCalls[0].previousValue).toBe("v=MCPv1; p=old");
    await app.close();
  });
});
