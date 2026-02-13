const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

fs.mkdirSync(config.screenshotDir, { recursive: true });

class PermitNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermitNotFoundError';
  }
}

function screenshotPath(label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(config.screenshotDir, `${label}_${ts}.png`);
}

async function takeScreenshot(page, label) {
  fs.mkdirSync(config.screenshotDir, { recursive: true });
  const filePath = path.resolve(screenshotPath(label));
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    logger.info(`Screenshot saved: ${filePath}`);
    return filePath;
  } catch (err) {
    logger.warn(`Screenshot failed (${label})`, err.message);
    return null;
  }
}

async function login(page) {
  logger.info('Navigating to login page');
  await page.goto(config.portal.loginUrl, { waitUntil: 'domcontentloaded' });

  const usernameSelector = 'input[name="email"], input[type="email"], #email, input[name="username"], input[name="userid"], input[type="text"]';
  try {
    await page.waitForSelector(usernameSelector, { timeout: 60_000 });
    logger.info('Login page loaded successfully');
  } catch {
    await takeScreenshot(page, 'login-form-not-found');
    logger.error('Login form not found');
    throw new Error('Login form not found — username field did not appear within 60s');
  }

  await page.fill(usernameSelector, config.portal.username);
  await page.fill('input[name="password"], input[type="password"], #password', config.portal.password);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null),
    page.click('input[type="submit"], button[type="submit"], #loginButton, .login-btn, button:has-text("Sign in"), input[value="Sign in"]'),
  ]);

  await page.waitForTimeout(3_000);

  const url = page.url();
  const bodyText = await page.textContent('body').catch(() => '');
  const isLoggedIn =
    (!url.includes('Login') && !url.includes('login')) ||
    bodyText.includes('MY SERVICES') ||
    bodyText.includes('My Permits') ||
    bodyText.includes('Sign Out');
  if (!isLoggedIn) {
    await takeScreenshot(page, 'login-failed');
    throw new Error('Login failed – still on login page after submit');
  }

  logger.info('Login successful');
  return true;
}

async function navigateToInspections(page, permitNumber) {
  logger.info(`Navigating to inspections for permit: ${permitNumber}`);

  try {
    await page.click('text=My Services', { timeout: 10_000 });
    await page.waitForLoadState('domcontentloaded');
  } catch {
    logger.warn('Could not find "My Services" link, trying alternative navigation');
    await page.goto(`${config.portal.baseUrl}/permits/general/myservices.asp`, {
      waitUntil: 'domcontentloaded',
    });
  }

  try {
    await page.click('text=Manage Inspections', { timeout: 10_000 });
    await page.waitForLoadState('domcontentloaded');
  } catch {
    logger.warn('Could not find "Manage Inspections" link, trying alternative');
    await page.goto(`${config.portal.baseUrl}/permits/general/manageinspections.asp`, {
      waitUntil: 'domcontentloaded',
    });
  }

  const permitInput = await page.$('input[name="permit"], input[name="permitNumber"], #permitNumber');
  if (permitInput) {
    await permitInput.fill(permitNumber);
    await page.click('input[type="submit"], button[type="submit"], #searchButton');
    await page.waitForLoadState('domcontentloaded');
  } else {
    const permitLink = await page.$(`text=${permitNumber}`);
    if (permitLink) {
      await permitLink.click();
      await page.waitForLoadState('domcontentloaded');
    } else {
      throw new PermitNotFoundError(`Permit ${permitNumber} not found in portal`);
    }
  }

  const bodyText = await page.textContent('body').catch(() => '');
  const notFoundIndicators = ['not found', 'no results', 'no record', 'does not exist', 'invalid permit'];
  const lowerBody = bodyText.toLowerCase();
  for (const indicator of notFoundIndicators) {
    if (lowerBody.includes(indicator)) {
      await takeScreenshot(page, `permit-not-found-${permitNumber}`);
      throw new PermitNotFoundError(`Permit ${permitNumber} not found in portal (page contains "${indicator}")`);
    }
  }

  logger.info(`Navigated to permit ${permitNumber}`);
}

async function getAvailableDates(page) {
  logger.info('Extracting available inspection dates');

  const dateSelect = await page.$(
    'select[name="inspectionDate"], select[name="date"], #inspectionDate, select.inspection-date'
  );

  if (!dateSelect) {
    logger.warn('No date dropdown found on page');
    await takeScreenshot(page, 'no-date-dropdown');
    return [];
  }

  const options = await dateSelect.$$eval('option', (opts) =>
    opts
      .map((o) => ({ value: o.value, text: o.textContent.trim() }))
      .filter((o) => o.value && o.value !== '' && o.value !== 'Select')
  );

  const dates = options
    .map((o) => {
      const parsed = new Date(o.value || o.text);
      return isNaN(parsed.getTime()) ? null : { raw: o.value, text: o.text, date: parsed };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  logger.info(`Found ${dates.length} available dates`);
  return dates;
}

async function rescheduleInspection(page, targetDate) {
  logger.info(`Attempting reschedule to ${targetDate.text} (${targetDate.raw})`);

  const dateSelect = await page.$(
    'select[name="inspectionDate"], select[name="date"], #inspectionDate, select.inspection-date'
  );
  if (!dateSelect) {
    throw new Error('Date dropdown not found for reschedule');
  }

  await dateSelect.selectOption(targetDate.raw);
  await takeScreenshot(page, 'pre-reschedule');

  const submitBtn = await page.$(
    'input[value*="Reschedule"], button:has-text("Reschedule"), input[value*="Schedule"], button:has-text("Submit"), input[type="submit"]'
  );

  if (!submitBtn) {
    await takeScreenshot(page, 'no-reschedule-button');
    throw new Error('Reschedule/submit button not found');
  }

  await submitBtn.click();
  await page.waitForLoadState('domcontentloaded');

  const screenshotFile = await takeScreenshot(page, 'post-reschedule');

  const pageText = await page.textContent('body');
  const success =
    pageText.toLowerCase().includes('successfully') ||
    pageText.toLowerCase().includes('rescheduled') ||
    pageText.toLowerCase().includes('confirmed');

  logger.info(`Reschedule result: ${success ? 'SUCCESS' : 'UNCERTAIN'}`);
  return { success, screenshotFile, targetDate: targetDate.text };
}

function isSessionExpired(page) {
  const url = page.url();
  return url.includes('login') || url.includes('session') || url.includes('timeout');
}

module.exports = {
  login,
  navigateToInspections,
  getAvailableDates,
  rescheduleInspection,
  isSessionExpired,
  takeScreenshot,
  PermitNotFoundError,
};
