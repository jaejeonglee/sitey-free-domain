const fp = require("fastify-plugin");
const config = require("../configs/index");
const { runExpiryJob } = require("../services/expiry-job");

// Same shape as plugins/validation-scheduler.js: first run at the next
// midnight, daily after that. Kept as its own plugin rather than folded into
// the validation pass because the two answer different questions and are
// switched on independently — reachability only ever reports, expiry is what
// removes things.
function getMsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  return midnight - now;
}

async function expiryScheduler(fastify) {
  if (config.bind.devMode) {
    fastify.log.info("Expiry scheduler disabled in dev mode");
    return;
  }

  let intervalId = null;
  let initialTimeoutId = null;

  fastify.addHook("onReady", async () => {
    const msUntilMidnight = getMsUntilMidnight();
    fastify.log.info(
      { evt: "expiry_scheduled", reminders: config.expiry.remindersEnabled, deletion: config.expiry.deletionEnabled },
      `Expiry pass scheduled: first run in ${Math.round(msUntilMidnight / 1000 / 60)} minutes (at midnight)`
    );

    const run = () =>
      runExpiryJob(fastify).catch((err) => {
        fastify.log.error(err, "Expiry pass failed");
      });

    initialTimeoutId = setTimeout(() => {
      run();
      intervalId = setInterval(run, config.expiry.intervalMs);
    }, msUntilMidnight);
  });

  fastify.addHook("onClose", async () => {
    if (initialTimeoutId) clearTimeout(initialTimeoutId);
    if (intervalId) clearInterval(intervalId);
  });
}

module.exports = fp(expiryScheduler);
