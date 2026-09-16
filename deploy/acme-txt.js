#!/usr/bin/env node
// The DNS-01 challenge record for a wildcard certificate, in and out.
//
//   node deploy/acme-txt.js add sitey.my <value>   # write _acme-challenge TXT, reload
//   node deploy/acme-txt.js del sitey.my <value>   # remove that one line, reload
//
// Caddy (or certbot) asks for `*.sitey.my` and is handed a token to publish at
// `_acme-challenge.sitey.my`. This puts it there through the same path every
// record takes — withDomainLock, the atomic temp-file swap, named-checkzone,
// the reload — so a hand-edited zone file is never the way this happens.
//
// 🔴 Internal only. `_acme-challenge` is exactly the prefix APEX_TXT_PREFIXES
// keeps out of the public TXT endpoint (configs/index.js): a caller who could
// write it would be issued a certificate for the root. This script has no
// caller but the operator on the box, and no route reaches it.
//
// Run on the server, from the repository root, as the user that owns the zone
// files. It reads the same .env the app does.

const config = require("../configs/index");
const bindService = require("../services/bind");
const { validateTxtValue } = require("../utils/validators");

const PREFIX = "_acme-challenge";

bindService.setLogger({
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: () => {},
  fatal: (...args) => console.error(...args),
});

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error("usage: node deploy/acme-txt.js <add|del> <domain> <value>");
  process.exit(2);
}

async function main() {
  const [op, domain, value] = process.argv.slice(2);
  if (!["add", "del"].includes(op) || !domain || !value) usage();
  if (config.bind.devMode) usage("BIND_DEV_MODE is on; nothing would be written");

  const txt = validateTxtValue(value);
  if (!txt.valid) usage(txt.message);

  // txtRecordName puts every TXT at the apex, which is where the challenge
  // for `*.sitey.my` is read: the wildcard's own name is the zone's.
  const name = `${PREFIX}.${domain}`;

  if (op === "add") {
    const result = await bindService.addTxtRecord("@", domain, PREFIX, txt.value);
    console.log(`added   ${result.name} TXT "${result.content}"`);
  } else {
    const result = await bindService.deleteTxtRecord("@", domain, PREFIX, txt.value);
    console.log(
      result.deleted
        ? `removed ${name} TXT "${txt.value}"`
        : `absent  ${name} TXT "${txt.value}" — nothing removed`
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
