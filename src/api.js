const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const client = axios.create({
  baseURL: config.controlApp.url,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

async function fetchPrioritizedInspections() {
  try {
    const res = await client.get('/inspections/prioritized');
    logger.info(`Fetched ${res.data.length || 0} prioritized inspections`);
    return res.data;
  } catch (err) {
    logger.error('Failed to fetch prioritized inspections', err.message);
    throw err;
  }
}

async function postAutomationResult(result) {
  try {
    const res = await client.post('/automation/result', result);
    logger.info('Posted automation result', { inspectionId: result.inspectionId, status: result.status });
    return res.data;
  } catch (err) {
    logger.error('Failed to post automation result', err.message);
  }
}

async function sendHeartbeat(payload) {
  try {
    await client.post('/automation/heartbeat', {
      timestamp: new Date().toISOString(),
      status: 'alive',
      ...payload,
    });
    logger.debug('Heartbeat sent');
  } catch (err) {
    logger.warn('Heartbeat failed', err.message);
  }
}

module.exports = {
  fetchPrioritizedInspections,
  postAutomationResult,
  sendHeartbeat,
};
