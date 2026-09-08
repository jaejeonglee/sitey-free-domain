import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The reconciler compares the zone file with the database every night and had
// a hole exactly where the damage was: bind.listDnsRecords only ever matched
// A and CNAME, and the database side only read `subdomains`. TXT was invisible,
// so 25 verification records could vanish from the zone for months without a
// single warning.
//
// diffRecords is pure, so most of this needs neither a zone file nor MySQL.
// The last block runs the real computeDiff against a mocked zone file to prove
// the TXT lines are actually read off disk and queried out of the database.
// ---------------------------------------------------------------------------

const reconciler = require2("../plugins/reconciler.js");
const { diffRecords } = reconciler;
const config = require2("../configs/index.js");

const VERCEL = "_vercel";
const tokenFor = (sub) => `vc-domain-verify=${sub}.example.com,tok-${sub}`;

function diff({ zoneRecords = [], zoneTxtLines = [], dbRows = [], dbTxtRows = [] }) {
  return diffRecords({ zoneRecords, zoneTxtLines, dbRows, dbTxtRows });
}

// Rows get an id in call order and share subdomain_id per name, so two calls
// for one subdomain read as a retry: same owner, the later call the newer row.
// Real rows carry both columns; the comparison needs them to tell a retry from
// a second owner.
const subdomainIds = new Map();
let nextRowId = 0;
const txtRow = (subdomain, value, hostPrefix = VERCEL) => {
  if (!subdomainIds.has(subdomain)) subdomainIds.set(subdomain, subdomainIds.size + 1);
  return {
    id: ++nextRowId,
    subdomain_id: subdomainIds.get(subdomain),
    subdomain,
    host_prefix: hostPrefix,
    txt_value: value,
  };
};
const txtLine = (name, value) => ({ name, type: "TXT", value });

describe("TXT reconciliation", () => {
  it("reports a TXT value the database holds and the zone does not", () => {
    // The exact shape of the incident: two owners, one line left in the zone.
    const issues = diff({
      zoneTxtLines: [txtLine(VERCEL, tokenFor("demo"))],
      dbTxtRows: [
        txtRow("demo", tokenFor("demo")),
        txtRow("stock", tokenFor("stock")),
      ],
    });

    expect(issues).toEqual([
      {
        type: "txt-db-only",
        name: VERCEL,
        recordType: "TXT",
        subdomain: "stock",
        dbValue: tokenFor("stock"),
      },
    ]);
  });

  it("says nothing when every value in the database is in the zone", () => {
    // Several values under one name is the normal state, not a conflict.
    const issues = diff({
      zoneTxtLines: [
        txtLine(VERCEL, tokenFor("demo")),
        txtLine(VERCEL, tokenFor("stock")),
      ],
      dbTxtRows: [
        txtRow("demo", tokenFor("demo")),
        txtRow("stock", tokenFor("stock")),
      ],
    });

    expect(issues).toEqual([]);
  });

  it("reports a TXT line in the zone that no row claims", () => {
    const issues = diff({
      zoneTxtLines: [
        txtLine(VERCEL, tokenFor("demo")),
        // fossil of the old `<prefix>.<subdomain>` naming
        txtLine("_vercel.stock", "vc-domain-verify=stock.example.com,fossil"),
      ],
      dbTxtRows: [txtRow("demo", tokenFor("demo"))],
    });

    expect(issues).toEqual([
      {
        type: "txt-zone-only",
        name: "_vercel.stock",
        recordType: "TXT",
        zoneValue: "vc-domain-verify=stock.example.com,fossil",
      },
    ]);
  });

  it("reports a record found under the wrong name as one finding", () => {
    // The database expects the apex `_vercel` and the value is in the zone
    // under the fossil `_vercel.stock`. That is one record in the wrong place,
    // and saying so once is the difference between "move it" and two findings
    // that look unrelated.
    const issues = diff({
      zoneTxtLines: [txtLine("_vercel.stock", tokenFor("stock"))],
      dbTxtRows: [txtRow("stock", tokenFor("stock"))],
    });

    expect(issues).toEqual([
      {
        type: "txt-name-mismatch",
        name: VERCEL,
        foundAt: "_vercel.stock",
        recordType: "TXT",
        subdomain: "stock",
        dbValue: tokenFor("stock"),
      },
    ]);
  });

  it("does not hand one misplaced line to two rows", () => {
    // Only the row whose value it is may claim it; the other is still missing.
    const issues = diff({
      zoneTxtLines: [
        txtLine(VERCEL, tokenFor("demo")),
        txtLine("_vercel.stock", tokenFor("stock")),
      ],
      dbTxtRows: [
        txtRow("demo", tokenFor("demo")),
        txtRow("stock", tokenFor("stock")),
        txtRow("gone", tokenFor("gone")),
      ],
    });

    expect(issues).toEqual([
      {
        type: "txt-name-mismatch",
        name: VERCEL,
        foundAt: "_vercel.stock",
        recordType: "TXT",
        subdomain: "stock",
        dbValue: tokenFor("stock"),
      },
      {
        type: "txt-db-only",
        name: VERCEL,
        recordType: "TXT",
        subdomain: "gone",
        dbValue: tokenFor("gone"),
      },
    ]);
  });

  it("reports a changed value as drift when the name belongs to one row", () => {
    const issues = diff({
      zoneTxtLines: [txtLine("_acme", "old-value")],
      dbTxtRows: [txtRow("solo", "new-value", "_acme")],
    });

    expect(issues).toEqual([
      {
        type: "txt-value-drift",
        name: "_acme",
        recordType: "TXT",
        subdomain: "solo",
        zoneValue: "old-value",
        dbValue: "new-value",
      },
    ]);
  });

  it("does not guess at drift while a name is shared by several rows", () => {
    // Two owners under `_vercel` and one unclaimed line: there is no telling
    // whose it is, so it is a missing value and a stray line, not a change.
    const issues = diff({
      zoneTxtLines: [txtLine(VERCEL, "who-knows")],
      dbTxtRows: [
        txtRow("demo", tokenFor("demo")),
        txtRow("stock", tokenFor("stock")),
      ],
    });

    expect(issues.map((i) => i.type).sort()).toEqual([
      "txt-db-only",
      "txt-db-only",
      "txt-zone-only",
    ]);
  });

  it("leaves TXT the app never writes alone", () => {
    // SPF and hand-made verification records live in the same zone. Reporting
    // them every night would bury the findings that matter.
    const issues = diff({
      zoneTxtLines: [
        txtLine("@", "v=spf1 -all"),
        txtLine("_dmarc", "v=DMARC1; p=none"),
        txtLine(VERCEL, tokenFor("demo")),
      ],
      dbTxtRows: [txtRow("demo", tokenFor("demo"))],
    });

    expect(issues).toEqual([]);
  });

  it("still compares A and CNAME records", () => {
    const issues = diff({
      zoneRecords: [{ name: "www", type: "A", value: "1.2.3.4" }],
      dbRows: [
        { subdomain: "www", record_type: "A", record_value: "9.9.9.9" },
        { subdomain: "gone", record_type: "A", record_value: "5.6.7.8" },
      ],
    });

    expect(issues).toEqual([
      { type: "db-only", name: "gone", recordType: "A", dbValue: "5.6.7.8" },
      {
        type: "value-drift",
        name: "www",
        recordType: "A",
        zoneValue: "1.2.3.4",
        dbValue: "9.9.9.9",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The live server as measured on 2026-09-08, the night the reconciler ran for
// the first time and sent four warnings. All four were false — nothing had
// newly broken.
//
// Production has no unique key on (subdomain_id, host_prefix), so every Vercel
// retry left another row behind: `jay` has two, `stock` has two, and only the
// newest of each is the token its owner uses today. The alert compared against
// all of them, so both superseded rows came out as "the database has it and
// the zone does not".
//
// Values are the measured ones, cut to the prefix the alert printed.
// `kgld-landing-dev` stands in for the rows that matched — its token is a
// placeholder, the other four are real.
//
// The point of this fixture: an alarm has to be quiet when nothing is wrong.
// Two findings are genuine here, both orphan lines in the zone that no live
// row owns, and they are what --prune-orphans removes.
// ---------------------------------------------------------------------------

describe("the live server's state, 2026-09-08", () => {
  const siteyOne = {
    dbTxtRows: [
      // id 26 — an earlier retry, superseded
      txtRow("stock", "vc-domain-verify=stock.sitey.one,012762bee6"),
      // id 27 — the token in use, and in the zone
      txtRow("stock", "vc-domain-verify=stock.sitey.one,5588631f55"),
    ],
    zoneTxtLines: [
      txtLine(VERCEL, "vc-domain-verify=stock.sitey.one,5588631f55"),
      // written through MCP before it recorded rows: no row anywhere owns it
      txtLine(VERCEL, "vc-domain-verify=udt.sitey.one,00d528cbc6"),
      // the superseded value, under the name the old code wrote
      txtLine("_vercel.stock", "vc-domain-verify=stock.sitey.one,012762bee6"),
    ],
  };

  const siteyMy = {
    dbTxtRows: [
      // id 9 — an earlier retry, superseded, and not in the zone
      txtRow("jay", "vc-domain-verify=jay.sitey.my,518589e393"),
      // id 40 — the token in use
      txtRow("jay", "vc-domain-verify=jay.sitey.my,a7ac65b20a"),
      txtRow("kgld-landing-dev", "vc-domain-verify=kgld-landing-dev.sitey.my,placeholder"),
    ],
    zoneTxtLines: [
      txtLine(VERCEL, "vc-domain-verify=jay.sitey.my,a7ac65b20a"),
      txtLine(VERCEL, "vc-domain-verify=kgld-landing-dev.sitey.my,placeholder"),
    ],
  };

  it("reports the two orphan lines and nothing else", () => {
    const issues = [...diff(siteyOne), ...diff(siteyMy)];

    expect(issues).toEqual([
      {
        type: "txt-zone-only",
        name: VERCEL,
        recordType: "TXT",
        zoneValue: "vc-domain-verify=udt.sitey.one,00d528cbc6",
      },
      {
        type: "txt-zone-only",
        name: "_vercel.stock",
        recordType: "TXT",
        zoneValue: "vc-domain-verify=stock.sitey.one,012762bee6",
      },
    ]);
  });

  it("says nothing about a subdomain whose retries are all superseded but present", () => {
    // `jay`'s older token is in no zone file, and that is correct: the value
    // Vercel asks for is the newest one, which is there.
    const issues = diff(siteyMy);

    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeDiff for real: zone file off a mocked disk, rows out of a stub
// connection. Same harness as bind-zone-write.test.js — bind.js reads config
// at module load, so both have to be replaced before the re-require.
// ---------------------------------------------------------------------------

describe("computeDiff reads TXT out of the zone file", () => {
  const ZONE_PATH = "/zones/db.example.com";
  const ZONE_CONTENT = [
    "$TTL 3600",
    "@  IN  SOA  ns1.example.com. admin.example.com. (",
    "    2024010101  ; Serial",
    "    86400 )     ; Minimum TTL",
    "@       IN  NS  ns1.example.com.",
    "demo    IN  CNAME  cname.vercel-dns.com.",
    "stock   IN  CNAME  cname.vercel-dns.com.",
    `_vercel\tIN\tTXT\t"${tokenFor("demo")}"`,
    '_vercel.stock\tIN\tTXT\t"vc-domain-verify=stock.example.com,fossil"',
    '@\tIN\tTXT\t"v=spf1 -all"',
  ].join("\n");

  const savedEnv = {};
  let computeDiff;
  let fsMod;
  let origReadFile;

  /** every SQL statement computeDiff issued */
  let queries;

  const fastify = {
    mysql: {
      execute: async (sql, params) => {
        queries.push(sql);
        if (sql.includes("FROM subdomain_txt_records")) {
          return [
            [
              txtRow("demo", tokenFor("demo")),
              txtRow("stock", tokenFor("stock")),
            ],
          ];
        }
        return [
          [
            { subdomain: "demo", record_type: "CNAME", record_value: "cname.vercel-dns.com" },
            { subdomain: "stock", record_type: "CNAME", record_value: "cname.vercel-dns.com" },
          ],
        ];
      },
    },
  };

  beforeEach(() => {
    for (const key of ["BIND_DEV_MODE", "BIND_DB_PATH", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALERT_CHAT_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.BIND_DEV_MODE = "false";
    process.env.BIND_DB_PATH = "/zones";
    process.env.TELEGRAM_BOT_TOKEN = "test-tok";
    process.env.TELEGRAM_ALERT_CHAT_ID = "123";

    for (const modPath of [
      "../configs/index.js",
      "../services/bind.js",
      "../services/alert.js",
      "../plugins/reconciler.js",
    ]) {
      delete require2.cache[require2.resolve(modPath)];
    }
    computeDiff = require2("../plugins/reconciler.js").computeDiff;

    queries = [];
    fsMod = require2("fs");
    origReadFile = fsMod.promises.readFile;
    fsMod.promises.readFile = vi.fn(async (p) => {
      if (p !== ZONE_PATH) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return ZONE_CONTENT;
    });
  });

  afterEach(() => {
    fsMod.promises.readFile = origReadFile;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const modPath of [
      "../configs/index.js",
      "../services/bind.js",
      "../services/alert.js",
      "../plugins/reconciler.js",
    ]) {
      delete require2.cache[require2.resolve(modPath)];
    }
  });

  it("catches the value the database holds and the zone lost", async () => {
    const issues = await computeDiff(fastify, "example.com", 1);

    const txtQuery = queries.find((q) => q.includes("FROM subdomain_txt_records"));
    expect(txtQuery).toBeDefined();
    // Without these two the retry rule cannot tell a retry from a second owner
    // and quietly stops filtering — the failure this whole rule exists to fix.
    expect(txtQuery).toContain("t.id");
    expect(txtQuery).toContain("t.subdomain_id");
    expect(issues).toContainEqual({
      type: "txt-db-only",
      name: "_vercel",
      recordType: "TXT",
      subdomain: "stock",
      dbValue: tokenFor("stock"),
    });
  });

  it("flags the fossil line and leaves the SPF record alone", async () => {
    const issues = await computeDiff(fastify, "example.com", 1);

    expect(issues).toContainEqual({
      type: "txt-zone-only",
      name: "_vercel.stock",
      recordType: "TXT",
      zoneValue: "vc-domain-verify=stock.example.com,fossil",
    });
    expect(issues.map((i) => i.name)).not.toContain("@");
    expect(issues).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Records the operator put in the zone by hand. Four arrived on 2026-09-08 so
// that mail could come from sitey.my instead of a personal Gmail account:
//
//   rsend              IN CNAME rsend-apne1.forge.rmta.net.
//   send               IN CNAME send.forge.rmta.net.
//   resend._domainkey  IN TXT   "p=..."
//   _dmarc             IN TXT   "v=DMARC1; p=none;"
//
// None of them has a row in `subdomains` or `subdomain_txt_records` and none
// ever will: they belong to the domain, not to a user. Left alone the
// reconciler reports them every night, and the warning that arrives every
// night is the one nobody reads — the count had just been brought to zero.
// ---------------------------------------------------------------------------

describe("records the operator put in the zone, not the app", () => {
  const users = Array.from({ length: 15 }, (_, i) => `user${i + 1}`);

  /** the zone and the database as they stand after the mail records went in */
  const serverState = () => ({
    zoneRecords: [
      { name: "ns1", type: "A", value: "139.59.126.52" },
      { name: "ns2", type: "A", value: "139.59.126.52" },
      { name: "@", type: "A", value: "139.59.126.52" },
      { name: "www", type: "CNAME", value: "sitey.my." },
      { name: "rsend", type: "CNAME", value: "rsend-apne1.forge.rmta.net." },
      { name: "send", type: "CNAME", value: "send.forge.rmta.net." },
      ...users.map((u) => ({ name: u, type: "CNAME", value: "cname.vercel-dns.com." })),
    ],
    zoneTxtLines: [
      txtLine("resend._domainkey", "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ"),
      txtLine("_dmarc", "v=DMARC1; p=none;"),
      ...users.map((u) => txtLine(VERCEL, tokenFor(u))),
    ],
    dbRows: users.map((u) => ({
      subdomain: u,
      record_type: "CNAME",
      record_value: "cname.vercel-dns.com",
    })),
    dbTxtRows: users.map((u) => txtRow(u, tokenFor(u))),
  });

  it("says nothing about the state the server is in tonight", () => {
    expect(diff(serverState())).toEqual([]);
  });

  it("still reports a `_vercel` line no row owns", () => {
    // The line above must not be bought with this one. `_vercel` is user data
    // — every token there has a row to match, and a token without one is
    // exactly what this reconciler exists to find.
    const state = serverState();
    state.zoneTxtLines.push(txtLine(VERCEL, "vc-domain-verify=gone.example.com,orphan"));

    expect(diff(state)).toEqual([
      {
        type: "txt-zone-only",
        name: VERCEL,
        recordType: "TXT",
        zoneValue: "vc-domain-verify=gone.example.com,orphan",
      },
    ]);
  });

  it("keeps the ignore list clear of the names the app writes", () => {
    // The two lists answer opposite questions, so a name in both silences a
    // check on user data. `_vercel` in INFRA_RECORDS would hide every missing
    // verification token on the server.
    for (const prefix of config.txt.apexPrefixes) {
      expect(config.infraRecords).not.toContain(prefix);
    }
  });

  it("ignores a DKIM record whose selector was rotated", () => {
    // `resend._domainkey` is the `resend` node *under* `_domainkey`, and the
    // selector is the half that changes — a new key or a second sender mints a
    // new one. The list names `_domainkey`, so a rotation needs no edit.
    const state = serverState();
    state.zoneTxtLines.push(txtLine("resend2._domainkey", "p=rotated"));

    expect(diff(state)).toEqual([]);
  });

  it("does not let an ignored name swallow one that merely ends the same way", () => {
    // `send` is on the list; `sendgrid` and `resend` are not, and a user may
    // hold either. The match is whole labels, not a string prefix.
    const state = serverState();
    state.zoneRecords.push(
      { name: "sendgrid", type: "CNAME", value: "u1.wl.sendgrid.net." },
      { name: "resend", type: "A", value: "1.2.3.4" }
    );

    expect(diff(state)).toEqual([
      { type: "zone-only", name: "sendgrid", recordType: "CNAME", zoneValue: "u1.wl.sendgrid.net." },
      { type: "zone-only", name: "resend", recordType: "A", zoneValue: "1.2.3.4" },
    ]);
  });
});
