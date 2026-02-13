function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info(msg, data) {
    console.log(`[${timestamp()}] INFO  ${msg}`, data !== undefined ? data : '');
  },
  warn(msg, data) {
    console.warn(`[${timestamp()}] WARN  ${msg}`, data !== undefined ? data : '');
  },
  error(msg, data) {
    console.error(`[${timestamp()}] ERROR ${msg}`, data !== undefined ? data : '');
  },
  debug(msg, data) {
    if (process.env.DEBUG === 'true') {
      console.log(`[${timestamp()}] DEBUG ${msg}`, data !== undefined ? data : '');
    }
  },
};

module.exports = logger;
