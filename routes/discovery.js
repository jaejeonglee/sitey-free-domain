// routes/discovery.js — serves the documents in services/discovery.js.
//
// Not under /api: public/robots.txt disallows /api/, and a document a crawler
// is told not to read is not discovery. These paths are the ones the readers
// already look at — /.well-known/mcp.json for an agent runtime, and the two
// added alongside it for anything else that arrives before a person does.
const config = require("../configs/index");
const { getManagedDomains } = require("../services/managedDomain");
const discovery = require("../services/discovery");

// An hour. These change when a setting changes, which is a deploy, and a
// crawler holding yesterday's copy of them costs nobody anything.
const CACHE = "public, max-age=3600";

async function discoveryRoutes(fastify, options) {
  const origin = config.server.publicOrigin;

  fastify.get("/.well-known/mcp.json", async (request, reply) => {
    const domains = (await getManagedDomains(fastify)).map((d) => d.domain);
    return reply
      .type("application/json; charset=utf-8")
      .header("Cache-Control", CACHE)
      .send(discovery.mcpManifest({ origin, domains }));
  });

  // Built once: it describes routes and settings, and neither changes while
  // the process is up.
  const openApi = discovery.openApi({ origin });

  fastify.get("/openapi.json", async (request, reply) =>
    reply.type("application/json; charset=utf-8").header("Cache-Control", CACHE).send(openApi)
  );

  // ERC-8004 agent card — services/discovery.js agentCard. Built once here so
  // an AGENT_ID / AGENT_REGISTRY that does not parse stops the boot rather
  // than turning this and /llms.txt into 500s; served fresh per request
  // because x402Support follows the payment switch.
  discovery.agentCard({ origin });
  fastify.get("/.well-known/agent-registration.json", async (request, reply) =>
    reply
      .type("application/json; charset=utf-8")
      .header("Cache-Control", CACHE)
      .send(discovery.agentCard({ origin }))
  );

  // RFC 9116 — services/discovery.js securityTxt. Expires is computed per
  // request, a year out, so a day's caching never serves a stale one.
  fastify.get("/.well-known/security.txt", async (request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", "public, max-age=86400")
      .send(discovery.securityTxt({ origin }))
  );

  // Markdown, served as text/plain: llmstxt.org asks for a file a reader can
  // take in without parsing anything, and a browser that lands on it should
  // show it rather than offer to download it.
  fastify.get("/llms.txt", async (request, reply) => {
    const domains = (await getManagedDomains(fastify)).map((d) => d.domain);
    return reply
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", CACHE)
      .send(discovery.llmsTxt({ origin, domains }));
  });
}

module.exports = discoveryRoutes;
