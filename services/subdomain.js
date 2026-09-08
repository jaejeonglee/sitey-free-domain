const bindService = require("./bind");
const alertService = require("./alert");
const { expiryAfter } = require("./expiry");

/**
 * Zone files store CNAME targets with a trailing dot; the DB stores them
 * without. Normalize before comparing a zone value to a DB value.
 */
function asZoneValue(recordType, value) {
  if (recordType === "CNAME" && value && !String(value).endsWith(".")) {
    return `${value}.`;
  }
  return value;
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
 * @returns {{ name: string, content: string, type: string }}
 */
async function createSubdomain(fastify, params) {
  const {
    userId, domainId, subdomain, domain, recordValue, recordType,
    ownerType = "user", ownerIp = null,
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
    await connection.execute(
      "INSERT INTO subdomains (user_id, domain_id, subdomain, record_value, record_type, owner_type, owner_ip, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, domainId, subdomain, recordValue, recordType, ownerType, ownerIp,
       expiryAfter(new Date(), ownerType)]
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
    return newRecord;
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
 * @param {string|undefined} params.txtValue - TXT value for CNAME verification
 */
async function updateSubdomain(fastify, params) {
  const { recordId, subdomain, domain, recordValue, recordType, txtValue } =
    params;

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
    if (recordType === "CNAME" && typeof txtValue !== "undefined") {
      const [oldTxtRows] = await connection.execute(
        "SELECT txt_value FROM subdomain_txt_records WHERE subdomain_id = ? AND host_prefix = ?",
        [recordId, "_vercel"]
      );
      oldTxtValue = oldTxtRows[0]?.txt_value || null;
    }

    // Update main record in DB
    await connection.execute(
      "UPDATE subdomains SET record_value = ? WHERE id = ?",
      [recordValue, recordId]
    );

    // Handle TXT record in DB
    if (recordType === "CNAME" && typeof txtValue !== "undefined") {
      const hostPrefix = "_vercel";
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
    if (recordType === "CNAME" && typeof txtValue !== "undefined") {
      const hostPrefix = "_vercel";
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
        const hostPrefix = "_vercel";
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
};
