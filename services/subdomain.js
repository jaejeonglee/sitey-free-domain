const bindService = require("./bind");
const alertService = require("./alert");
const { expiryAfter } = require("./expiry");
const { TXT_SELF_NAME } = require("../utils/validators");

/**
 * Where this record's one TXT value belongs, decided by what the record is.
 *
 * A CNAME keeps the apex prefix it has always had: `_vercel.sitey.my`, the
 * only name Vercel reads for a subdomain of a domain that is not on the Public
 * Suffix List. That is what 28 owners are verifying against right now and it
 * does not move (.claude/docs/decisions/0001-txt-record-naming.md).
 *
 * Everything else gets the subdomain's own name — `test.sitey.my IN TXT` —
 * which is where a reader handed that one hostname looks. A CNAME cannot have
 * it: DNS allows no other data beside a CNAME, and BIND fails the whole zone
 * over it, which is exactly why the type chooses rather than the caller.
 *
 * REDIRECT lands here too and is fine: its zone line is an A record for this
 * server (bind.zoneRecordFor), and A and TXT share a name happily.
 */
function txtPrefixFor(recordType) {
  return recordType === "CNAME" ? "_vercel" : TXT_SELF_NAME;
}

/**
 * Zone files store CNAME targets with a trailing dot; the DB stores them
 * without. Normalize before comparing a zone value to a DB value.
 */
function asZoneValue(recordType, value) {
  if (value === undefined || value === null) return value;
  // One translation for all three types (a REDIRECT's zone value is this
  // server's IP, whatever URL the row holds) — see bind.zoneRecordFor.
  return bindService.zoneRecordFor(recordType, value).value;
}

/**
 * Create a subdomain record (DB + BIND9)
 * DB first (transaction) -> BIND9 -> commit / rollback
 *
 * @param {object} fastify - Fastify instance (for mysql + log)
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.domainId
 * @param {string} params.subdomain
 * @param {string} params.domain - e.g. "sitey.one"
 * @param {string} params.recordValue
 * @param {string} params.recordType - "A" or "CNAME"
 * @param {string|null} params.ownerTokenHash - sha256 of the anonymous owner's
 *   token. Set on every record made without an account; NULL under an account,
 *   and NULL on the rows that predate tokens (services/anon-token.js). The
 *   address is still written alongside it, because the quota counts births per
 *   address even when the record belongs to a token.
 * @returns {{ name: string, content: string, type: string }}
 */
async function createSubdomain(fastify, params) {
  const {
    userId, domainId, subdomain, domain, recordValue, recordType,
    ownerType = "user", ownerIp = null, ownerTokenHash = null,
  } = params;

  const connection = await fastify.mysql.getConnection();
  let bindWritten = false;
  try {
    // Check for duplicates
    const isTakenInBind = await bindService.findDnsRecord(subdomain, domain);
    const [rows] = await connection.execute(
      "SELECT 1 FROM subdomains WHERE subdomain = ? AND domain_id = ? LIMIT 1",
      [subdomain, domainId]
    );
    if (isTakenInBind || rows.length > 0) {
      throw Object.assign(new Error("Domain is already in use."), {
        statusCode: 409,
      });
    }

    await connection.beginTransaction();
    // A name is lent for a period and has to be renewed; how long depends on
    // who the owner is (services/expiry.js). Set at insert rather than left to
    // a default so the row is never briefly immortal.
    const expiresAt = expiryAfter(new Date(), ownerType);
    await connection.execute(
      "INSERT INTO subdomains (user_id, domain_id, subdomain, record_value, record_type, owner_type, owner_ip, owner_token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, domainId, subdomain, recordValue, recordType, ownerType, ownerIp, ownerTokenHash, expiresAt]
    );

    // Flag before the call, not after: the most common failures are inside
    // createDnsRecord (checkzone / reload), and setting it afterwards skipped
    // compensation for exactly those cases. deleteDnsRecord is idempotent, so
    // compensating a write that never landed is harmless.
    bindWritten = true;
    const newRecord = await bindService.createDnsRecord(
      subdomain,
      recordValue,
      domain,
      recordType
    );

    await connection.commit();
    fastify.log.info(`Subdomain created: ${newRecord.name}`);
    // The caller hands the date straight back to an agent, which has no other
    // way of learning when it has to renew.
    return { ...newRecord, expiresAt };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rbErr) {
      fastify.log.error(rbErr, "Rollback failed during subdomain creation");
    }
    if (bindWritten) {
      try {
        await bindService.deleteDnsRecord(subdomain, domain, recordType);
        fastify.log.warn(`Compensated orphan BIND record after DB failure: ${subdomain}.${domain}`);
        await alertService.warn("ORPHAN_COMPENSATED", { subdomain, domain, recordType, error: error.message });
      } catch (compErr) {
        fastify.log.error({ err: compErr, originalErr: error, subdomain, domain, recordType },
          "ORPHAN_COMPENSATION_FAILED");
        await alertService.critical("ORPHAN_COMPENSATION_FAILED", {
          subdomain, domain, recordType, error: error.message, compError: compErr.message,
        });
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Update a subdomain record (DB + BIND9)
 *
 * @param {object} fastify
 * @param {object} params
 * @param {number} params.recordId - subdomains.id
 * @param {string} params.subdomain
 * @param {string} params.domain
 * @param {string} params.recordValue
 * @param {string} params.recordType
 * @param {string|undefined} params.txtValue - the record's one TXT value;
 *   undefined leaves it alone, "" removes it. Which name it is written at is
 *   decided here, from the record type — see txtPrefixFor.
 */
async function updateSubdomain(fastify, params) {
  const { recordId, subdomain, domain, recordValue, recordType, txtValue } =
    params;
  const txtHostPrefix = txtPrefixFor(recordType);
  const txtRequested = typeof txtValue !== "undefined";

  const connection = await fastify.mysql.getConnection();
  let bindUpdated = false;
  let txtTouched = false;
  let oldRecordValue;
  let oldTxtValue;
  try {
    await connection.beginTransaction();

    // Fetch old values for compensation
    const [oldRows] = await connection.execute(
      "SELECT record_value FROM subdomains WHERE id = ? FOR UPDATE",
      [recordId]
    );
    oldRecordValue = oldRows[0]?.record_value;

    // Fetch old TXT value if applicable
    if (txtRequested) {
      const [oldTxtRows] = await connection.execute(
        "SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
        [recordId, txtHostPrefix]
      );
      oldTxtValue = oldTxtRows[0]?.txt_value || null;
    }

    // Update main record in DB
    await connection.execute(
      "UPDATE subdomains SET record_value = ? WHERE id = ?",
      [recordValue, recordId]
    );

    // Handle TXT record in DB
    if (txtRequested) {
      const hostPrefix = txtHostPrefix;
      if (txtValue) {
        await connection.execute(
          "INSERT INTO subdomain_txt_records (subdomain_id, host_prefix, txt_value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE txt_value = VALUES(txt_value)",
          [recordId, hostPrefix, txtValue]
        );
      } else {
        await connection.execute(
          "DELETE FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
          [recordId, hostPrefix]
        );
      }
    }

    // BIND9: update main record (flag first — see createSubdomain)
    bindUpdated = true;
    await bindService.updateDnsRecord(subdomain, recordValue, domain, recordType);

    // BIND9: handle TXT record
    if (txtRequested) {
      const hostPrefix = txtHostPrefix;
      txtTouched = true;
      if (txtValue) {
        // The old value is handed over so the append drops it in the same
        // write — nothing else knows it once the row above is updated.
        await bindService.addTxtRecord(subdomain, domain, hostPrefix, txtValue, oldTxtValue);
      } else if (oldTxtValue) {
        await bindService.deleteTxtRecord(subdomain, domain, hostPrefix, oldTxtValue);
      }
    }

    await connection.commit();
    fastify.log.info(`Subdomain updated: ${subdomain}.${domain} (${recordType})`);
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rbErr) {
      fastify.log.error(rbErr, "Rollback failed during subdomain update");
    }
    if (bindUpdated) {
      try {
        const current = await bindService.readDnsRecord(subdomain, domain, recordType);
        if (current) {
          const currentVal = current.value;
          // Normalize for comparison: CNAME values end with "." in zone files
          const formatted = asZoneValue(recordType, recordValue);
          if (currentVal === formatted || currentVal === recordValue) {
            // Our write is still there, reverse it
            await bindService.updateDnsRecord(subdomain, oldRecordValue, domain, recordType);
            fastify.log.warn(`Compensated BIND update after DB failure: ${subdomain}.${domain}`);
            await alertService.warn("UPDATE_COMPENSATED", { subdomain, domain, recordType, error: error.message });
          } else if (
            currentVal === asZoneValue(recordType, oldRecordValue) ||
            currentVal === oldRecordValue
          ) {
            // The zone still holds the old value: our write never landed
            // (checkzone rejected it, or the reload rolled it back).
            // Nothing to undo — and this is not a race.
            fastify.log.info(`BIND update never applied, no compensation needed: ${subdomain}.${domain}`);
          } else {
            // Value is different - race detected
            await alertService.critical("UPDATE_COMPENSATION_RACE", {
              subdomain, domain, recordType,
              expected: recordValue, found: currentVal,
              error: error.message,
            });
          }
        }
        // If current is null, record was removed by something else - skip
      } catch (compErr) {
        fastify.log.error({ err: compErr, originalErr: error, subdomain, domain, recordType },
          "UPDATE_COMPENSATION_FAILED");
        await alertService.critical("UPDATE_COMPENSATION_FAILED", {
          subdomain, domain, recordType, error: error.message, compError: compErr.message,
        });
      }
    }
    if (txtTouched) {
      try {
        const hostPrefix = txtHostPrefix;
        // Undo our own write: put the old value back and take out the one we
        // just added, or remove it outright if there was nothing before.
        if (oldTxtValue) {
          await bindService.addTxtRecord(subdomain, domain, hostPrefix, oldTxtValue, txtValue || null);
        } else if (txtValue) {
          await bindService.deleteTxtRecord(subdomain, domain, hostPrefix, txtValue);
        }
        fastify.log.warn(`Compensated TXT record after DB failure: ${subdomain}.${domain}`);
      } catch (txtCompErr) {
        fastify.log.error({ err: txtCompErr, subdomain, domain },
          "TXT_COMPENSATION_FAILED");
        await alertService.critical("TXT_COMPENSATION_FAILED", {
          subdomain, domain, error: error.message, compError: txtCompErr.message,
        });
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Delete a subdomain record + associated TXT records (DB + BIND9)
 *
 * @param {object} fastify
 * @param {object} params
 * @param {number} params.recordId - subdomains.id
 * @param {string} params.subdomain
 * @param {string} params.domain
 * @param {string} params.recordType
 */
async function deleteSubdomain(fastify, params) {
  const { recordId, subdomain, domain, recordType } = params;

  const connection = await fastify.mysql.getConnection();
  let bindDeleted = false;
  let oldRecordValue;
  let oldRecordType;
  let txtRows = [];
  let txtDeleted = false;
  try {
    await connection.beginTransaction();

    // Fetch full record info for compensation before deleting
    const [subRows] = await connection.execute(
      "SELECT record_value, record_type FROM subdomains WHERE id = ? FOR UPDATE",
      [recordId]
    );
    oldRecordValue = subRows[0]?.record_value;
    oldRecordType = subRows[0]?.record_type;

    // Get associated TXT records before deleting
    const [txtResult] = await connection.execute(
      "SELECT host_prefix, txt_value FROM subdomain_txt_records WHERE subdomain_id = ?",
      [recordId]
    );
    txtRows = txtResult;

    await connection.execute(
      "DELETE FROM subdomain_txt_records WHERE subdomain_id = ?",
      [recordId]
    );
    await connection.execute("DELETE FROM subdomains WHERE id = ?", [recordId]);

    // BIND9: delete main record (flag first — see createSubdomain)
    bindDeleted = true;
    await bindService.deleteDnsRecord(subdomain, domain, recordType);

    // BIND9: delete TXT records
    txtDeleted = true;
    for (const txt of txtRows) {
      await bindService.deleteTxtRecord(subdomain, domain, txt.host_prefix, txt.txt_value);
    }

    await connection.commit();
    fastify.log.info(`Subdomain deleted: ${subdomain}.${domain} (${recordType})`);
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rbErr) {
      fastify.log.error(rbErr, "Rollback failed during subdomain deletion");
    }
    if (bindDeleted && oldRecordValue) {
      try {
        const current = await bindService.readDnsRecord(subdomain, domain, recordType);
        if (!current) {
          // Record was deleted from zone, restore it
          await bindService.createDnsRecord(subdomain, oldRecordValue, domain, oldRecordType);
          fastify.log.warn(`Compensated BIND deletion after DB failure: ${subdomain}.${domain}`);
          await alertService.warn("DELETE_COMPENSATED", { subdomain, domain, recordType, error: error.message });
        } else if (
          current.value !== asZoneValue(recordType, oldRecordValue) &&
          current.value !== oldRecordValue
        ) {
          // Different value - race detected
          await alertService.critical("DELETE_COMPENSATION_RACE", {
            subdomain, domain, recordType,
            expected: "absent", found: current.value,
            error: error.message,
          });
        }
        // If exists with same value, already fine
      } catch (compErr) {
        fastify.log.error({ err: compErr, originalErr: error, subdomain, domain, recordType },
          "DELETE_COMPENSATION_FAILED");
        await alertService.critical("DELETE_COMPENSATION_FAILED", {
          subdomain, domain, recordType, error: error.message, compError: compErr.message,
        });
      }
    }
    if (txtDeleted === false && bindDeleted && txtRows.length > 0) {
      // TXT deletion didn't complete but main record was deleted - try to restore TXT
      // Actually if bindDeleted and we're compensating, TXT restore happens via main record restore above
    }
    if (txtDeleted && txtRows.length > 0) {
      try {
        for (const txt of txtRows) {
          await bindService.addTxtRecord(subdomain, domain, txt.host_prefix, txt.txt_value);
        }
        fastify.log.warn(`Compensated TXT deletion after DB failure: ${subdomain}.${domain}`);
      } catch (txtCompErr) {
        fastify.log.error({ err: txtCompErr, subdomain, domain },
          "TXT_DELETE_COMPENSATION_FAILED");
        await alertService.critical("TXT_DELETE_COMPENSATION_FAILED", {
          subdomain, domain, error: error.message, compError: txtCompErr.message,
        });
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  createSubdomain,
  updateSubdomain,
  deleteSubdomain,
  // routes/domain.js needs it to answer "which value does this record's one
  // TXT box hold" when it folds the listing. Both callers asking the same
  // function is the point: the box the screen draws and the row the server
  // writes have to be the same record.
  txtPrefixFor,
};
