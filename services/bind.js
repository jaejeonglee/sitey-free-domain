const fs = require("fs").promises;
const util = require("util");
const execFile = util.promisify(require("child_process").execFile);
const config = require("../configs/index");

let logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} };
function setLogger(l) { logger = l; }

const isBindDevMode = Boolean(config.bind.devMode);
const domainLocks = new Map();

async function withDomainLock(domain, task) {
  const normalizedDomain = String(domain || "").toLowerCase();
  const previous = domainLocks.get(normalizedDomain) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => (release = resolve));
  domainLocks.set(normalizedDomain, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (domainLocks.get(normalizedDomain) === current) {
      domainLocks.delete(normalizedDomain);
    }
  }
}

// BIND9 zone path
function getZoneFilePath(domain) {
  if (domain.includes("/") || domain.includes("..")) {
    throw new Error("Invalid domain name format");
  }
  return config.bind.zoneFilePath(domain);
}

/**
 * Bump the zone serial in already-read zone content (pure).
 */
function bumpSerial(fileContent) {
  const serialRegex = /(\d+)\s+;\s+Serial/;
  const match = fileContent.match(serialRegex);
  if (!match) {
    throw new Error("Could not find or update serial number in zone file.");
  }
  const newSerial = parseInt(match[1], 10) + 1;
  return fileContent.replace(serialRegex, `${newSerial}         ; Serial`);
}

/**
 * Read a zone file, fail-close on a missing file.
 */
async function readZoneFile(zoneFilePath) {
  try {
    return await fs.readFile(zoneFilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      // Keep the code so idempotent callers (TXT delete) can still treat a
      // missing zone file as "already gone".
      throw Object.assign(
        new Error(
          `Zone file not found at ${zoneFilePath}. Create the file or enable BIND_DEV_MODE=true for local development.`
        ),
        { code: "ENOENT" }
      );
    }
    throw error;
  }
}

/**
 * Replace a zone file atomically: write a temp file next to it, validate the
 * *temp* file, then rename over the original.
 *
 * The previous flow wrote first and validated afterwards, so a rejected record
 * stayed in the live zone file and blocked every later write on that domain.
 * Here the live file is only ever replaced by content `named-checkzone` has
 * already accepted, and a failed reload is rolled back to the original bytes.
 *
 * @param {string} originalContent - content before the change, used for rollback
 */
async function replaceZoneFile(domain, zoneFilePath, nextContent, originalContent) {
  const tmpPath = `${zoneFilePath}.tmp.${process.pid}.${Date.now()}`;

  // Keep mode/owner of the live file — named must still be able to read it.
  const stats = await fs.stat(zoneFilePath);

  try {
    await fs.writeFile(tmpPath, nextContent, { mode: stats.mode & 0o777 });
    await fs.chown(tmpPath, stats.uid, stats.gid).catch(() => {});
    await execFile("named-checkconf", []);
    await execFile("named-checkzone", [domain, tmpPath]);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    logger.error({ err: error, domain }, "Zone validation failed; zone file left unchanged");
    throw Object.assign(
      new Error("Zone file validation failed; no change was applied."),
      { cause: error }
    );
  }

  await fs.rename(tmpPath, zoneFilePath);

  try {
    await execFile("systemctl", ["reload", "named"]);
  } catch (error) {
    // named still holds the previous zone in memory, so put the same bytes
    // back on disk to keep disk and memory in agreement.
    try {
      const rollbackPath = `${zoneFilePath}.rollback.${process.pid}.${Date.now()}`;
      await fs.writeFile(rollbackPath, originalContent, { mode: stats.mode & 0o777 });
      await fs.chown(rollbackPath, stats.uid, stats.gid).catch(() => {});
      await fs.rename(rollbackPath, zoneFilePath);
      logger.error({ err: error, domain }, "BIND reload failed; zone file rolled back");
    } catch (rollbackError) {
      logger.fatal(
        { err: rollbackError, originalErr: error, domain, zoneFilePath },
        "BIND reload failed AND rollback failed — zone file may be ahead of the running server"
      );
    }
    throw Object.assign(new Error("Failed to reload BIND9 service."), { cause: error });
  }
}

/**
 * Read a zone file, apply a pure transform, bump the serial, and swap it in
 * atomically. `transform` returns the new content, `null` when there is
 * nothing to change, or throws to abort.
 *
 * @returns {boolean} true when the zone file was replaced
 */
async function mutateZoneFile(domain, zoneFilePath, transform) {
  const original = await readZoneFile(zoneFilePath);
  const mutated = transform(original);
  if (mutated === null) {
    return false;
  }
  await replaceZoneFile(domain, zoneFilePath, bumpSerial(mutated), original);
  return true;
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRecordType(recordType = "A") {
  const upper = String(recordType).trim().toUpperCase();
  if (!["A", "CNAME"].includes(upper)) {
    throw new Error(`Unsupported record type: ${recordType}`);
  }
  return upper;
}

function formatRecordValue(recordType, value) {
  const trimmed = String(value).trim();
  if (recordType === "CNAME") {
    if (!trimmed.endsWith(".")) {
      return `${trimmed}.`;
    }
  }
  return trimmed;
}

/**
 * Check if a subdomain record exists (A or CNAME)
 */
async function findDnsRecord(subdomain, domain, recordType) {
  if (isBindDevMode) {
    return false;
  }

  const zoneFilePath = getZoneFilePath(domain);
  let data;
  try {
    data = await fs.readFile(zoneFilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      // Dev mode already returns false before reaching fs.readFile (line 96).
      // In production, missing zone file is a hard error (fail-close).
      throw new Error("Zone file not found for " + domain + " at " + zoneFilePath + ". Check BIND_DB_PATH and zone file permissions.");
    }
    throw error;
  }

  const escapedName = escapeRegex(subdomain);
  const typePattern = recordType
    ? escapeRegex(normalizeRecordType(recordType))
    : "(?:A|CNAME)";
  const regex = new RegExp(`^${escapedName}\\s+IN\\s+${typePattern}\\s+`, "im");
  return regex.test(data);
}

/**
 * Add a new DNS record
 */
async function createDnsRecord(subdomain, value, domain, recordType = "A") {
  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    const type = normalizeRecordType(recordType);
    const recordValue = formatRecordValue(type, value);
    const newRecord = `\n${subdomain}\tIN\t${type}\t${recordValue}`;

    if (isBindDevMode) {
      logger.debug({ op: "createDnsRecord", subdomain, domain, type }, "BIND_DEV_MODE skip");
    } else {
      await mutateZoneFile(domain, zoneFilePath, (content) => content + newRecord);
    }

    return { name: `${subdomain}.${domain}`, content: recordValue, type };
  });
}

/**
 * Update an existing DNS record value
 */
async function updateDnsRecord(subdomain, newValue, domain, recordType = "A") {
  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    const type = normalizeRecordType(recordType);
    const recordValue = formatRecordValue(type, newValue);

    if (isBindDevMode) {
      logger.debug({ op: "updateDnsRecord", subdomain, domain, type }, "BIND_DEV_MODE skip");
      return { name: `${subdomain}.${domain}`, content: recordValue, type };
    }

    const escapedName = escapeRegex(subdomain);
    const regex = new RegExp(
      `^(${escapedName}\\s+IN\\s+${type}\\s+)(\\S+.*)$`,
      "im"
    );

    await mutateZoneFile(domain, zoneFilePath, (content) => {
      if (!regex.test(content)) {
        throw new Error(`${type} record not found in zone file.`);
      }
      return content.replace(regex, `$1${recordValue}`);
    });

    return { name: `${subdomain}.${domain}`, content: recordValue, type };
  });
}

/**
 * Remove an existing DNS record
 */
async function deleteDnsRecord(subdomain, domain, recordType = "A") {
  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    const type = normalizeRecordType(recordType);

    if (isBindDevMode) {
      logger.debug({ op: "deleteDnsRecord", subdomain, domain, type }, "BIND_DEV_MODE skip");
      return { name: `${subdomain}.${domain}`, type };
    }

    const escapedName = escapeRegex(subdomain);
    const regex = new RegExp(
      `^${escapedName}\\s+IN\\s+${type}\\s+.*\\n?`,
      "im"
    );

    const changed = await mutateZoneFile(domain, zoneFilePath, (content) =>
      regex.test(content) ? content.replace(regex, "") : null
    );

    if (!changed) {
      return { name: `${subdomain}.${domain}`, type, alreadyAbsent: true };
    }

    return { name: `${subdomain}.${domain}`, type };
  });
}

/**
 * Build the zone file line name for a TXT record.
 *
 * The name is the bare prefix at the zone apex — `_vercel`, not
 * `_vercel.<subdomain>`. Vercel asks for the verification TXT under the
 * *registrable* domain and works out what that is from the Public Suffix List.
 * `sitey.my` is not on that list, so Vercel reads `demo.sitey.my` as a host
 * inside the registrable domain `sitey.my` and the only name it ever looks at
 * is `_vercel.sitey.my`. Measured 2026-09-07: 28 of 28 TXT records sit there,
 * and the one subdomain that currently verifies is verified from that name.
 *
 * `subdomain` is deliberately unused. Once sitey.my is on the Public Suffix
 * List, Vercel starts asking for `_vercel.<subdomain>.sitey.my`, and this
 * function is the single line that has to change — every caller already hands
 * over the subdomain it owns. See
 * .claude/docs/decisions/0001-txt-record-naming.md.
 */
function txtRecordName(subdomain, hostPrefix) {
  return hostPrefix;
}

/**
 * Match one whole TXT line by name *and* value.
 *
 * Every owner's token shares the `_vercel` name, so the value is the only
 * thing that tells one line from another. Separators are spaces and tabs only:
 * `\s` would run past the line break into the next record.
 */
function txtLineRegex(recordName, txtValue) {
  return new RegExp(
    `^${escapeRegex(recordName)}[ \\t]+IN[ \\t]+TXT[ \\t]+"${escapeRegex(txtValue)}"[ \\t]*\\r?\\n?`,
    "im"
  );
}

/**
 * Add one TXT value under `hostPrefix`.
 *
 * DNS holds several TXT records under one name, and that is exactly what this
 * slot needs: `_vercel.sitey.my` carries one verification token per subdomain,
 * side by side. The old code replaced the line whose *name* matched, so every
 * new token deleted the previous owner's — 28 rows in the database had left 3
 * lines in the zone. The original comment already said a "value list" was the
 * intent; only the implementation disagreed.
 *
 * Nothing here overwrites anything:
 *  - the same (name, value) pair already in the zone is a no-op,
 *  - anything else is appended as a new line,
 *  - `previousValue` — the caller's own earlier value, read from the database —
 *    is the one exception. It goes away in the same zone write, because
 *    otherwise re-verifying leaves a line nobody can ever delete: the database
 *    only remembers the current value, and delete matches on the value.
 */
async function addTxtRecord(subdomain, domain, hostPrefix, txtValue, previousValue = null) {
  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    const recordName = txtRecordName(subdomain, hostPrefix);
    const newRecordLine = `${recordName}\tIN\tTXT\t"${txtValue}"`;

    if (isBindDevMode) {
      logger.debug({ op: "addTxtRecord", recordName, domain }, "BIND_DEV_MODE skip");
      return { name: `${recordName}.${domain}`, content: txtValue };
    }

    const present = txtLineRegex(recordName, txtValue);
    const stale =
      previousValue && previousValue !== txtValue
        ? txtLineRegex(recordName, previousValue)
        : null;

    await mutateZoneFile(domain, zoneFilePath, (content) => {
      const withoutStale =
        stale && stale.test(content) ? content.replace(stale, "") : content;
      if (present.test(withoutStale)) {
        // Already there — only write if the stale line still has to go.
        return withoutStale === content ? null : withoutStale;
      }
      return `${withoutStale}\n${newRecordLine}`;
    });

    return { name: `${recordName}.${domain}`, content: txtValue };
  });
}

/**
 * Read a single DNS record value (A or CNAME)
 */
async function readDnsRecord(subdomain, domain, recordType) {
  if (isBindDevMode) {
    return null;
  }

  const zoneFilePath = getZoneFilePath(domain);
  let data;
  try {
    data = await fs.readFile(zoneFilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Zone file not found for " + domain + " at " + zoneFilePath + ". Check BIND_DB_PATH and zone file permissions.");
    }
    throw error;
  }

  const escapedName = escapeRegex(subdomain);
  const type = normalizeRecordType(recordType);
  const regex = new RegExp(`^${escapedName}\\s+IN\\s+${escapeRegex(type)}\\s+(\\S+.*)$`, "im");
  const match = data.match(regex);
  if (!match) {
    return null;
  }
  return { name: subdomain, type, value: match[1].trim() };
}

/**
 * List all A and CNAME records from a domain's zone file
 */
async function listDnsRecords(domain) {
  if (isBindDevMode) {
    return [];
  }

  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    let data;
    try {
      data = await fs.readFile(zoneFilePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("Zone file not found for " + domain + " at " + zoneFilePath + ". Check BIND_DB_PATH and zone file permissions.");
      }
      throw error;
    }

    const results = [];
    const regex = /^(\S+)\s+IN\s+(A|CNAME)\s+(\S+.*)$/gim;
    let match;
    while ((match = regex.exec(data)) !== null) {
      results.push({
        name: match[1],
        type: match[2].toUpperCase(),
        value: match[3].trim(),
      });
    }
    return results;
  });
}

async function deleteTxtRecord(subdomain, domain, hostPrefix, txtValue) {
  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    const recordName = txtRecordName(subdomain, hostPrefix);

    if (isBindDevMode) {
      logger.debug({ op: "deleteTxtRecord", recordName, domain }, "BIND_DEV_MODE skip");
      return { name: `${recordName}.${domain}`, deleted: true };
    }

    // The name is shared by every subdomain of the domain, so deleting by name
    // would take every other owner's verification with it.
    if (!txtValue) {
      throw new Error(
        "deleteTxtRecord requires the value to remove: the TXT name is shared by every subdomain."
      );
    }

    const regex = txtLineRegex(recordName, txtValue);
    let changed;
    try {
      changed = await mutateZoneFile(domain, zoneFilePath, (content) =>
        regex.test(content) ? content.replace(regex, "") : null
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        return { name: `${recordName}.${domain}`, deleted: false, alreadyAbsent: true };
      }
      throw error;
    }

    // Reporting "deleted" for a line that was never found is how records
    // survived deletion and stayed in the zone forever. Say what happened.
    if (!changed) {
      logger.warn(
        { op: "deleteTxtRecord", recordName, domain },
        "TXT value not present in zone file; nothing was removed"
      );
      return { name: `${recordName}.${domain}`, deleted: false, alreadyAbsent: true };
    }

    return { name: `${recordName}.${domain}`, deleted: true };
  });
}

module.exports = {
  setLogger,
  findDnsRecord,
  readDnsRecord,
  listDnsRecords,
  createDnsRecord,
  updateDnsRecord,
  deleteDnsRecord,
  normalizeRecordType,
  addTxtRecord,
  deleteTxtRecord,
  // Exported for deploy/migrate-vercel-txt.js so the backfill cannot
  // disagree with the app about where a TXT line lives or what counts
  // as the same line.
  txtRecordName,
  txtLineRegex,
};
