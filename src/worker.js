const config = require('./config');
const logger = require('./logger');
const { newPage, closeBrowser } = require('./browser');
const {
  login,
  navigateToInspections,
  getAvailableDates,
  rescheduleInspection,
  isSessionExpired,
  takeScreenshot,
  PermitNotFoundError,
} = require('./portal');
const {
  fetchPrioritizedInspections,
  postAutomationResult,
  sendHeartbeat,
  fetchAutomationSettings,
} = require('./api');

const DEFAULT_NOTICE_HOURS = 24;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function jitter() {
  const { jitterMinMs, jitterMaxMs } = config.timing;
  const delay = jitterMinMs + Math.random() * (jitterMaxMs - jitterMinMs);
  return sleep(delay);
}

function backoffDelay(attempt) {
  const { backoffBaseMs, backoffMaxMs } = config.timing;
  const delay = Math.min(backoffBaseMs * Math.pow(2, attempt), backoffMaxMs);
  const withJitter = delay * (0.5 + Math.random());
  return Math.floor(withJitter);
}

function toLocalMidnight(year, month, day) {
  return new Date(year, month, day, 0, 0, 0, 0);
}

function todayLocalMidnight() {
  const n = new Date();
  return toLocalMidnight(n.getFullYear(), n.getMonth(), n.getDate());
}

function normalizeNoticeHours(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_NOTICE_HOURS;
}

function getEarliestAllowedDate(noticeHours) {
  const hours = normalizeNoticeHours(noticeHours);
  const now = new Date();
  const cutoff = new Date(now.getTime() + hours * 60 * 60 * 1000);
  const floor = toLocalMidnight(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate());
  if (floor.getTime() < cutoff.getTime()) floor.setDate(floor.getDate() + 1);
  return floor;
}

function parseFlexibleDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s) return null;
  const currentYear = new Date().getFullYear();

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return toLocalMidnight(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));

  const mdyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    const fullYear = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10);
    return toLocalMidnight(fullYear, parseInt(m, 10) - 1, parseInt(d, 10));
  }

  let parsed = new Date(s);
  if (isNaN(parsed.getTime())) parsed = new Date(`${s}, ${currentYear}`);
  if (isNaN(parsed.getTime())) parsed = new Date(`${s} ${currentYear}`);
  if (isNaN(parsed.getTime())) return null;
  const yr = parsed.getFullYear() < 2020 ? currentYear : parsed.getFullYear();
  return toLocalMidnight(yr, parsed.getMonth(), parsed.getDate());
}

async function processInspection(page, inspection) {
  const {
    id,
    permitNumber,
    projectName,
    inspectionType,
    currentScheduledDate,
    desiredDate,
    targetDate: overrideDate,
    minNoticeHours,
    confirmationNumber,
  } = inspection;

  const noticeHours = normalizeNoticeHours(minNoticeHours);
  logger.info(`Processing inspection ${id} for permit ${permitNumber} (${projectName} — ${inspectionType})`);
  logger.info(`  Current: ${currentScheduledDate}, Desired: ${desiredDate || 'none'}, Override: ${overrideDate || 'none'}, Notice: ${noticeHours}h, Confirmation: ${confirmationNumber || 'auto'}`);

  // Defensive past-due skip.
  const currentDateObj = parseFlexibleDate(currentScheduledDate);
  const today = todayLocalMidnight();
  if (currentDateObj && currentDateObj.getTime() <= today.getTime()) {
    logger.info(`Inspection ${id} is past-due (${currentScheduledDate} <= today). Skipping.`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'locked_date_reached',
      oldDate: currentScheduledDate,
    };
  }

  const nav = await navigateToInspections(page, permitNumber, { confirmationNumber });

  if (nav.status === 'no_inspection_time') {
    return { inspectionId: id, permitNumber, status: 'no_inspection_time' };
  }
  if (nav.status === 'no_existing_inspections') {
    return { inspectionId: id, permitNumber, status: 'no_existing_inspections' };
  }
  if (nav.status === 'multiple_confirmations') {
    logger.warn(`Permit ${permitNumber} has ${nav.confirmations.length} confirmations; selection required.`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'multiple_confirmations_pending_selection',
      confirmations: nav.confirmations,
    };
  }
  if (nav.status === 'confirmation_not_found') {
    return {
      inspectionId: id,
      permitNumber,
      status: 'confirmation_not_found',
      requestedConfirmation: confirmationNumber,
      confirmations: nav.confirmations,
    };
  }
  if (nav.status !== 'ok') {
    logger.error(`Unexpected nav status: ${nav.status}`);
    return { inspectionId: id, permitNumber, status: 'error', error: `Unexpected nav status: ${nav.status}` };
  }

  const { inspPage } = nav;
  const availableDates = await getAvailableDates(inspPage);

  if (availableDates.length === 0) {
    logger.info(`No available dates for inspection ${id} (permit ${permitNumber})`);
    return { inspectionId: id, permitNumber, status: 'no_dates_available', availableDates: [] };
  }

  if (overrideDate) {
    return await processOverrideReschedule(inspPage, inspection, availableDates, noticeHours);
  }

  if (!currentDateObj) {
    return {
      inspectionId: id,
      permitNumber,
      status: 'error',
      error: `Could not parse current scheduled date: ${currentScheduledDate}`,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  let preferredDateObj = null;
  if (desiredDate) {
    preferredDateObj = parseFlexibleDate(desiredDate);
    if (!preferredDateObj) logger.warn(`Could not parse desiredDate: "${desiredDate}" — ignoring`);
  }

  const earliestAllowed = getEarliestAllowedDate(noticeHours);
  logger.info(`Earliest allowed (${noticeHours}h notice): ${earliestAllowed.toISOString()}`);

  if (preferredDateObj && currentDateObj.getTime() < preferredDateObj.getTime()) {
    const correctionDates = availableDates.filter(
      (d) => d.date.getTime() >= preferredDateObj.getTime() && d.date.getTime() >= earliestAllowed.getTime()
    );
    if (correctionDates.length === 0) {
      return {
        inspectionId: id,
        permitNumber,
        status: 'scheduled_too_soon_no_correction',
        oldDate: currentScheduledDate,
        desiredDate,
        availableDates: availableDates.map((d) => d.text),
      };
    }
    const correctionDate = correctionDates[0];
    if (config.dryRun) {
      return {
        inspectionId: id,
        permitNumber,
        status: 'dry_run',
        reason: 'scheduled_too_soon',
        oldDate: currentScheduledDate,
        proposedDate: correctionDate.text,
        desiredDate,
        availableDates: availableDates.map((d) => d.text),
      };
    }
    const result = await rescheduleInspection(inspPage, correctionDate);
    return {
      inspectionId: id,
      permitNumber,
      status: result.success ? 'rescheduled' : 'reschedule_uncertain',
      reason: 'scheduled_too_soon',
      oldDate: currentScheduledDate,
      newDate: correctionDate.text,
      desiredDate,
      screenshotFile: result.screenshotFile,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const eligibleDates = availableDates.filter((d) => {
    const isEarlier = d.date.getTime() < currentDateObj.getTime();
    const isOnOrAfterPreferred = !preferredDateObj || d.date.getTime() >= preferredDateObj.getTime();
    const isFarEnoughOut = d.date.getTime() >= earliestAllowed.getTime();
    return isEarlier && isOnOrAfterPreferred && isFarEnoughOut;
  });

  if (eligibleDates.length === 0) {
    // NEW: compute dates that would have been eligible if not for the notice window.
    // These are "manually bookable" — the team can call the city to book them by hand.
    const manuallyBookableDates = availableDates
      .filter((d) => {
        const isEarlier = d.date.getTime() < currentDateObj.getTime();
        const isOnOrAfterPreferred = !preferredDateObj || d.date.getTime() >= preferredDateObj.getTime();
        const isInsideNoticeWindow = d.date.getTime() < earliestAllowed.getTime();
        const isInFuture = d.date.getTime() > today.getTime();
        return isEarlier && isOnOrAfterPreferred && isInsideNoticeWindow && isInFuture;
      })
      .map((d) => d.text);

    if (manuallyBookableDates.length > 0) {
      logger.info(`Manually-bookable dates (inside ${noticeHours}h notice): ${manuallyBookableDates.join(', ')}`);
    }

    return {
      inspectionId: id,
      permitNumber,
      status: 'no_earlier_date',
      oldDate: currentScheduledDate,
      desiredDate: desiredDate || null,
      availableDates: availableDates.map((d) => d.text),
      manuallyBookableDates,
    };
  }

  const bestDate = eligibleDates[0];
  if (config.dryRun) {
    return {
      inspectionId: id,
      permitNumber,
      status: 'dry_run',
      oldDate: currentScheduledDate,
      proposedDate: bestDate.text,
      desiredDate: desiredDate || null,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const result = await rescheduleInspection(inspPage, bestDate);
  return {
    inspectionId: id,
    permitNumber,
    status: result.success ? 'rescheduled' : 'reschedule_uncertain',
    oldDate: currentScheduledDate,
    newDate: bestDate.text,
    desiredDate: desiredDate || null,
    screenshotFile: result.screenshotFile,
    availableDates: availableDates.map((d) => d.text),
  };
}

async function processOverrideReschedule(inspPage, inspection, availableDates, noticeHours) {
  const { id, permitNumber, targetDate: overrideDateStr, currentScheduledDate } = inspection;
  const overrideDateObj = parseFlexibleDate(overrideDateStr);
  if (!overrideDateObj) {
    return {
      inspectionId: id, permitNumber, status: 'error',
      error: `Could not parse override target date: ${overrideDateStr}`,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const earliestAllowed = getEarliestAllowedDate(noticeHours);
  if (overrideDateObj.getTime() < earliestAllowed.getTime()) {
    return {
      inspectionId: id, permitNumber, status: 'target_date_too_soon',
      requestedDate: overrideDateStr,
      earliestAllowed: earliestAllowed.toISOString(),
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const match = availableDates.find((d) => d.date.getTime() === overrideDateObj.getTime());
  if (!match) {
    return {
      inspectionId: id, permitNumber, status: 'target_date_unavailable',
      requestedDate: overrideDateStr,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  if (config.dryRun) {
    return {
      inspectionId: id, permitNumber, status: 'dry_run',
      oldDate: currentScheduledDate, proposedDate: match.text,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const result = await rescheduleInspection(inspPage, match);
  return {
    inspectionId: id, permitNumber,
    status: result.success ? 'rescheduled' : 'reschedule_uncertain',
    oldDate: currentScheduledDate, newDate: match.text,
    override: true, screenshotFile: result.screenshotFile,
    availableDates: availableDates.map((d) => d.text),
  };
}

async function freshPage(oldPage) {
  if (oldPage) {
    try { await oldPage.context().close(); } catch (_) {}
  }
  const newP = await newPage();
  await login(newP);
  return newP;
}

async function mainLoop() {
  logger.info('=== Automation worker starting ===');
  logger.info(`DRY_RUN env raw value: "${process.env.DRY_RUN}" → dryRun=${config.dryRun}`);
  if (config.dryRun) {
    logger.info('*****************************************************');
    logger.info('*** DRY RUN MODE — No changes will be made        ***');
    logger.info('*** Set DRY_RUN=false to enable live rescheduling ***');
    logger.info('*****************************************************');
  }
  logger.info(`Control API: ${config.controlApp.url}`);
  logger.info(`Portal: ${config.portal.loginUrl}`);

  let consecutiveFailures = 0;
  let cycleCount = 0;

  while (true) {
    if (process.shuttingDown) { logger.info('Shutdown signal received'); break; }
    cycleCount++;
    logger.info(`--- Cycle ${cycleCount} ---`);
    let page = null;

    try {
      await sendHeartbeat({ cycle: cycleCount, consecutiveFailures });
      const inspections = await fetchPrioritizedInspections();
      if (!inspections || inspections.length === 0) {
        consecutiveFailures = 0;
        if (typeof global.notifyCycleCompleted === 'function') global.notifyCycleCompleted();
        await sleep(config.timing.cyclePauseMs);
        continue;
      }
      const toProcess = inspections.slice(0, config.maxInspectionsPerCycle);
      page = await newPage();
      await login(page);

      for (const inspection of toProcess) {
        let attempt = 0;
        let processed = false;
        while (attempt < config.timing.maxRetries && !processed) {
          try {
            if (isSessionExpired(page)) {
              logger.info('Session expired; refreshing page');
              page = await freshPage(page);
            }
            const result = await processInspection(page, inspection);
            await postAutomationResult(result);
            processed = true;
            await jitter();
          } catch (err) {
            if (err instanceof PermitNotFoundError) {
              await postAutomationResult({
                inspectionId: inspection.id, permitNumber: inspection.permitNumber,
                status: 'permit_not_found', error: err.message,
              });
              processed = true;
              break;
            }
            attempt++;
            const delay = backoffDelay(attempt);
            logger.error(`Error processing inspection ${inspection.id} (attempt ${attempt}/${config.timing.maxRetries}): ${err.message}`);
            logger.info('Recreating page after error before retry');
            try {
              page = await freshPage(page);
            } catch (recreateErr) {
              logger.error(`freshPage failed: ${recreateErr.message}`);
            }
            if (attempt < config.timing.maxRetries) await sleep(delay);
          }
        }
        if (!processed) {
          await postAutomationResult({
            inspectionId: inspection.id, permitNumber: inspection.permitNumber,
            status: 'failed', error: 'Max retries exhausted',
          });
        }
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      const delay = backoffDelay(consecutiveFailures);
      logger.error(`Cycle ${cycleCount} failed: ${err.message}`);
      await sleep(delay);
      continue;
    } finally {
      if (page) { try { await page.context().close(); } catch (_) {} }
    }

    if (typeof global.notifyCycleCompleted === 'function') global.notifyCycleCompleted();

    const settings = await fetchAutomationSettings();
    if (settings && settings.paused === true) {
      await sleep(60_000);
      continue;
    }
    const pauseMs = settings && settings.pollingIntervalSeconds
      ? settings.pollingIntervalSeconds * 1000
      : 300_000;
    logger.info(`Cycle ${cycleCount} complete. Sleeping ${pauseMs}ms`);
    await sleep(pauseMs);
  }
}

module.exports = { mainLoop };
