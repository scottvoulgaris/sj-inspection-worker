const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

fs.mkdirSync(config.screenshotDir, { recursive: true });

const MAX_SCREENSHOTS = parseInt(process.env.MAX_SCREENSHOTS, 10) || 50;

function cleanupOldScreenshots() {
  try {
    const files = fs.readdirSync(config.screenshotDir)
      .filter(f => f.endsWith('.png'))
      .map(f => ({
        name: f,
        path: path.join(config.screenshotDir, f),
        mtime: fs.statSync(path.join(config.screenshotDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > MAX_SCREENSHOTS) {
      const toDelete = files.slice(MAX_SCREENSHOTS);
      for (const f of toDelete) {
        fs.unlinkSync(f.path);
      }
      if (toDelete.length > 0) {
        logger.info(`Cleaned up ${toDelete.length} old screenshots (keeping ${MAX_SCREENSHOTS})`);
      }
    }
  } catch (err) {
    logger.warn(`Screenshot cleanup failed: ${err.message}`);
  }
}

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
  cleanupOldScreenshots();
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
  await page.goto(config.portal.loginUrl, { waitUntil: 'domcontentloaded', timeout: config.timing.navigationTimeoutMs });

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

  await takeScreenshot(inspPage, `scheduling-page-${permitNumber}`);

  const confirmationLinks = inspPage.locator('table a').filter({ hasText: /^\d+[A-Z]*\d*$/ });
  const confCount = await confirmationLinks.count();
  logger.info(`Found ${confCount} confirmation number link(s)`);

  if (confCount === 0) {
    await takeScreenshot(inspPage, `no-confirmation-links-${permitNumber}`);
    throw new Error(`No confirmation number links found for permit ${permitNumber}`);
  }

  const confText = (await confirmationLinks.first().innerText()).trim();
  logger.info(`Clicking confirmation number: ${confText}`);

  await Promise.all([
    inspPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
    confirmationLinks.first().click(),
  ]);

  await inspPage.waitForLoadState('domcontentloaded').catch(() => null);
  await inspPage.waitForTimeout(2_000);

  const modifyText = await inspPage.textContent('body').catch(() => '');
  if (modifyText.includes('Modify Inspection Request')) {
    logger.info(`Navigated to Modify Inspection Request page for permit ${permitNumber} (confirmation ${confText})`);
  } else {
    await takeScreenshot(inspPage, `unexpected-modify-page-${permitNumber}`);
    logger.warn(`Did not reach Modify Inspection Request page for ${permitNumber}`);
  }

  await takeScreenshot(inspPage, `modify-page-${permitNumber}`);

  return { inspPage, permitNumber, confirmationNumber: confText };
}

async function getAvailableDates(page) {
  logger.info('Extracting available inspection dates');

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
    await takeScreenshot(page, 'no-date-dropdown');
    return [];
  }

  const options = await dateSelect.$$eval('option', (opts) =>
    opts
      .map((o) => ({ value: o.value, text: o.textContent.trim() }))
      .filter((o) => o.value && o.value !== '' && o.text !== '')
  );

  logger.info(`Date options: ${options.map((o) => o.text).join(', ')}`);

  const toLocalMidnight = (year, month, day) => new Date(year, month, day, 0, 0, 0, 0);

  const tryParseMDY = (str) => {
    if (!str) return null;
    const mdyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!mdyMatch) return null;
    const [, m, d, y] = mdyMatch;
    const fullYear = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10);
    return toLocalMidnight(fullYear, parseInt(m, 10) - 1, parseInt(d, 10));
  };

  const parseOptionDate = (text, value) => {
    const currentYear = new Date().getFullYear();

    let mdy = tryParseMDY(text) || tryParseMDY(value);
    if (mdy) return mdy;

    const isoMatch = (text || '').match(/^(\d{4})-(\d{2})-(\d{2})/) || (value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return toLocalMidnight(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
    }

    let parsed = new Date(text);
    if (isNaN(parsed.getTime())) parsed = new Date(`${text}, ${currentYear}`);
    if (isNaN(parsed.getTime())) parsed = new Date(`${text} ${currentYear}`);
    if (isNaN(parsed.getTime())) parsed = new Date(value);
    if (isNaN(parsed.getTime())) parsed = new Date(`${value}, ${currentYear}`);
    if (isNaN(parsed.getTime())) return null;

    const yr = parsed.getFullYear() < 2020 ? currentYear : parsed.getFullYear();
    return toLocalMidnight(yr, parsed.getMonth(), parsed.getDate());
  };

  const dates = options
    .map((o) => {
      const parsed = parseOptionDate(o.text, o.value);
      if (!parsed) {
        logger.warn(`Could not parse date from option: text="${o.text}" value="${o.value}"`);
        return null;
      }
      return { raw: o.value, text: o.text, date: parsed };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  logger.info(`Found ${dates.length} available dates`);
  for (const d of dates) {
    logger.info(`  Date option: "${d.text}" → ${d.date.toISOString()}`);
  }
  return dates;
}

async function rescheduleInspection(page, targetDate) {
  logger.info(`Attempting reschedule to ${targetDate.text} (${targetDate.raw})`);

  const dateSelect = page.locator('select').filter({ hasText: /monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december/i }).first();
  const selectCount = await dateSelect.count();
  if (selectCount === 0) {
    throw new Error('Inspection Date dropdown not found on Modify page');
  }

  await dateSelect.selectOption(targetDate.raw);
  logger.info(`Selected date: ${targetDate.text}`);
  await page.waitForTimeout(1_000);
  await takeScreenshot(page, 'pre-resubmit');

  const resubmitBtn = page.locator('input[value*="Resubmit"], button:has-text("Resubmit")').first();
  const btnCount = await resubmitBtn.count();
  if (btnCount === 0) {
    await takeScreenshot(page, 'no-resubmit-button');
    throw new Error('"Resubmit Request" button not found on Modify page');
  }

  logger.info('Clicking "Resubmit Request" button');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
    resubmitBtn.click(),
  ]);

  await page.waitForLoadState('domcontentloaded').catch(() => null);
  await page.waitForTimeout(2_000);

  const screenshotFile = await takeScreenshot(page, 'post-resubmit');

  const pageText = await page.textContent('body').catch(() => '');
  const success =
    pageText.toLowerCase().includes('successfully') ||
    pageText.toLowerCase().includes('rescheduled') ||
    pageText.toLowerCase().includes('confirmed') ||
    pageText.toLowerCase().includes('scheduled');

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
