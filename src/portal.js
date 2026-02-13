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

  const manageBtn = page.locator('button:has-text("Manage Inspections (Bldg & Fire)"), a:has-text("Manage Inspections (Bldg & Fire)"), input[value*="Manage Inspections"]');

  const btnCount = await manageBtn.count();
  if (btnCount === 0) {
    await takeScreenshot(page, 'manage-inspections-btn-not-found');
    throw new Error('Could not find "Manage Inspections (Bldg & Fire)" button');
  }

  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
    manageBtn.first().click({ timeout: 15_000 }),
  ]);

  let inspPage;
  if (popup) {
    logger.info('Manage Inspections opened in new window');
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForTimeout(2_000);
    inspPage = popup;
  } else {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2_000);
    inspPage = page;
  }
  logger.info('Clicked Manage Inspections');

  const bodyCheck = await inspPage.textContent('body').catch(() => '');
  if (!bodyCheck.includes('Permits Under Inspection') && !bodyCheck.includes('Permit/reference number Query')) {
    await takeScreenshot(inspPage, 'wrong-page-after-manage');
    throw new Error('Did not land on Manage Inspections page after clicking button');
  }

  const fileNumberLinks = inspPage.locator('table a').filter({ hasText: /\d{4}/ });
  const linkCount = await fileNumberLinks.count();
  logger.info(`Found ${linkCount} file number hyperlinks`);

  const permitNormalized = permitNumber.replace(/-/g, ' ');

  let matched = false;
  for (let i = 0; i < linkCount; i++) {
    const linkText = (await fileNumberLinks.nth(i).innerText()).trim();
    const linkNormalized = linkText.replace(/\s+/g, ' ');
    if (linkNormalized === permitNormalized) {
      logger.info(`Permit row found — file number "${linkText}"`);
      await Promise.all([
        inspPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
        fileNumberLinks.nth(i).click(),
      ]);
      logger.info('Clicked File Number link');
      matched = true;
      break;
    }
  }

  if (!matched) {
    await takeScreenshot(inspPage, `permit-not-found-${permitNumber}`);
    throw new PermitNotFoundError(`Permit ${permitNumber} not found in file number links`);
  }

  await inspPage.waitForLoadState('domcontentloaded').catch(() => null);
  await inspPage.waitForTimeout(2_000);

  const bodyText = await inspPage.textContent('body').catch(() => '');
  if (bodyText.includes('Scheduling or Changing Inspection Requests')) {
    logger.info(`Navigated to inspection scheduling page for permit ${permitNumber}`);
  } else {
    await takeScreenshot(inspPage, `unexpected-page-${permitNumber}`);
    logger.warn(`Did not reach scheduling page for ${permitNumber}`);
  }

  return { inspPage, permitNumber };
}

async function getAvailableDates(page) {
  logger.info('Extracting available inspection dates');

  const screenshotTarget = page.page ? page.page() : page;

  const selects = await page.$$('select');
  logger.info(`Found ${selects.length} select element(s) on page`);

  let dateSelect = null;
  for (const sel of selects) {
    const options = await sel.$$eval('option', (opts) =>
      opts.map((o) => o.textContent.trim())
    );
    const datePattern = /monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}\/\d{2,4}/i;
    const hasDateOption = options.some((t) => datePattern.test(t));
    if (hasDateOption) {
      dateSelect = sel;
      logger.info(`Found date dropdown with ${options.length} options`);
      break;
    }
  }

  if (!dateSelect) {
    logger.warn('No date dropdown found on page');
    await takeScreenshot(screenshotTarget, 'no-date-dropdown');
    return [];
  }

  const options = await dateSelect.$$eval('option', (opts) =>
    opts
      .map((o) => ({ value: o.value, text: o.textContent.trim() }))
      .filter((o) => o.value && o.value !== '' && o.text !== '')
  );

  logger.info(`Date options: ${options.map((o) => o.text).join(', ')}`);

  const dates = options
    .map((o) => {
      const parsed = new Date(o.text);
      if (!isNaN(parsed.getTime())) {
        return { raw: o.value, text: o.text, date: parsed };
      }
      const valParsed = new Date(o.value);
      if (!isNaN(valParsed.getTime())) {
        return { raw: o.value, text: o.text, date: valParsed };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  logger.info(`Found ${dates.length} available dates`);
  return dates;
}

async function rescheduleInspection(page, targetDate) {
  logger.info(`Attempting reschedule to ${targetDate.text} (${targetDate.raw})`);

  const screenshotTarget = page.page ? page.page() : page;

  const selects = await page.$$('select');
  let dateSelect = null;
  for (const sel of selects) {
    const options = await sel.$$eval('option', (opts) =>
      opts.map((o) => o.textContent.trim())
    );
    const datePattern = /monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}\/\d{2,4}/i;
    const hasDateOption = options.some((t) => datePattern.test(t));
    if (hasDateOption) {
      dateSelect = sel;
      break;
    }
  }
  if (!dateSelect) {
    throw new Error('Date dropdown not found for reschedule');
  }

  await dateSelect.selectOption(targetDate.raw);
  await takeScreenshot(screenshotTarget, 'pre-reschedule');

  const submitBtn = await page.$(
    'input[value*="Reschedule"], button:has-text("Reschedule"), input[value*="Schedule"], button:has-text("Submit"), input[type="submit"]'
  );

  if (!submitBtn) {
    await takeScreenshot(screenshotTarget, 'no-reschedule-button');
    throw new Error('Reschedule/submit button not found');
  }

  await submitBtn.click();
  await page.waitForLoadState('domcontentloaded');

  const screenshotFile = await takeScreenshot(screenshotTarget, 'post-reschedule');

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
