const config = {
  portal: {
    username: process.env.PORTAL_USERNAME,
    password: process.env.PORTAL_PASSWORD,
    loginUrl: 'https://portal.sanjoseca.gov/deployed/sfjsp?interviewID=Login',
    baseUrl: 'https://portal.sanjoseca.gov',
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
    navigationTimeoutMs: 60_000,
    maxRetries: 5,
    backoffBaseMs: 1_000,
    backoffMaxMs: 120_000,
  },
  screenshotDir: './screenshots',
  dryRun: (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false',
  maxInspectionsPerCycle: parseInt(process.env.MAX_INSPECTIONS_PER_CYCLE, 10) || 3,
};

module.exports = config;
