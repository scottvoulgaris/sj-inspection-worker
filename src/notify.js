const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Teams alerting with first-occurrence-only semantics.
//
// An alert fires the FIRST time a condition is seen and then stays silent while
// that same condition keeps repeating cycle after cycle. It re-arms only when
// the condition clears (a successful login, a completed cycle, an inspection
// that processes cleanly), so a recovery followed by a new failure alerts again.
//
// Dedup state is persisted to disk so a worker restart — watchdog kill, Fly
// redeploy, crash loop — does not re-announce conditions that were already
// reported. If the state file is unreadable/unwritable we fall back to
// in-memory only rather than failing the worker.

const WEBHOOK_URL = (process.env.TEAMS_WEBHOOK_URL || '').trim();
const STATE_FILE = path.resolve(process.env.TEAMS_ALERT_STATE_FILE || './alert-state.json');

// 0 = never re-post while the condition persists (default, per requirement).
// Set to e.g. 24 to allow a reminder after a condition has been active that long.
const REPEAT_HOURS = Number(process.env.TEAMS_ALERT_REPEAT_HOURS) || 0;

const SEVERITY = {
  error: { color: 'Attention', icon: '🚨' },
  warning: { color: 'Warning', icon: '⚠️' },
};

let active = new Map();

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      active = new Map(Object.entries(raw));
      logger.info(`Teams alert state loaded: ${active.size} active condition(s)`);
    }
  } catch (err) {
    logger.warn(`Could not load Teams alert state, starting fresh: ${err.message}`);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(active)));
  } catch (err) {
    logger.warn(`Could not persist Teams alert state: ${err.message}`);
  }
}

loadState();

function shouldSend(key) {
  const existing = active.get(key);
  if (!existing) return true;
  if (REPEAT_HOURS <= 0) return false;
  const ageMs = Date.now() - new Date(existing.notifiedAt).getTime();
  return ageMs >= REPEAT_HOURS * 60 * 60 * 1000;
}

function buildCard({ title, subtitle, facts, severity }) {
  const { color, icon } = SEVERITY[severity] || SEVERITY.error;
  const body = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      color,
      wrap: true,
      text: `${icon} ${title}`,
    },
  ];

  if (subtitle) {
    body.push({ type: 'TextBlock', text: subtitle, wrap: true, isSubtle: true, spacing: 'None' });
  }

  const factList = Object.entries(facts || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([title_, value]) => ({ title: title_, value: String(value) }));

  if (factList.length > 0) body.push({ type: 'FactSet', facts: factList });

  body.push({
    type: 'TextBlock',
    size: 'Small',
    isSubtle: true,
    wrap: true,
    text: `Inspection worker · ${config.dryRun ? 'DRY RUN' : 'LIVE'} · ${new Date().toISOString()}`,
  });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}

/**
 * Fire an alert for `key` unless that condition is already active.
 * Never throws — notification failures must not break the worker loop.
 */
async function alert({ key, title, subtitle, facts, severity = 'error' }) {
  if (!WEBHOOK_URL) {
    logger.debug(`Teams webhook not configured; skipping alert: ${key}`);
    return false;
  }
  if (!shouldSend(key)) {
    const existing = active.get(key);
    existing.count = (existing.count || 1) + 1;
    active.set(key, existing);
    saveState();
    logger.debug(`Teams alert suppressed (already active, seen ${existing.count}x): ${key}`);
    return false;
  }

  try {
    await axios.post(WEBHOOK_URL, buildCard({ title, subtitle, facts, severity }), {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
    const prev = active.get(key);
    active.set(key, {
      firstSeenAt: prev ? prev.firstSeenAt : new Date().toISOString(),
      notifiedAt: new Date().toISOString(),
      count: prev ? (prev.count || 1) + 1 : 1,
    });
    saveState();
    logger.info(`Teams alert sent: ${key}`);
    return true;
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}` : err.message;
    logger.error(`Teams alert failed (${key}): ${detail}`);
    return false;
  }
}

/** Re-arm a condition so the next occurrence alerts again. */
function clear(key) {
  if (active.delete(key)) {
    saveState();
    logger.debug(`Teams alert condition cleared: ${key}`);
  }
}

/** Re-arm every condition whose key starts with `prefix`. */
function clearPrefix(prefix) {
  let changed = false;
  for (const key of [...active.keys()]) {
    if (key.startsWith(prefix)) {
      active.delete(key);
      changed = true;
    }
  }
  if (changed) saveState();
}

// --- Condition-specific helpers -------------------------------------------

const loginFailed = (error, url) =>
  alert({
    key: 'login_failed',
    title: 'Portal login failed',
    subtitle: 'The worker cannot sign in to the San José permits portal. Rescheduling is stopped until this clears.',
    facts: { Error: error, 'Login URL': url, Account: config.portal.username },
    severity: 'error',
  });

const loginRecovered = () => clear('login_failed');

const cycleFailed = (cycleNumber, error, consecutiveFailures) =>
  alert({
    key: 'cycle_error',
    title: 'Worker cycle failed',
    subtitle: 'The automation cycle threw before completing. It will retry with backoff.',
    facts: { Cycle: cycleNumber, Error: error, 'Consecutive failures': consecutiveFailures },
    severity: 'error',
  });

const cycleRecovered = () => clear('cycle_error');

const inspectionFailed = (inspection, error) =>
  alert({
    key: `failed:${inspection.id}`,
    title: 'Inspection failed after max retries',
    subtitle: 'The worker exhausted all retries for this inspection and moved on.',
    facts: {
      Permit: inspection.permitNumber,
      Project: inspection.projectName,
      Type: inspection.inspectionType,
      'Inspection ID': inspection.id,
      Error: error,
    },
    severity: 'error',
  });

const permitNotFound = (inspection, error) =>
  alert({
    key: `permit_not_found:${inspection.permitNumber}`,
    title: 'Permit not found in portal',
    subtitle: 'The permit number could not be located on the Manage Inspections page.',
    facts: {
      Permit: inspection.permitNumber,
      Project: inspection.projectName,
      'Inspection ID': inspection.id,
      Error: error,
    },
    severity: 'warning',
  });

const confirmationNotFound = (result) =>
  alert({
    key: `confirmation_not_found:${result.permitNumber}:${result.requestedConfirmation}`,
    title: 'Confirmation number not found',
    subtitle: 'The requested confirmation number is not listed for this permit.',
    facts: {
      Permit: result.permitNumber,
      Requested: result.requestedConfirmation,
      Available: (result.confirmations || []).map((c) => c.confirmationNumber).join(', '),
      'Inspection ID': result.inspectionId,
    },
    severity: 'warning',
  });

const multipleConfirmations = (result) =>
  alert({
    key: `multiple_confirmations:${result.permitNumber}`,
    title: 'Multiple confirmations — selection required',
    subtitle: 'This permit has more than one inspection on file. Pick one in the control app so the worker knows which to move.',
    facts: {
      Permit: result.permitNumber,
      Count: (result.confirmations || []).length,
      Confirmations: (result.confirmations || [])
        .map((c) => `${c.confirmationNumber} (${c.scheduledDate} ${c.scheduledInspection})`.trim())
        .join(' · '),
      'Inspection ID': result.inspectionId,
    },
    severity: 'warning',
  });

/**
 * Route a per-inspection result to Teams. Healthy outcomes re-arm this
 * inspection's conditions so a future failure alerts again.
 */
async function notifyForResult(result) {
  if (!result) return;
  switch (result.status) {
    case 'permit_not_found':
      return permitNotFound(
        { id: result.inspectionId, permitNumber: result.permitNumber, projectName: result.projectName },
        result.error
      );
    case 'confirmation_not_found':
      return confirmationNotFound(result);
    case 'multiple_confirmations_pending_selection':
      return multipleConfirmations(result);
    case 'failed':
      return inspectionFailed(
        { id: result.inspectionId, permitNumber: result.permitNumber },
        result.error
      );
    default:
      // Any other status means the worker reached and read the record fine.
      clear(`failed:${result.inspectionId}`);
      clear(`permit_not_found:${result.permitNumber}`);
      clear(`multiple_confirmations:${result.permitNumber}`);
      clearPrefix(`confirmation_not_found:${result.permitNumber}:`);
      return undefined;
  }
}

module.exports = {
  alert,
  clear,
  clearPrefix,
  notifyForResult,
  loginFailed,
  loginRecovered,
  cycleFailed,
  cycleRecovered,
  inspectionFailed,
  permitNotFound,
  isConfigured: () => Boolean(WEBHOOK_URL),
};
