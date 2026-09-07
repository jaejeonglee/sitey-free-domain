// routes/domain.js
const bindService = require("../services/bind");
const { validateRecord } = require("../services/validation");
const { createSubdomain, updateSubdomain, deleteSubdomain } = require("../services/subdomain");
const { getManagedDomains } = require("../services/managedDomain");
const { isBlacklisted } = require("../services/blacklist");
const { isValidSubdomain, validateRecordValue, validateTxtValue } = require("../utils/validators");

function normalizeRecordType(recordType = "A") {
  return bindService.normalizeRecordType(recordType);
}

/**
 * Domain and subdomain routes
 */
async function domainRoutes(fastify, options) {
  // GET /api/managed-domains
  fastify.get("/managed-domains", async (request, reply) => {
    try {
      const managedDomains = await getManagedDomains(fastify);
      return reply
        .code(200)
        .send({ domains: managedDomains.map((item) => item.domain) });
    } catch (error) {
      fastify.log.error(error, "Failed to load managed domains");
      return reply.code(500).send({ error: "Error loading domains" });
    }
  });

  // GET /api/stats/active-domains
  fastify.get("/stats/active-domains", async (request, reply) => {
    try {
      const [rows] = await fastify.mysql.execute(
        "SELECT COUNT(*) AS count FROM subdomains"
      );
      const activeDomains = rows?.[0]?.count ?? 0;
      return reply.code(200).send({ activeDomains });
    } catch (error) {
      fastify.log.error(error, "Failed to load active domain stats");
      return reply.code(500).send({ error: "Error loading active domains" });
    }
  });

  // POST /api/check-availability
  fastify.post("/check-availability", async (request, reply) => {
    const { subdomain: rawSubdomain } = request.body;
    const subdomain = (rawSubdomain || "").trim().toLowerCase();

    if (!subdomain || !isValidSubdomain(subdomain)) {
      return reply.code(400).send({ error: "Invalid domain format" });
    }

    try {
      const managedDomains = await getManagedDomains(fastify);
      if (!managedDomains.length) {
        return reply
          .code(503)
          .send({ error: "No managed domains are configured." });
      }

      const results = await Promise.all(
        managedDomains.map(async ({ id: domainId, domain }) => {
          try {
            const isTakenInBind = await bindService.findDnsRecord(
              subdomain,
              domain
            );

            const [rows] = await fastify.mysql.execute(
              "SELECT 1 FROM subdomains WHERE subdomain = ? AND domain_id = ? LIMIT 1",
              [subdomain, domainId]
            );
            const isTakenInDb = rows.length > 0;

            return {
              domain,
              subdomain,
              fullSubdomain: `${subdomain}.${domain}`,
              isAvailable: !isTakenInBind && !isTakenInDb,
            };
          } catch (error) {
            fastify.log.warn({ err: error, domain }, "Zone check failed for domain");
            return {
              domain,
              subdomain,
              fullSubdomain: `${subdomain}.${domain}`,
              available: false,
              error: "zone_unavailable",
            };
          }
        })
      );

      return reply.code(200).send({ results });
    } catch (error) {
      fastify.log.error(error, "Failed to check multi-domain availability");
      return reply
        .code(500)
        .send({ error: "Error checking domain availability" });
    }
  });

  // GET /api/subdomains (list user's subdomains)
  fastify.get(
    "/subdomains",
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const userId = request.user.id;

      try {
        const [rows] = await fastify.mysql.execute(
          "SELECT s.id, s.subdomain, m.domain_name, s.record_value, s.record_type, t.host_prefix, t.txt_value " +
            "FROM subdomains s " +
            "JOIN managed_domains m ON s.domain_id = m.id " +
            "LEFT JOIN subdomain_txt_records t ON s.id = t.subdomain_id " +
            "WHERE s.user_id = ? " +
            "ORDER BY m.domain_name, s.subdomain",
          [userId]
        );

        return reply.send(rows);
      } catch (error) {
        fastify.log.error(error, "Failed to fetch user domains");
        return reply.code(500).send({ error: "Error fetching your domains" });
      }
    }
  );

  fastify.post(
    "/subdomains",
    {
      preHandler: [fastify.authenticate], // ⭐️ Add auth guard via route options
    },
    async (request, reply) => {
      const {
        subdomain: rawSubdomain,
        value: rawValue,
        domain,
        recordType: rawRecordType = "A",
      } = request.body || {};
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const domainName = (domain || "").trim().toLowerCase();
      const userId = request.user.id; // ⭐️ Authenticated user ID
      const recordType = normalizeRecordType(rawRecordType);

      if (!subdomain || !rawValue || !domainName) {
        return reply.code(400).send({
          error: "Domain name, record value, and domain are required",
        });
      }
      if (!isValidSubdomain(subdomain)) {
        return reply.code(400).send({ error: "Invalid domain format" });
      }

      const blacklistCheck = isBlacklisted(subdomain);
      if (blacklistCheck.blocked) {
        return reply.code(400).send({ error: blacklistCheck.reason });
      }

      const managedDomains = await getManagedDomains(fastify);
      const domainEntry = managedDomains.find(
        (item) => item.normalized === domainName
      );

      if (!domainEntry) {
        return reply
          .code(400)
          .send({ error: "Requested domain is not managed by this service." });
      }

      const validation = validateRecordValue(recordType, rawValue, {
        subdomain,
        domain: domainEntry.domain,
      });
      if (!validation.valid) {
        return reply.code(400).send({ error: validation.message });
      }
      const recordValue = validation.value;

      // Active validation: check if target is reachable
      const isReachable = await validateRecord(recordType, recordValue);
      if (!isReachable) {
        const msg =
          recordType === "A"
            ? `Target IP ${recordValue} is not reachable on port 80 or 443.`
            : `Target domain ${recordValue} does not resolve to any address.`;
        return reply
          .code(400)
          .send({ error: msg, code: "VALIDATION_UNREACHABLE" });
      }

      try {
        const newRecord = await createSubdomain(fastify, {
          userId,
          domainId: domainEntry.id,
          subdomain,
          domain: domainEntry.domain,
          recordValue,
          recordType,
        });

        return reply.code(201).send({
          success: true,
          domain: newRecord.name,
          value: recordValue,
          recordType,
        });
      } catch (error) {
        if (error.statusCode === 409) {
          return reply.code(409).send({ error: error.message });
        }
        fastify.log.error(error, "Failed to process domain creation");
        return reply
          .code(500)
          .send({ error: "Server error during domain creation" });
      }
    }
  );

  // ⭐️ Updated: PUT /api/subdomains/:subdomain (update)
  fastify.put(
    "/subdomains/:subdomain",
    {
      preHandler: [fastify.authenticate], // ⭐️ Apply auth guard
    },
    async (request, reply) => {
      const { subdomain: rawSubdomain } = request.params;
      const { value: rawValue, domain, txtValue } = request.body || {};
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const userId = request.user.id;
      const domainName = (domain || "").trim().toLowerCase();

      if (!rawValue || !domainName) {
        return reply
          .code(400)
          .send({ error: "Record value and domain are required" });
      }

      try {
        const managedDomains = await getManagedDomains(fastify);
        const domainEntry = managedDomains.find(
          (item) => item.normalized === domainName
        );

        if (!domainEntry) {
          return reply.code(400).send({
            error: "Requested domain is not managed by this service.",
          });
        }

        // Verify ownership
        const [rows] = await fastify.mysql.execute(
          "SELECT s.id, s.record_type FROM subdomains s WHERE s.subdomain = ? AND s.domain_id = ? AND s.user_id = ?",
          [subdomain, domainEntry.id, userId]
        );
        const record = rows[0];

        if (!record) {
          return reply.code(404).send({
            error: "Domain not found or you do not own this record.",
          });
        }

        const recordType = normalizeRecordType(record.record_type);
        const validation = validateRecordValue(recordType, rawValue, {
          subdomain,
          domain: domainEntry.domain,
        });
        if (!validation.valid) {
          return reply.code(400).send({ error: validation.message });
        }
        const recordValue = validation.value;

        // Active validation: check if target is reachable
        const isReachable = await validateRecord(recordType, recordValue);
        if (!isReachable) {
          const msg =
            recordType === "A"
              ? `Target IP ${recordValue} is not reachable on port 80 or 443.`
              : `Target domain ${recordValue} does not resolve to any address.`;
          return reply
            .code(400)
            .send({ error: msg, code: "VALIDATION_UNREACHABLE" });
        }

        // Validate TXT if provided
        let sanitizedTxt;
        if (recordType === "CNAME" && txtValue) {
          const txtValidation = validateTxtValue(txtValue);
          if (!txtValidation.valid) {
            return reply.code(400).send({ error: txtValidation.message });
          }
          sanitizedTxt = txtValidation.value;
        }

        await updateSubdomain(fastify, {
          recordId: record.id,
          subdomain,
          domain: domainEntry.domain,
          recordValue,
          recordType,
          txtValue: sanitizedTxt !== undefined ? sanitizedTxt : txtValue,
        });

        return reply.code(200).send({
          success: true,
          message: "Domain record updated successfully.",
        });
      } catch (error) {
        fastify.log.error(error, "Failed to update domain");
        return reply
          .code(500)
          .send({ error: "Server error during domain update" });
      }
    }
  );

  // ⭐️ Updated: DELETE /api/subdomains/:subdomain (delete)
  fastify.delete(
    "/subdomains/:subdomain",
    {
      preHandler: [fastify.authenticate], // ⭐️ Apply auth guard
    },
    async (request, reply) => {
      const { subdomain: rawSubdomain } = request.params;
      const { domain } = request.body || {};
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const userId = request.user.id;
      const domainName = (domain || "").trim().toLowerCase();

      if (!domainName) {
        return reply.code(400).send({ error: "domain is required" });
      }

      try {
        const managedDomains = await getManagedDomains(fastify);
        const domainEntry = managedDomains.find(
          (item) => item.normalized === domainName
        );

        if (!domainEntry) {
          return reply.code(400).send({
            error: "Requested domain is not managed by this service.",
          });
        }

        // Verify ownership
        const [rows] = await fastify.mysql.execute(
          "SELECT s.id, s.record_type FROM subdomains s WHERE s.subdomain = ? AND s.domain_id = ? AND s.user_id = ?",
          [subdomain, domainEntry.id, userId]
        );
        const record = rows[0];

        if (!record) {
          return reply.code(404).send({
            error: "Domain not found or you do not own this record.",
          });
        }

        const recordType = normalizeRecordType(record.record_type);

        await deleteSubdomain(fastify, {
          recordId: record.id,
          subdomain,
          domain: domainEntry.domain,
          recordType,
        });

        return reply.code(200).send({
          success: true,
          message: "Domain record deleted successfully.",
        });
      } catch (error) {
        fastify.log.error(error, "Failed to delete domain");
        return reply
          .code(500)
          .send({ error: "Server error during domain deletion" });
      }
    }
  );

  // POST /api/subdomains/:subdomain/txt
  fastify.post(
    "/subdomains/:subdomain/txt",
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { subdomain: rawSubdomain } = request.params;
      const { domain, txtValue } = request.body || {};
      const subdomain = (rawSubdomain || "").trim().toLowerCase();
      const userId = request.user.id;
      const domainName = (domain || "").trim().toLowerCase();
      const hostPrefix = "_vercel"; // As requested

      if (!domainName || !txtValue) {
        return reply
          .code(400)
          .send({ error: "Domain and TXT value are required" });
      }

      const txtValidation = validateTxtValue(txtValue);
      if (!txtValidation.valid) {
        return reply.code(400).send({ error: txtValidation.message });
      }
      const sanitizedTxtValue = txtValidation.value;

      try {
        const managedDomains = await getManagedDomains(fastify);
        const domainEntry = managedDomains.find(
          (item) => item.normalized === domainName
        );

        if (!domainEntry) {
          return reply.code(400).send({
            error: "Requested domain is not managed by this service.",
          });
        }

        // Verify ownership
        const [rows] = await fastify.mysql.execute(
          "SELECT id FROM subdomains WHERE subdomain = ? AND domain_id = ? AND user_id = ?",
          [subdomain, domainEntry.id, userId]
        );
        const record = rows[0];

        if (!record) {
          return reply.code(404).send({
            error: "Domain not found or you do not own this record.",
          });
        }
        const subdomainId = record.id;

        // Create/update TXT record in BIND
        await bindService.createOrUpdateTxtRecord(
          subdomain,
          domainEntry.domain,
          hostPrefix,
          sanitizedTxtValue
        );

        // Upsert into the database
        await fastify.mysql.execute(
          "INSERT INTO subdomain_txt_records (subdomain_id, host_prefix, txt_value) VALUES (?, ?, ?) " +
            "ON DUPLICATE KEY UPDATE txt_value = VALUES(txt_value)",
          [subdomainId, hostPrefix, sanitizedTxtValue]
        );

        fastify.log.info(
          `TXT record updated by user ${userId}: ${hostPrefix}.${subdomain}.${domainEntry.domain}`
        );
        return reply
          .code(200)
          .send({ success: true, message: "TXT record updated successfully." });
      } catch (error) {
        fastify.log.error(error, "Failed to update TXT record");
        return reply
          .code(500)
          .send({ error: "Server error during TXT record update" });
      }
    }
  );
}

module.exports = domainRoutes;
