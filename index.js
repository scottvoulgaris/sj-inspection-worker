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

// --- Watchdog ---
// If no log heartbeat is observed within WATCHDOG_TIMEOUT_MS, kill the process.
// Fly will auto-restart per fly.toml.
const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
let lastHeartbeat = Date.now();

function pokeWatchdog() {
  lastHeartbeat = Date.now();
}

// Wrap console.log so every log line counts as a heartbeat.
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
console.log = (...args) => { pokeWatchdog(); originalLog.apply(console, args); };
console.error = (...args) => { pokeWatchdog(); originalError.apply(console, args); };
console.warn = (...args) => { pokeWatchdog(); originalWarn.apply(console, args); };

setInterval(() => {
  const sinceLast = Date.now() - lastHeartbeat;
  if (sinceLast > WATCHDOG_TIMEOUT_MS) {
    originalError.call(console, `[${new Date().toISOString()}] FATAL Watchdog: no activity for ${Math.round(sinceLast / 1000)}s. Killing process so Fly can restart.`);
    process.exit(1);
  }
}, 30_000).unref();

validateEnv();

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  pokeWatchdog();
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('worker alive');
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`HTTP listener on 0.0.0.0:${PORT}`);
  logger.info('Starting automation worker...');
  logger.info(`Watchdog enabled: process will exit if no log activity for ${WATCHDOG_TIMEOUT_MS / 1000}s`);
  mainLoop().catch((err) => {
    logger.error('Fatal error in main loop', err.message);
    closeBrowser().finally(() => process.exit(1));
  });
});
