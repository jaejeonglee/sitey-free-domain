// services/anon-create-rate.js — how many records one anonymous caller may
// create in a minute.
//
// It used to be a single array for the whole process, so "three a minute" was
// three a minute *shared by every anonymous caller alive*. Four agents that
// have never heard of each other arriving together meant the fourth was
// refused for something the other three did, and one caller spending its three
// shut everybody else out until the minute was up. That was survivable while
// the only anonymous callers were people trying the API by hand; it stops
// being survivable on the day we are listed in the MCP registry and strangers
// start arriving in parallel.
//
// The subject is whatever the caller is: its owner token when it has one, and
// its IP when it does not. Either way the string handed in is the one the
// access log writes — `sub` for a token, `iph` for an address
// (services/access-log.js) — so a refusal here and that request's log line can
// be put side by side, and no raw address is ever held in memory.
//
// 🔴 A token subject is the weaker of the two as a flood guard, because a token
// is free to mint and an address is not. That is deliberate and it is not this
// file's job to make up for it: what this limit is for is fairness between
// anonymous callers sharing one exit address, which is why it stopped being a
// single global bucket. The ceilings that actually bound abuse are elsewhere —
// services/quota.js counts a token that owns nothing yet against its address,
// and the 100-a-minute @fastify/rate-limit in app.js keys on the address for
// every request that reaches /mcp.
//
// 🔴 The count is per process. pm2 runs this in fork mode with one instance
// (`pm2 start server.js --name server` — deploy/README.md), so one process is
// the whole service and the count is the truth. Starting more of them —
// `pm2 start -i N`, or cluster mode — multiplies the allowance by the number of
// workers without anything complaining. That is the day this has to move to
// the database or a shared store; until then the assumption is written here so
// the person who adds a worker meets it.

/** The limit itself. Unchanged: three creates per caller per minute. */
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 3;

/**
 * How many callers we will remember at once.
 *
 * An entry is a 16-character key and at most three numbers, so the ceiling is
 * a couple of megabytes. It is a long way above anything real — the server saw
 * two issue attempts in the week to 2026-09-14 — so reaching it means
 * something is wrong rather than something is popular.
 */
const MAX_SUBJECTS = 10000;

/** subject -> ascending timestamps of its attempts inside the window */
const hits = new Map();

/**
 * Cleaning happens on the way past rather than on a timer: a timer would have
 * to be unref'd and shut down for every test that touches this file, and a
 * limiter nobody is calling has nothing worth cleaning. One pass per window is
 * enough to hold the map at "callers seen in the last minute or so".
 */
let sweptAt = 0;

function prune(timestamps, now) {
  while (timestamps.length > 0 && timestamps[0] < now - WINDOW_MS) {
    timestamps.shift();
  }
}

/** Drop every subject whose attempts have all fallen out of the window. */
function sweep(now) {
  for (const [subject, timestamps] of hits) {
    prune(timestamps, now);
    if (timestamps.length === 0) hits.delete(subject);
  }
  sweptAt = now;
}

/**
 * May this caller create one more right now?
 *
 * @param {string|null} subject  what the access log calls this caller: `t:` and
 *   the head of its token hash, or its hashed IP (services/access-log.js)
 * @returns {{ok: boolean, reason: null|"rate"|"capacity"}}
 *   `capacity` is worth telling apart from `rate`: it says we refused someone
 *   we had no room to count, which is a fact about us, not about them.
 */
function check(subject) {
  const now = Date.now();

  // A caller we cannot name shares one bucket with every other unnamed caller.
  // That is the old global behaviour, kept for the one case where it is the
  // strict answer rather than the loose one — the alternative, a free pass for
  // anyone arriving without an address, is the bug this file exists to fix.
  const key = subject || "unidentified";

  if (now - sweptAt >= WINDOW_MS) sweep(now);

  let timestamps = hits.get(key);
  if (!timestamps) {
    if (hits.size >= MAX_SUBJECTS) {
      sweep(now); // a caller may well have aged out since the last pass
      if (hits.size >= MAX_SUBJECTS) {
        // Full means refuse, not wave through. Letting new callers past
        // unchecked is exactly the failure this guards against, and evicting
        // somebody to make room hands a reset to whoever floods hardest.
        // The cost is that a flood of distinct addresses can lock out callers
        // we have never seen — visible in the log, and it drains a minute
        // after the flood stops.
        return { ok: false, reason: "capacity" };
      }
    }
    timestamps = [];
    hits.set(key, timestamps);
  }

  prune(timestamps, now);
  if (timestamps.length >= MAX_PER_WINDOW) {
    return { ok: false, reason: "rate" };
  }

  timestamps.push(now);
  return { ok: true, reason: null };
}

/** How many callers are being remembered — for the log line and the tests. */
function subjectCount() {
  return hits.size;
}

module.exports = { check, subjectCount, WINDOW_MS, MAX_PER_WINDOW, MAX_SUBJECTS };
