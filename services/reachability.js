// services/reachability.js — does this name actually open?
//
// The nightly check used to ask a different question per record type: a TCP
// connect for A, `dns.resolve(target)` for CNAME. Neither one is "does the site
// open". `dns.resolve` in particular passes for every Vercel deployment that
// was deleted — the CDN hostname the CNAME points at stays in DNS long after
// the deployment behind it is gone, so the target resolves forever.
//
// Measured 2026-09-08 across all 44 issued subdomains: 19 served a page,
// 20 could not be connected to at all, 5 answered with 404/403/502. The check
// as written called nearly all 44 healthy.
//
// So we make the request. The verdict table below is the whole policy, in one
// place, so tests can pin it.

const http = require("http");
const https = require("https");
const net = require("net");

const USER_AGENT = "sitey-reachability/1.0 (+https://sitey.my)";

// A gateway with nothing behind it. These are the *only* status codes that
// mean "the site is not there" — every other response came from something that
// answered for this name.
//
//   401 / 403 — a server is there and chose not to let us in.
//   404       — alive too (decided 2026-09-08). Plenty of working sites serve
//               nothing at "/" and everything under a path, and the cost of
//               being wrong here is telling somebody their site is down when
//               it is not.
//   5xx other — a 500 means an application is there and crashed. Something is
//               deployed; that is what we are measuring.
const DEAD_STATUSES = new Set([502, 503, 504]);

/**
 * The verdict table. Any HTTP response other than a bare gateway error counts
 * as alive.
 */
function isAliveStatus(status) {
  return !DEAD_STATUSES.has(status);
}

/**
 * One HTTP(S) request, status line only.
 *
 * @param {object} params
 * @param {"http"|"https"} params.protocol
 * @param {string} params.host      - where to connect: the record's value
 * @param {number} params.port
 * @param {string} [params.hostname] - the name to present in Host/SNI; the
 *   subdomain's own FQDN when we know it, because a CDN routes on that name
 *   and not on the CNAME target we dialled
 * @param {number} params.timeoutMs
 * @returns {Promise<{ok: boolean, status: number|null, check: string, detail: string}>}
 *   `status` is null when nothing answered — that is how the caller tells a
 *   refused connection from a server that replied.
 */
function probeOrigin({ protocol, host, port, hostname, timeoutMs }) {
  const client = protocol === "https" ? https : http;
  const presented = hostname || host;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = client.request(
      {
        host,
        port,
        path: "/",
        method: "GET",
        headers: {
          host: presented,
          "user-agent": USER_AGENT,
          connection: "close",
        },
        timeout: timeoutMs,
        // We are asking whether a server answers for this name, not whether we
        // can trust it. An expired certificate, or one issued for the CDN's
        // own name rather than the user's, still means the site is there.
        rejectUnauthorized: false,
        // SNI carries a name; an IP there is a protocol error and some stacks
        // drop the handshake rather than ignore it.
        servername: net.isIP(presented) ? undefined : presented,
      },
      (response) => {
        const status = response.statusCode;
        // We only wanted the status line. Draining lets the socket close
        // instead of sitting in the pool until the timeout.
        response.resume();
        finish({
          ok: isAliveStatus(status),
          status,
          check: protocol,
          detail: isAliveStatus(status)
            ? `${protocol} answered ${status}`
            : `${protocol} answered ${status} — gateway with nothing behind it`,
        });
      }
    );

    request.on("timeout", () => {
      request.destroy();
      finish({
        ok: false,
        status: null,
        check: protocol,
        detail: `${protocol} timed out after ${timeoutMs}ms`,
      });
    });

    request.on("error", (err) => {
      finish({
        ok: false,
        status: null,
        check: protocol,
        detail: `${protocol} failed: ${err.code || err.message}`,
      });
    });

    request.end();
  });
}

/**
 * HTTPS first, HTTP as a fallback.
 *
 * The fallback is for hosts that never got a certificate, so it only runs when
 * HTTPS could not be *connected to*. Once a server answers — with anything,
 * including a 502 — that answer is the verdict; retrying on the other port
 * would turn "the gateway is broken" into "alive" via a redirect page.
 */
async function probeHost({ host, hostname, timeoutMs }) {
  const secure = await probeOrigin({
    protocol: "https",
    host,
    port: 443,
    hostname,
    timeoutMs,
  });
  if (secure.status !== null) return secure;

  const plain = await probeOrigin({
    protocol: "http",
    host,
    port: 80,
    hostname,
    timeoutMs,
  });
  if (plain.status !== null) return plain;

  return {
    ok: false,
    status: null,
    check: "http",
    detail: `${secure.detail}; ${plain.detail}`,
  };
}

module.exports = { DEAD_STATUSES, isAliveStatus, probeOrigin, probeHost };
