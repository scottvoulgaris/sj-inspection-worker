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
      for (const f of toDelete) fs.unlinkSync(f.path);
      if (toDelete.length > 0) logger.info(`Cleaned up ${toDelete.length} old screenshots`);
    }
  } catch (err) {
    logger.warn(`Screenshot cleanup failed: ${err.message}`);
  }
}

class PermitNotFoundError extends Error {
  constructor(message) { super(message); this.name = 'PermitNotFoundError'; }
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
    await page.screenshot({ path: filePath, fullPage: true, timeout: 15_000 });
    return filePath;
  } catch (err) {
    logger.warn(`Screenshot failed (${label}): ${err.message}`);
    return null;
  }
}

async function login(page) {
  logger.info(`login: navigating to ${config.portal.loginUrl}`);
  try {
    await page.goto(config.portal.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    logger.info(`login: goto returned. current url: ${page.url()}`);
  } catch (err) {
    logger.error(`login: goto FAILED — ${err.name}: ${err.message}`);
    throw err;
  }

  const usernameSelector = 'input[name="email"], input[type="email"], #email, input[name="username"], input[name="userid"], input[type="text"]';
  try {
    logger.info('login: waiting for username field');
    await page.waitForSelector(usernameSelector, { timeout: 30_000 });
    logger.info('login: username field appeared');
  } catch (err) {
    await takeScreenshot(page, 'login-form-not-found');
    logger.error(`login: username field not found — ${err.message}`);
    throw new Error('Login form not found');
  }

  logger.info('login: filling username');
  await page.fill(usernameSelector, config.portal.username);
  logger.info('login: filling password');
  await page.fill('input[name="password"], input[type="password"], #password', config.portal.password);

  logger.info('login: clicking submit');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => logger.warn(`login: waitForNavigation: ${e.message}`)),
    page.click('input[type="submit"], button[type="submit"], #loginButton, .login-btn, button:has-text("Sign in"), input[value="Sign in"]'),
  ]);
  logger.info('login: post-submit settle wait');
  await page.waitForTimeout(3_000);

  const url = page.url();
  logger.info(`login: post-submit url: ${url}`);
  const bodyText = await page.textContent('body').catch(() => '');
  const isLoggedIn = (!url.includes('Login') && !url.includes('login')) || bodyText.includes('MY SERVICES') || bodyText.includes('My Permits') || bodyText.includes('Sign Out');
  if (!isLoggedIn) {
    await takeScreenshot(page, 'login-failed');
    throw new Error('Login failed');
  }
  logger.info('Login successful');
  return true;
}

async function extractConfirmationRows(inspPage, confirmationLinks, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const link = confirmationLinks.nth(i);
    const number = (await link.innerText().catch(() => '')).trim();
    let scheduledDate = '';
    let scheduledInspection = '';
    try {
      const tr = link.locator('xpath=ancestor::tr').first();
      const cells = await tr.locator('td').allInnerTexts();
      scheduledDate = (cells[1] || '').trim();
      scheduledInspection = (cells[2] || '').trim();
    } catch (_) {}
    rows.push({ confirmationNumber: number, scheduledDate, scheduledInspection });
  }
  return rows;
}

async function navigateToInspections(page, permitNumber, options = {}) {
  const { confirmationNumber } = options;
  logger.info(`Navigating to inspections for permit ${permitNumber}${confirmationNumber ? ` (confirmation ${confirmationNumber})` : ''}`);

  const manageBtn = page.locator('button:has-text("Manage Inspections (Bldg & Fire)"), a:has-text("Manage Inspections (Bldg & Fire)"), input[value*="Manage Inspections"]');
  if ((await manageBtn.count()) === 0) {
    await takeScreenshot(page, 'manage-inspections-btn-not-found');
    throw new Error('Could not find "Manage Inspections (Bldg & Fire)" button');
  }

  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
    manageBtn.first().click({ timeout: 15_000 }),
  ]);

  let inspPage;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForTimeout(2_000);
    inspPage = popup;
  } else {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2_000);
    inspPage = page;
  }

  const bodyCheck = await inspPage.textContent('body').catch(() => '');
  if (!bodyCheck.includes('Permits Under Inspection') && !bodyCheck.includes('Permit/reference number Query')) {
    await takeScreenshot(inspPage, 'wrong-page-after-manage');
    throw new Error('Did not land on Manage Inspections page');
  }

  const fileNumberLinks = inspPage.locator('table a').filter({ hasText: /\d{4}/ });
  const linkCount = await fileNumberLinks.count();
  const permitNormalized = permitNumber.replace(/-/g, ' ');

  let matched = false;
  for (let i = 0; i < linkCount; i++) {
    const linkText = (await fileNumberLinks.nth(i).innerText()).trim();
    if (linkText.replace(/\s+/g, ' ') === permitNormalized) {
      await Promise.all([
        inspPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
        fileNumberLinks.nth(i).click({ timeout: 15_000 }),
      ]);
      matched = true;
      break;
    }
  }
  if (!matched) {
    await takeScreenshot(inspPage, `permit-not-found-${permitNumber}`);
    throw new PermitNotFoundError(`Permit ${permitNumber} not found`);
  }

  await inspPage.waitForLoadState('domcontentloaded').catch(() => null);
  await inspPage.waitForTimeout(2_000);

  const schedulingBody = await inspPage.textContent('body').catch(() => '');
  const cannotSchedule =
    /you\s+cannot\s+schedule\s+an\s+Inspection/i.test(schedulingBody) ||
    /no\s+more\s+inspection\s+time\s+left/i.test(schedulingBody);

  const confirmationLinks = inspPage.locator('table a').filter({ hasText: /^\d+[A-Z]*\d*$/ });
  const confCount = await confirmationLinks.count();
  logger.info(`Found ${confCount} confirmation link(s); cannotSchedule=${cannotSchedule}`);

  if (confCount === 0) {
    if (cannotSchedule) return { status: 'no_inspection_time', inspPage, permitNumber };
    return { status: 'no_existing_inspections', inspPage, permitNumber };
  }

  let targetIdx = -1;
  if (confirmationNumber) {
    const wanted = String(confirmationNumber).trim();
    for (let i = 0; i < confCount; i++) {
      const t = (await confirmationLinks.nth(i).innerText()).trim();
      if (t === wanted) { targetIdx = i; break; }
    }
    if (targetIdx === -1) {
      const confirmations = await extractConfirmationRows(inspPage, confirmationLinks, confCount);
      await takeScreenshot(inspPage, `confirmation-not-found-${permitNumber}-${wanted}`);
      return { status: 'confirmation_not_found', inspPage, permitNumber, confirmations };
    }
  } else if (confCount === 1) {
    targetIdx = 0;
  } else {
    const confirmations = await extractConfirmationRows(inspPage, confirmationLinks, confCount);
    await takeScreenshot(inspPage, `multiple-confirmations-${permitNumber}`);
    return { status: 'multiple_confirmations', inspPage, permitNumber, confirmations };
  }

  const confText = (await confirmationLinks.nth(targetIdx).innerText()).trim();
  logger.info(`Clicking confirmation ${confText} (idx ${targetIdx})`);
  await Promise.all([
    inspPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
    confirmationLinks.nth(targetIdx).click({ timeout: 15_000 }),
  ]);
  await inspPage.waitForLoadState('domcontentloaded').catch(() => null);
  await inspPage.waitForTimeout(2_000);

  return { status: 'ok', inspPage, permitNumber, confirmationNumber: confText };
}

async function getAvailableDates(page) {
  const selects = await page.$$('select');
  let dateSelect = null;
  for (const sel of selects) {
    const options = await sel.$$eval('option', (opts) => opts.map((o) => o.textContent.trim()));
    const datePattern = /monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}\/\d{2,4}/i;
    if (options.some((t) => datePattern.test(t))) { dateSelect = sel; break; }
  }
  if (!dateSelect) {
    await takeScreenshot(page, 'no-date-dropdown');
    return [];
  }

  const options = await dateSelect.$$eval('option', (opts) =>
    opts.map((o) => ({ value: o.value, text: o.textContent.trim() }))
        .filter((o) => o.value && o.value !== '' && o.text !== '')
  );

  const toLocalMidnight = (year, month, day) => new Date(year, month, day, 0, 0, 0, 0);
  const tryParseMDY = (str) => {
    if (!str) return null;
    const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    const fullYear = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    return toLocalMidnight(fullYear, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  };
  const parseOptionDate = (text, value) => {
    const currentYear = new Date().getFullYear();
    let mdy = tryParseMDY(text) || tryParseMDY(value);
    if (mdy) return mdy;
    const iso = (text || '').match(/^(\d{4})-(\d{2})-(\d{2})/) || (value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return toLocalMidnight(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
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
    .map((o) => { const p = parseOptionDate(o.text, o.value); return p ? { raw: o.value, text: o.text, date: p } : null; })
    .filter(Boolean)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  logger.info(`Found ${dates.length} available dates: ${dates.map(d => `${d.text} (${d.date.toISOString().slice(0,10)})`).join(', ')}`);
  return dates;
}

async function rescheduleInspection(page, targetDate) {
  logger.info(`Rescheduling to ${targetDate.text} (${targetDate.raw})`);
  const dateSelect = page.locator('select').filter({ hasText: /monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december/i }).first();
  if ((await dateSelect.count()) === 0) throw new Error('Inspection Date dropdown not found');

  await dateSelect.selectOption(targetDate.raw);
  await page.waitForTimeout(1_000);

  const resubmitBtn = page.locator('input[value*="Resubmit"], button:has-text("Resubmit")').first();
  if ((await resubmitBtn.count()) === 0) {
    await takeScreenshot(page, 'no-resubmit-button');
    throw new Error('"Resubmit Request" button not found');
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
    resubmitBtn.click({ timeout: 15_000 }),
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
