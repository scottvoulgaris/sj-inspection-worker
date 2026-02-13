const express = require('express');
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

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err.message);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Worker running');
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Health server listening on 0.0.0.0:${PORT}`);
});

validateEnv();
logger.info('Automation worker initializing...');
mainLoop().catch((err) => {
  logger.error('Fatal error in main loop', err.message);
  closeBrowser().finally(() => process.exit(1));
});
