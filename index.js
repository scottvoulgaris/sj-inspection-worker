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

validateEnv();

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('worker alive');
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`HTTP listener on 0.0.0.0:${PORT}`);
  logger.info('Starting automation worker...');
  mainLoop().catch((err) => {
    logger.error('Fatal error in main loop', err.message);
    closeBrowser().finally(() => process.exit(1));
  });
});
