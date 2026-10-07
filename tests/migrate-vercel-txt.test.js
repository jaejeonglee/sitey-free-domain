import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

const { buildPlan } = require2("../deploy/migrate-vercel-txt.js");
const config = require2("../configs/index.js");

// ---------------------------------------------------------------------------
// `unclaimed` used to be a report a human read. With --prune-orphans it is a
// delete list, and every subdomain's token shares the name `_vercel`, so the
// only thing keeping one owner's line off that list is its value. These tests
// pin that down.
//
// An owner means a *live* row: the newest per (subdomain_id, host_prefix),
// the same rule the reconciler uses (services/txt-records.js). If the two
// disagreed the tools would fight — one reporting a line every night that the
// other refused to remove.
// ---------------------------------------------------------------------------

const DOMAIN = "sitey.one";
const ZONE_PATH = config.bind.zoneFilePath(DOMAIN);

const row = (id, subdomain, txt_value) => ({
  id,
  subdomain_id: id,
  subdomain,
  domain: DOMAIN,
  host_prefix: "_vercel",
  txt_value,
});

const zoneWith = (...lines) =>
  new Map([[ZONE_PATH, ["$TTL 3600", "@ IN NS ns1.sitey.one.", ...lines].join("\n")]]);

describe("--prune-orphans delete list", () => {
  it("keeps every value a row owns out of the list", () => {
    const rows = [row(1, "demo", "vc-domain-verify=demo.sitey.one,aaa")];
    const { unclaimed } = buildPlan(
      rows,
      zoneWith(
        '_vercel\tIN\tTXT\t"vc-domain-verify=demo.sitey.one,aaa"',
        '_vercel\tIN\tTXT\t"vc-domain-verify=udt.sitey.one,00d528"'
      )
    );

    // Same name, one line each — only the unowned value may be removed.
    expect(unclaimed).toEqual([
      {
        zonePath: ZONE_PATH,
        domain: DOMAIN,
        name: "_vercel",
        value: "vc-domain-verify=udt.sitey.one,00d528",
      },
    ]);
  });

  it("lists the fossil `_vercel.<subdomain>` name with the domain to delete from", () => {
    const rows = [row(1, "demo", "vc-domain-verify=demo.sitey.one,aaa")];
    const { unclaimed } = buildPlan(
      rows,
      zoneWith(
        '_vercel\tIN\tTXT\t"vc-domain-verify=demo.sitey.one,aaa"',
        '_vercel.stock\tIN\tTXT\t"vc-domain-verify=stock.sitey.one,012762"'
      )
    );

    expect(unclaimed).toEqual([
      {
        zonePath: ZONE_PATH,
        domain: DOMAIN,
        name: "_vercel.stock",
        value: "vc-domain-verify=stock.sitey.one,012762",
      },
    ]);
  });

  it("lists the value a later retry superseded", () => {
    // Two rows for one subdomain is a retry, and Vercel only ever asks for the
    // newest token. The older one is history: a line in the zone that no live
    // row claims, which is exactly what this list is for. Until 2026-09-08 an
    // older row counted as an owner, so the line stayed and the reconciler
    // reported it every night with nothing able to clear it.
    const rows = [
      row(1, "demo", "vc-domain-verify=demo.sitey.one,old"),
      row(2, "demo", "vc-domain-verify=demo.sitey.one,new"),
    ];
    rows[1].subdomain_id = 1;

    const { unclaimed } = buildPlan(
      rows,
      zoneWith(
        '_vercel\tIN\tTXT\t"vc-domain-verify=demo.sitey.one,old"',
        '_vercel\tIN\tTXT\t"vc-domain-verify=demo.sitey.one,new"'
      )
    );

    expect(unclaimed).toEqual([
      {
        zonePath: ZONE_PATH,
        domain: DOMAIN,
        name: "_vercel",
        value: "vc-domain-verify=demo.sitey.one,old",
      },
    ]);
  });

  it("never lists the newest value of a retry, even sharing the name", () => {
    // The other half of the same rule, and the one that costs a user their
    // verification if it breaks: `old` goes, `new` stays.
    const rows = [
      row(1, "demo", "vc-domain-verify=demo.sitey.one,old"),
      row(2, "demo", "vc-domain-verify=demo.sitey.one,new"),
    ];
    rows[1].subdomain_id = 1;

    const { unclaimed } = buildPlan(
      rows,
      zoneWith('_vercel\tIN\tTXT\t"vc-domain-verify=demo.sitey.one,new"')
    );

    expect(unclaimed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `@` rows (2026-09-22 onward) — a TXT on the subdomain's own name.
//
// 🔴 The scan used to be built from each row's host_prefix, so an `@` row
// became the pattern `^@…`, which is the zone's *apex*: the domain's SPF and
// site verification. With one `@` row in the table, --prune-orphans --apply
// would have deleted them. And the name an `@` row actually writes — the
// subdomain itself — was never scanned, so a value it left behind on a
// rewrite (catikteam, 2026-10-05) could not be cleaned up.
// ---------------------------------------------------------------------------

const selfRow = (id, subdomainId, subdomain, txt_value) => ({
  id,
  subdomain_id: subdomainId,
  subdomain,
  domain: DOMAIN,
  host_prefix: "@",
  txt_value,
});

describe("--prune-orphans and self-named rows", () => {
  it("never lists the apex TXT because a row says @", () => {
    const { unclaimed } = buildPlan(
      [selfRow(1, 10, "test", "v=MCPv1; p=x")],
      zoneWith(
        '@\tIN\tTXT\t"v=spf1 include:_spf.resend.com -all"',
        'test\tIN\tTXT\t"v=MCPv1; p=x"'
      )
    );

    expect(unclaimed).toEqual([]);
  });

  it("lists the value a rewrite left on the subdomain's own name", () => {
    const { unclaimed } = buildPlan(
      [
        selfRow(1, 10, "catikteam", "1|t1"),
        selfRow(2, 10, "catikteam", "1|t2"),
        selfRow(3, 10, "catikteam", "1|t3"),
      ],
      zoneWith('catikteam\tIN\tTXT\t"1|t2"', 'catikteam\tIN\tTXT\t"1|t3"')
    );

    expect(unclaimed).toEqual([
      { zonePath: ZONE_PATH, domain: DOMAIN, name: "catikteam", value: "1|t2" },
    ]);
  });

  it("only scans a self name in its own domain's zone", () => {
    const other = config.bind.zoneFilePath("officials.my");
    const zones = new Map([
      [ZONE_PATH, 'test\tIN\tTXT\t"mine"'],
      // somebody's hand-placed record on the same label in another zone
      [other, 'test\tIN\tTXT\t"not-ours"'],
    ]);
    const { unclaimed } = buildPlan([selfRow(1, 10, "test", "mine")], zones);

    expect(unclaimed).toEqual([]);
  });
});
