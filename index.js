const express = require('express');
const https = require('https');
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

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
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

validateEnv();

const app = express();
const PORT = process.env.PORT || 3000;

let workerStatus = 'starting';
let keepAliveInterval = null;

const PING_INTERVAL = 4 * 60 * 1000;

function getSelfUrl() {
  return process.env.SELF_PING_URL || null;
}

function startKeepAlive(url) {
  if (keepAliveInterval) return;
  if (!url) return;

  logger.info(`Keep-alive pings enabled — pinging ${url} every ${PING_INTERVAL / 1000}s`);

  keepAliveInterval = setInterval(() => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      res.resume();
      logger.info(`Keep-alive ping: ${res.statusCode}`);
    }).on('error', (err) => {
      logger.warn(`Keep-alive ping failed: ${err.message}`);
    });
  }, PING_INTERVAL);
}

function tryAutoDetectAndStartKeepAlive(req) {
  if (keepAliveInterval) return;
  if (getSelfUrl()) return;

  if (req.headers.host) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const autoUrl = `${protocol}://${req.headers.host}/health`;
    logger.info(`Auto-detected self URL from request: ${autoUrl}`);
    startKeepAlive(autoUrl);
  }
}

function healthResponse(req, res) {
  tryAutoDetectAndStartKeepAlive(req);
  res.status(200).json({ status: 'ok', worker: workerStatus, uptime: process.uptime() });
}

app.get('/', healthResponse);
app.get('/health', healthResponse);

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Health server listening on 0.0.0.0:${PORT}`);

  startKeepAlive(getSelfUrl());

  workerStatus = 'running';
  logger.info('Automation worker initializing...');
  mainLoop().catch((err) => {
    workerStatus = 'error';
    logger.error('Fatal error in main loop', err.message);
    closeBrowser().finally(() => process.exit(1));
  });
});
