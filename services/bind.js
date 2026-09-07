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
 * Every TXT record lives under the subdomain that owns it. Creation used to
 * write the bare prefix (`_vercel`), which is one slot shared by the whole
 * domain, so two users verifying with the same provider overwrote each other —
 * and deletion looked for `_vercel.<sub>`, a name creation never wrote, so it
 * could never remove anything. Both sides now use this one rule.
 */
function txtRecordName(subdomain, hostPrefix) {
  return `${hostPrefix}.${subdomain}`;
}

async function createOrUpdateTxtRecord(subdomain, domain, hostPrefix, txtValue) {
  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    const recordName = txtRecordName(subdomain, hostPrefix);
    const recordContent = `"${txtValue}"`;
    const newRecordLine = `${recordName}\tIN\tTXT\t${recordContent}`;

    if (isBindDevMode) {
      logger.debug({ op: "createOrUpdateTxtRecord", recordName, domain }, "BIND_DEV_MODE skip");
      return { name: `${recordName}.${domain}`, content: txtValue };
    }

    const escapedName = escapeRegex(recordName);
    const regex = new RegExp(
      `^(${escapedName}\\s+IN\\s+TXT\\s+)(?:".*")$`,
      "im"
    );

    await mutateZoneFile(domain, zoneFilePath, (content) =>
      regex.test(content)
        ? content.replace(regex, `$1${recordContent}`)
        : content + `\n${newRecordLine}`
    );

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

async function deleteTxtRecord(subdomain, domain, hostPrefix) {
  return withDomainLock(domain, async () => {
    const zoneFilePath = getZoneFilePath(domain);
    const recordName = hostPrefix ? txtRecordName(subdomain, hostPrefix) : subdomain;

    if (isBindDevMode) {
      logger.debug({ op: "deleteTxtRecord", recordName, domain }, "BIND_DEV_MODE skip");
      return { name: `${recordName}.${domain}` };
    }

    const escapedName = escapeRegex(recordName);
    const regex = new RegExp(`^${escapedName}\\s+IN\\s+TXT\\s+.*\\n?`, "im");

    try {
      await mutateZoneFile(domain, zoneFilePath, (content) =>
        // Record not found: nothing to delete, treat as success.
        regex.test(content) ? content.replace(regex, "") : null
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        // If the file doesn't exist, there's nothing to delete.
        return { name: `${recordName}.${domain}` };
      }
      throw error;
    }

    return { name: `${recordName}.${domain}` };
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
  createOrUpdateTxtRecord,
  deleteTxtRecord,
};
