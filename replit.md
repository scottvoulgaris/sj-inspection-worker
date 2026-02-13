# Inspection Automation Worker

## Overview
A continuous Node.js background worker using Playwright to automate inspection rescheduling on the City of San José permits portal. This is NOT a web app — it runs as a long-lived process in an infinite loop.

## Current State
- Project created: Feb 2026
- Status: Ready to run (requires environment variables)

## Architecture

### Entry Point
- `index.js` — Validates env vars, sets up signal handlers, starts the main loop

### Source Modules (`src/`)
- `config.js` — Centralized configuration (browser settings, timing, URLs)
- `logger.js` — Timestamped structured logging
- `api.js` — HTTP client for control app (fetch inspections, post results, heartbeat)
- `browser.js` — Playwright browser lifecycle management
- `portal.js` — San José portal automation (login, navigation, date extraction, rescheduling)
- `worker.js` — Main loop with retry logic, backoff, jitter, and heartbeat

### Key Functions
- `login(page)` — Authenticates with the San José portal via portal.sanjoseca.gov
- `navigateToInspections(page, permitNumber)` — Clicks "Manage Inspections (Bldg & Fire)" (opens popup window), finds matching file number hyperlink, clicks it, then clicks the confirmation number link to reach the Modify Inspection Request page. Returns `{ inspPage, permitNumber, confirmationNumber }`.
- `getAvailableDates(page)` — Smart-detects date dropdown by scanning all `<select>` elements for date-like options (day/month names or numeric dates). Extracts and sorts available dates. Works on the Modify page's "Inspection Date" dropdown.
- `rescheduleInspection(page, targetDate)` — Selects the new date in the Inspection Date dropdown and clicks "Resubmit Request" on the Modify page.
- `fetchAutomationSettings()` — Fetches polling interval and paused state from control API.
- `mainLoop()` — Infinite loop: fetch inspections → process each → heartbeat → fetch settings → pause → repeat

### Date Filtering Logic
- `parseFlexibleDate(dateStr)` — Robust date parser handles text dates ("Monday, March 2"), ISO dates, and MM/DD/YYYY. Auto-corrects years < 2020 to current year. Normalizes to midnight.
- If `currentScheduledDate` is **before** `desiredDate` (scheduled too soon), worker immediately reschedules to the first available date on or after `desiredDate` — status `rescheduled_correction`
- Otherwise, candidate dates must be **earlier** than `currentScheduledDate` AND **on or after** `desiredDate` (preferred date)
- If `desiredDate` is missing or unparseable, only the "earlier than current" filter applies
- If inspection includes `targetDate` field (override), worker skips normal filtering and reschedules directly to that specific date if available in dropdown

### Override Reschedule (Remedy)
- Control API can send a `targetDate` field on an inspection to force reschedule to a specific date
- Used to undo bad reschedules or move to a specific desired date
- Worker checks if `targetDate` is available in the portal dropdown, reports `target_date_unavailable` if not

### Portal Navigation Flow
1. Login at portal.sanjoseca.gov
2. Click "Manage Inspections (Bldg & Fire)" button → opens popup window
3. In popup: find file number hyperlink matching permit (e.g. "2026 103016 RS" matches "2026-103016-RS")
4. Click file number → lands on "Scheduling or Changing Inspection Requests" page
5. Click confirmation number link → lands on "Modify Inspection Request For Combination" page
6. Extract available dates from "Inspection Date" dropdown
7. Filter dates: must be earlier than current AND on/after preferred date
8. If eligible date found (or override target specified) and not in dry-run mode, select new date and click "Resubmit Request"

### Features
- Preferred date enforcement — never schedules before the desired/preferred date
- Override reschedule via `targetDate` field for remediation
- Robust date parsing handles text dates, ISO dates, and year edge cases
- Popup window handling for Manage Inspections page
- Exponential backoff with jitter on failures
- Session expiration detection and automatic re-login
- Screenshot capture on every reschedule attempt and on errors
- Heartbeat sent to control API every cycle
- Graceful shutdown on SIGINT/SIGTERM
- Dry run mode (default) prevents accidental rescheduling

## Required Environment Variables
- `PORTAL_USERNAME` — San José portal login username
- `PORTAL_PASSWORD` — San José portal login password
- `CONTROL_APP_URL` — Base URL of the control application API

## Deployment
- Deployment target: VM (always-on, long-running process)
- Command: `node index.js`

## Dependencies
- playwright (browser automation)
- axios (HTTP client)
- chromium (system-level browser binary)
