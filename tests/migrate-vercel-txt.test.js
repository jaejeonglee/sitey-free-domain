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

  it("protects a duplicate retry row the backfill itself skips", () => {
    // buildPlan restores only the newest row per (subdomain, prefix). An older
    // row's value is still someone's live verification, so it must not be
    // treated as an orphan.
    const rows = [
      row(1, "demo", "vc-domain-verify=demo.sitey.one,old"),
      row(2, "demo", "vc-domain-verify=demo.sitey.one,new"),
    ];
    rows[1].subdomain_id = 1;

    const { unclaimed } = buildPlan(
      rows,
      zoneWith('_vercel\tIN\tTXT\t"vc-domain-verify=demo.sitey.one,old"')
    );

    expect(unclaimed).toEqual([]);
  });
});
