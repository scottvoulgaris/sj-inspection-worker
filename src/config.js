const config = {
  portal: {
    username: process.env.PORTAL_USERNAME,
    password: process.env.PORTAL_PASSWORD,
    loginUrl: 'https://sjpermits.org/permits/general/login.asp',
    baseUrl: 'https://sjpermits.org',
  },
  controlApp: {
    url: (process.env.CONTROL_APP_URL || '').replace(/\/$/, ''),
  },
  browser: {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  },
  timing: {
    cyclePauseMs: 60_000,
    jitterMinMs: 2_000,
    jitterMaxMs: 8_000,
    navigationTimeoutMs: 30_000,
    maxRetries: 5,
    backoffBaseMs: 1_000,
    backoffMaxMs: 120_000,
  },
  screenshotDir: './screenshots',
  dryRun: process.env.DRY_RUN !== 'false',
};

module.exports = config;
