const config = require('./config');
const logger = require('./logger');
const { newPage, closeBrowser } = require('./browser');
const { login, navigateToInspections, getAvailableDates, rescheduleInspection, isSessionExpired, takeScreenshot, PermitNotFoundError } = require('./portal');
const { fetchPrioritizedInspections, postAutomationResult, sendHeartbeat, fetchAutomationSettings } = require('./api');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function parseFlexibleDate(dateStr) {
  if (!dateStr) return null;
  const currentYear = new Date().getFullYear();
  let parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) {
    parsed = new Date(`${dateStr}, ${currentYear}`);
  }
  if (isNaN(parsed.getTime())) {
    parsed = new Date(`${dateStr} ${currentYear}`);
  }
  if (isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() < 2020) {
    parsed.setFullYear(currentYear);
  }
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

async function processInspection(page, inspection) {
  const { id, permitNumber, projectName, inspectionType, currentScheduledDate, desiredDate, targetDate: overrideDate } = inspection;
  logger.info(`Processing inspection ${id} for permit ${permitNumber} (${projectName} — ${inspectionType})`);
  logger.info(`  Current scheduled: ${currentScheduledDate}, Preferred/desired: ${desiredDate || 'none'}, Override target: ${overrideDate || 'none'}`);

  if (isSessionExpired(page)) {
    logger.info('Session expired, re-authenticating');
    await login(page);
  }

  const { inspPage } = await navigateToInspections(page, permitNumber);
  const availableDates = await getAvailableDates(inspPage);

  if (availableDates.length === 0) {
    logger.info(`No available dates for inspection ${id} (permit ${permitNumber})`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'no_dates_available',
      availableDates: [],
    };
  }

  if (overrideDate) {
    return await processOverrideReschedule(inspPage, inspection, availableDates);
  }

  const currentDateObj = parseFlexibleDate(currentScheduledDate);
  if (!currentDateObj) {
    logger.error(`Could not parse currentScheduledDate: "${currentScheduledDate}" for inspection ${id}`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'error',
      error: `Could not parse current scheduled date: ${currentScheduledDate}`,
      availableDates: availableDates.map((d) => d.text),
    };
  }
  logger.info(`Current scheduled date parsed: ${currentDateObj.toISOString()}`);

  let preferredDateObj = null;
  if (desiredDate) {
    preferredDateObj = parseFlexibleDate(desiredDate);
    if (preferredDateObj) {
      logger.info(`Preferred/desired date parsed: ${preferredDateObj.toISOString()}`);
    } else {
      logger.warn(`Could not parse desiredDate: "${desiredDate}" — will ignore preferred date filter`);
    }
  }

  if (preferredDateObj && currentDateObj.getTime() < preferredDateObj.getTime()) {
    logger.warn(`Inspection ${id} is scheduled TOO SOON: current ${currentDateObj.toISOString()} is before preferred ${preferredDateObj.toISOString()}`);
    const correctionDates = availableDates.filter((d) => d.date.getTime() >= preferredDateObj.getTime());
    if (correctionDates.length === 0) {
      logger.warn(`No available dates on or after preferred date ${desiredDate} to correct inspection ${id}`);
      return {
        inspectionId: id,
        permitNumber,
        status: 'scheduled_too_soon_no_correction',
        currentScheduledDate,
        desiredDate,
        availableDates: availableDates.map((d) => d.text),
      };
    }
    const correctionDate = correctionDates[0];
    logger.info(`Correction target: ${correctionDate.text} (${correctionDate.date.toISOString()}) — first available on/after preferred ${desiredDate}`);

    if (config.dryRun) {
      logger.info(`DRY RUN — Would correct inspection ${id} from ${currentScheduledDate} to ${correctionDate.text} (scheduled before preferred date). No changes made.`);
      return {
        inspectionId: id,
        permitNumber,
        status: 'dry_run',
        reason: 'scheduled_too_soon',
        previousDate: currentScheduledDate,
        proposedDate: correctionDate.text,
        desiredDate,
        availableDates: availableDates.map((d) => d.text),
      };
    }

    const result = await rescheduleInspection(inspPage, correctionDate);
    return {
      inspectionId: id,
      permitNumber,
      status: result.success ? 'rescheduled_correction' : 'reschedule_uncertain',
      reason: 'scheduled_too_soon',
      previousDate: currentScheduledDate,
      newDate: correctionDate.text,
      desiredDate,
      screenshotFile: result.screenshotFile,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  let eligibleDates = availableDates.filter((d) => {
    const isEarlier = d.date.getTime() < currentDateObj.getTime();
    const isOnOrAfterPreferred = !preferredDateObj || d.date.getTime() >= preferredDateObj.getTime();
    logger.info(`Comparing: candidate=${d.date.toISOString()} current=${currentDateObj.toISOString()} preferred=${preferredDateObj ? preferredDateObj.toISOString() : 'none'} → earlier=${isEarlier}, afterPreferred=${isOnOrAfterPreferred}`);
    return isEarlier && isOnOrAfterPreferred;
  });

  if (eligibleDates.length === 0) {
    logger.info(`No eligible earlier dates for inspection ${id} (permit ${permitNumber}, current: ${currentScheduledDate}, preferred: ${desiredDate || 'none'})`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'no_earlier_date',
      currentScheduledDate,
      desiredDate: desiredDate || null,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const bestDate = eligibleDates[0];
  logger.info(`Found eligible earlier date: ${bestDate.text} (${bestDate.date.toISOString()}) vs current: ${currentScheduledDate} (${currentDateObj.toISOString()})${preferredDateObj ? ` [preferred: ${desiredDate}]` : ''}`);

  if (config.dryRun) {
    logger.info(`DRY RUN — Would reschedule inspection ${id} (permit ${permitNumber}) from ${currentScheduledDate} to ${bestDate.text}. No changes made.`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'dry_run',
      previousDate: currentScheduledDate,
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
    previousDate: currentScheduledDate,
    newDate: bestDate.text,
    desiredDate: desiredDate || null,
    screenshotFile: result.screenshotFile,
    availableDates: availableDates.map((d) => d.text),
  };
}

async function processOverrideReschedule(inspPage, inspection, availableDates) {
  const { id, permitNumber, targetDate: overrideDateStr, currentScheduledDate } = inspection;
  const overrideDateObj = parseFlexibleDate(overrideDateStr);
  if (!overrideDateObj) {
    logger.error(`Could not parse override targetDate: "${overrideDateStr}" for inspection ${id}`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'error',
      error: `Could not parse override target date: ${overrideDateStr}`,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  logger.info(`Override reschedule requested to: ${overrideDateObj.toISOString()}`);

  const match = availableDates.find((d) => d.date.getTime() === overrideDateObj.getTime());
  if (!match) {
    logger.warn(`Override target date ${overrideDateStr} is not available in dropdown`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'target_date_unavailable',
      requestedDate: overrideDateStr,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  logger.info(`Override target date found in dropdown: ${match.text}`);

  if (config.dryRun) {
    logger.info(`DRY RUN — Would override-reschedule inspection ${id} to ${match.text}. No changes made.`);
    return {
      inspectionId: id,
      permitNumber,
      status: 'dry_run',
      previousDate: currentScheduledDate,
      proposedDate: match.text,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const result = await rescheduleInspection(inspPage, match);

  return {
    inspectionId: id,
    permitNumber,
    status: result.success ? 'rescheduled' : 'reschedule_uncertain',
    previousDate: currentScheduledDate,
    newDate: match.text,
    override: true,
    screenshotFile: result.screenshotFile,
    availableDates: availableDates.map((d) => d.text),
  };
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
    cycleCount++;
    logger.info(`--- Cycle ${cycleCount} ---`);

    let page = null;

    try {
      await sendHeartbeat({
        cycle: cycleCount,
        consecutiveFailures,
      });

      const inspections = await fetchPrioritizedInspections();

      if (!inspections || inspections.length === 0) {
        logger.info('No inspections to process, waiting for next cycle');
        consecutiveFailures = 0;
        await sleep(config.timing.cyclePauseMs);
        continue;
      }

      const toProcess = inspections.slice(0, config.maxInspectionsPerCycle);
      logger.info(`Processing ${toProcess.length} of ${inspections.length} inspections this cycle`);

      page = await newPage();
      await login(page);

      for (const inspection of toProcess) {
        let attempt = 0;
        let processed = false;

        while (attempt < config.timing.maxRetries && !processed) {
          try {
            if (isSessionExpired(page)) {
              logger.info('Session expired mid-cycle, re-logging in');
              await login(page);
            }

            const result = await processInspection(page, inspection);
            await postAutomationResult(result);
            processed = true;

            await jitter();
          } catch (err) {
            if (err instanceof PermitNotFoundError) {
              logger.error(`Permit not found — skipping inspection ${inspection.id} (permit ${inspection.permitNumber}): ${err.message}`);
              await postAutomationResult({
                inspectionId: inspection.id,
                permitNumber: inspection.permitNumber,
                status: 'permit_not_found',
                error: err.message,
              });
              processed = true;
              break;
            }

            attempt++;
            const delay = backoffDelay(attempt);
            logger.error(
              `Error processing inspection ${inspection.id} (permit ${inspection.permitNumber}) (attempt ${attempt}/${config.timing.maxRetries})`,
              err.message
            );

            await takeScreenshot(page, `error-${inspection.id}-attempt${attempt}`);

            if (err.message.includes('Login failed') || err.message.includes('session')) {
              logger.info('Attempting fresh login after session error');
              try {
                await page.context().close();
              } catch (_) {}
              page = await newPage();
              await login(page);
            }

            if (attempt < config.timing.maxRetries) {
              logger.info(`Backing off for ${delay}ms before retry`);
              await sleep(delay);
            }
          }
        }

        if (!processed) {
          logger.error(`Exhausted retries for inspection ${inspection.id} (permit ${inspection.permitNumber})`);
          await postAutomationResult({
            inspectionId: inspection.id,
            permitNumber: inspection.permitNumber,
            status: 'failed',
            error: 'Max retries exhausted',
          });
        }
      }

      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      const delay = backoffDelay(consecutiveFailures);
      logger.error(`Cycle ${cycleCount} failed (consecutive failures: ${consecutiveFailures})`, err.message);

      if (page) {
        await takeScreenshot(page, `cycle-error-${cycleCount}`);
      }

      logger.info(`Backing off for ${delay}ms before next cycle`);
      await sleep(delay);
      continue;
    } finally {
      if (page) {
        try {
          await page.context().close();
        } catch (_) {}
      }
    }

    const settings = await fetchAutomationSettings();
    if (settings && settings.paused === true) {
      logger.info('Automation paused. Sleeping 60s.');
      await sleep(60_000);
      continue;
    }
    const pauseMs = settings && settings.pollingIntervalSeconds
      ? settings.pollingIntervalSeconds * 1000
      : 60_000;
    logger.info(`Cycle ${cycleCount} complete. Sleeping for ${pauseMs}ms`);
    await sleep(pauseMs);
  }
}

module.exports = { mainLoop };
