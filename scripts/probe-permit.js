#!/usr/bin/env node
//
// READ-ONLY portal probe.
//
// Walks the full automation path — login → Manage Inspections → permit search →
// scheduling page → confirmation selection → available dates — and STOPS before
// anything is changed.
//
// This script deliberately does NOT import rescheduleInspection. Nothing here
// selects a date or clicks "Resubmit Request", so it cannot modify a booking
// even if it is run with the wrong arguments. It only fills the permit search
// box and clicks confirmation-number hyperlinks.
//
// Usage:
//   node scripts/probe-permit.js "2026 107657 RS"
//   node scripts/probe-permit.js "2026 107657 RS" --current-date "Sep 03, 2026"
//   node scripts/probe-permit.js "2026 107657 RS" --type Piers --confirmation 2556247
//
// Credentials come from .env (gitignored) or the environment.

const fs = require('fs');
const path = require('path');

// Minimal .env loader — avoids adding a dependency for a dev-only script.
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// The probe never posts results anywhere; satisfy config's expectations only.
process.env.CONTROL_APP_URL = process.env.CONTROL_APP_URL || 'https://probe.invalid';
// Belt and braces: even though no reschedule code path is reachable from here.
process.env.DRY_RUN = 'true';

const args = process.argv.slice(2);
const permitNumber = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

if (!permitNumber) {
  console.error('Usage: node scripts/probe-permit.js "<permit number>" [--current-date D] [--type T] [--confirmation N]');
  process.exit(1);
}

for (const key of ['PORTAL_USERNAME', 'PORTAL_PASSWORD']) {
  if (!process.env[key]) {
    console.error(`Missing ${key}. Put it in .env at the repo root or export it.`);
    process.exit(1);
  }
}

const { newPage, closeBrowser } = require('../src/browser');
const {
  login,
  navigateToInspections,
  getAvailableDates,
  takeScreenshot,
  permitSearchCandidates,
  PermitNotFoundError,
} = require('../src/portal');

const rule = (label) => console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);

async function main() {
  rule('PROBE — READ ONLY (no rescheduling code path is reachable)');
  console.log(`Permit:        ${permitNumber}`);
  console.log(`Search terms:  ${permitSearchCandidates(permitNumber).join(' → ')}`);
  console.log(`Account:       ${process.env.PORTAL_USERNAME}`);
  console.log(`Current date:  ${flag('current-date') || '(not supplied)'}`);
  console.log(`Type:          ${flag('type') || '(not supplied)'}`);
  console.log(`Confirmation:  ${flag('confirmation') || '(auto-select)'}`);

  const page = await newPage();

  rule('STEP 1 — Login');
  await login(page);
  await takeScreenshot(page, 'probe-01-after-login');
  console.log(`Landed on: ${page.url()}`);

  rule('STEP 2..4 — Manage Inspections → permit search → confirmation');
  const nav = await navigateToInspections(page, permitNumber, {
    confirmationNumber: flag('confirmation'),
    currentScheduledDate: flag('current-date'),
    inspectionType: flag('type'),
  });

  console.log(`\nnav.status = ${nav.status}`);
  if (nav.confirmations) {
    console.log('\nConfirmations found on the permit:');
    for (const c of nav.confirmations) {
      console.log(`  ${c.confirmationNumber.padEnd(12)} ${String(c.scheduledDate).padEnd(16)} ${c.scheduledInspection}`);
    }
  }

  if (nav.status !== 'ok') {
    await takeScreenshot(nav.inspPage || page, `probe-02-stopped-${nav.status}`);
    rule(`STOPPED — status "${nav.status}"`);
    console.log('The worker would report this status and move on without rescheduling.');
    return;
  }

  console.log(`Selected confirmation: ${nav.confirmationNumber}`);
  await takeScreenshot(nav.inspPage, 'probe-02-modify-page');

  rule('STEP 5 — Available dates (read only)');
  const dates = await getAvailableDates(nav.inspPage);
  if (dates.length === 0) {
    console.log('No dates parsed from the Inspection Date dropdown.');
  } else {
    for (const d of dates) {
      console.log(`  ${d.date.toISOString().slice(0, 10)}   raw="${d.raw}"   text="${d.text}"`);
    }
  }
  await takeScreenshot(nav.inspPage, 'probe-03-dates-read');

  rule('DONE — stopped before rescheduling');
  console.log('Reached the Modify page and read the date dropdown. Nothing was submitted.');
}

main()
  .catch((err) => {
    console.error(`\nPROBE FAILED — ${err instanceof PermitNotFoundError ? 'PermitNotFound' : err.name}: ${err.message}`);
    if (process.env.DEBUG === 'true') console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowser();
    console.log('\nScreenshots: ./screenshots/probe-*.png');
  });
