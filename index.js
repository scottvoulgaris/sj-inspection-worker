const http = require('http');
const { mainLoop } = require('./src/worker');
const { closeBrowser } = require('./src/browser');
const logger = require('./src/logger');

function validateEnv() {
  const required = ['PORTAL_USERNAME', 'PORTAL_PASSWORD', 'CONTROL_APP_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', reason));
process.on('uncaughtException', (err) => logger.error('Uncaught exception', err.message));

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  process.shuttingDown = true;
  setTimeout(async () => {
    await closeBrowser();
    process.exit(0);
  }, 5000);
}

// --- Watchdog (CYCLE-BASED) ---
// The watchdog ONLY resets when the worker explicitly reports a completed cycle
// via global.notifyCycleCompleted(). HTTP requests and log activity do NOT reset it.
// This guarantees the watchdog fires if the cycle loop is dead, even if the HTTP
// listener is still responding to Fly's health checks.
const WATCHDOG_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
let lastCycleCompletedAt = Date.now();

global.notifyCycleCompleted = function () {
  lastCycleCompletedAt = Date.now();
};

setInterval(() => {
  const sinceLast = Date.now() - lastCycleCompletedAt;
  if (sinceLast > WATCHDOG_TIMEOUT_MS) {
    const ageSec = Math.round(sinceLast / 1000);
    console.error(`[${new Date().toISOString()}] FATAL Watchdog: no cycle completion for ${ageSec}s (limit ${WATCHDOG_TIMEOUT_MS / 1000}s). Killing process so Fly can restart.`);
    process.exit(1);
  }
}, 30_000).unref();

validateEnv();

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Intentionally does NOT poke the watchdog — HTTP responsiveness is not proof
  // that the cycle loop is alive.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('worker alive');
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`HTTP listener on 0.0.0.0:${PORT}`);
  logger.info('Starting automation worker...');
  logger.info(`Watchdog enabled: process will exit if no cycle completes for ${WATCHDOG_TIMEOUT_MS / 1000}s`);
  mainLoop().catch((err) => {
    logger.error('Fatal error in main loop', err.message);
    closeBrowser().finally(() => process.exit(1));
  });
});
