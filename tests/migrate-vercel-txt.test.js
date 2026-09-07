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
