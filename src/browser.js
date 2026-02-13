const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');

let browser = null;

async function launchBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  logger.info('Launching browser (headless)');
  browser = await chromium.launch({
    headless: config.browser.headless,
    executablePath: config.browser.executablePath,
    args: config.browser.args,
  });
  return browser;
}

async function newPage() {
  const b = await launchBrowser();
  const context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
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
