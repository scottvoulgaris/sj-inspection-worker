const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');

let browser = null;

async function launchBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  logger.info('Launching browser (headless)');
  logger.info(`  executablePath: ${config.browser.executablePath || '(playwright bundled)'}`);
  logger.info(`  args: ${JSON.stringify(config.browser.args)}`);

  try {
    browser = await chromium.launch({
      headless: config.browser.headless,
      executablePath: config.browser.executablePath,
      args: config.browser.args,
      timeout: 30_000,
    });
    logger.info('Browser launched successfully');
    return browser;
  } catch (err) {
    logger.error('Browser launch FAILED');
    logger.error(`  error name: ${err.name}`);
    logger.error(`  error message: ${err.message}`);
    logger.error(`  error stack: ${err.stack}`);
    throw err;
  }
}

async function newPage() {
  logger.info('newPage: getting browser');
  const b = await launchBrowser();

  logger.info('newPage: creating context');
  const context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  logger.info('newPage: context created');

  logger.info('newPage: creating page');
  const page = await context.newPage();
  logger.info('newPage: page created');

  page.setDefaultTimeout(config.timing.navigationTimeoutMs);
  return page;
}

async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch (_) {}
    browser = null;
  }
}

module.exports = { launchBrowser, newPage, closeBrowser };
