const config = require('./config');
const logger = require('./logger');
const { newPage, closeBrowser } = require('./browser');
const { login, navigateToInspections, getAvailableDates, rescheduleInspection, isSessionExpired, takeScreenshot } = require('./portal');
const { fetchPrioritizedInspections, postAutomationResult, sendHeartbeat } = require('./api');

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

async function processInspection(page, inspection) {
  const { permitNumber, inspectionId, currentDate } = inspection;
  logger.info(`Processing inspection ${inspectionId} for permit ${permitNumber}`);

  if (isSessionExpired(page)) {
    logger.info('Session expired, re-authenticating');
    await login(page);
  }

  await navigateToInspections(page, permitNumber);
  const availableDates = await getAvailableDates(page);

  if (availableDates.length === 0) {
    logger.info(`No available dates for inspection ${inspectionId}`);
    return {
      inspectionId,
      permitNumber,
      status: 'no_dates_available',
      availableDates: [],
    };
  }

  const currentDateObj = new Date(currentDate);
  const earlierDates = availableDates.filter((d) => d.date < currentDateObj);

  if (earlierDates.length === 0) {
    logger.info(`No earlier dates available for inspection ${inspectionId} (current: ${currentDate})`);
    return {
      inspectionId,
      permitNumber,
      status: 'no_earlier_date',
      currentDate,
      availableDates: availableDates.map((d) => d.text),
    };
  }

  const targetDate = earlierDates[0];
  logger.info(`Found earlier date: ${targetDate.text} (current: ${currentDate})`);

  const result = await rescheduleInspection(page, targetDate);

  return {
    inspectionId,
    permitNumber,
    status: result.success ? 'rescheduled' : 'reschedule_uncertain',
    previousDate: currentDate,
    newDate: targetDate.text,
    screenshotFile: result.screenshotFile,
    availableDates: availableDates.map((d) => d.text),
  };
}

async function mainLoop() {
  logger.info('=== Automation worker starting ===');
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

      page = await newPage();
      await login(page);

      for (const inspection of inspections) {
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
            attempt++;
            const delay = backoffDelay(attempt);
            logger.error(
              `Error processing inspection ${inspection.inspectionId} (attempt ${attempt}/${config.timing.maxRetries})`,
              err.message
            );

            await takeScreenshot(page, `error-${inspection.inspectionId}-attempt${attempt}`);

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
          logger.error(`Exhausted retries for inspection ${inspection.inspectionId}`);
          await postAutomationResult({
            inspectionId: inspection.inspectionId,
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

    logger.info(`Cycle ${cycleCount} complete. Pausing ${config.timing.cyclePauseMs}ms`);
    await sleep(config.timing.cyclePauseMs);
  }
}

module.exports = { mainLoop };
