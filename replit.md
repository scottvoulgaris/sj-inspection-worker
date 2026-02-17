# Inspection Automation Worker

## Overview
A continuous Node.js background worker using Playwright to automate inspection rescheduling on the City of San José permits portal. This is NOT a web app — it runs as a long-lived process in an infinite loop.

## Current State
- Project created: Feb 2026
- Status: Ready to run (requires environment variables)
- Last updated: Feb 2026 — codebase cleanup and improvements

## Architecture

### Entry Point
- `index.js` — Validates env vars, opens a minimal HTTP listener (plain text "worker alive" on `GET /`), then launches the automation main loop. Signal handlers for graceful shutdown.

### Source Modules (`src/`)
- `config.js` — Centralized configuration (browser settings, timing, URLs)
- `logger.js` — Timestamped structured logging
- `api.js` — HTTP client for control app (fetch inspections, post results, heartbeat)
- `browser.js` — Playwright browser lifecycle management
- `portal.js` — San José portal automation (login, navigation, date extraction, rescheduling, screenshot auto-cleanup)
- `worker.js` — Main loop with retry logic, backoff, jitter, heartbeat, and graceful shutdown support

### Key Functions
- `login(page)` — Authenticates with the San José portal via portal.sanjoseca.gov
- `navigateToInspections(page, permitNumber)` — Clicks "Manage Inspections (Bldg & Fire)" (opens popup window), finds matching file number hyperlink, clicks it, then clicks the confirmation number link to reach the Modify Inspection Request page. Returns `{ inspPage, permitNumber, confirmationNumber }`.
- `getAvailableDates(page)` — Smart-detects date dropdown by scanning all `<select>` elements for date-like options (day/month names or numeric dates). Uses `parseOptionDate` helper for robust parsing including MM/DD/YYYY format. Extracts and sorts available dates.
- `rescheduleInspection(page, targetDate)` — Selects the new date in the Inspection Date dropdown and clicks "Resubmit Request" on the Modify page.
- `cleanupOldScreenshots()` — Automatically deletes oldest screenshots when count exceeds MAX_SCREENSHOTS (default 50). Called before every new screenshot.
- `fetchAutomationSettings()` — Fetches polling interval and paused state from control API.
- `mainLoop()` — Infinite loop: fetch inspections → process each → heartbeat → fetch settings → pause → repeat. Checks `process.shuttingDown` at start of each cycle for graceful exit.

### Date Filtering Logic
- `parseFlexibleDate(dateStr)` — Robust date parser handles text dates ("Monday, March 2"), ISO dates, and MM/DD/YYYY format. Auto-corrects years < 2020 to current year. Normalizes to local midnight for consistent day-level comparison.
- `parseOptionDate(text, value)` — Portal-specific date parser in `getAvailableDates` that tries text first, then value, including MM/DD/YYYY format on value. Same normalization as `parseFlexibleDate`.
- Both parsers extract year/month/day components explicitly before constructing Date objects via `new Date(year, month, day)` to avoid UTC-vs-local timezone drift that occurs with `new Date(string)`.
- **2-day buffer rule**: Any candidate date within 2 days of today is rejected (e.g., if today is Feb 17, the earliest selectable date is Feb 20). This applies to all three reschedule paths (normal, too-soon correction, and override).
- If `currentScheduledDate` is **before** `desiredDate` (scheduled too soon), worker immediately reschedules to the first available date on or after `desiredDate` — status `rescheduled` with `reason: 'scheduled_too_soon'`
- Otherwise, candidate dates must be **earlier** than `currentScheduledDate` AND **on or after** `desiredDate` (preferred date) AND beyond the 2-day buffer
- If `desiredDate` is missing or unparseable, only the "earlier than current" and 2-day buffer filters apply
- If inspection includes `targetDate` field (override), worker checks the 2-day buffer first, then reschedules directly to that specific date if available in dropdown

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
- Consistent local-midnight date normalization via explicit year/month/day extraction — handles ISO dates, MM/DD/YYYY, and text dates without timezone drift
- Screenshot auto-cleanup keeps only the most recent N screenshots (configurable via MAX_SCREENSHOTS env var, default 50)
- Popup window handling for Manage Inspections page
- Exponential backoff with jitter on failures
- Session expiration detection and automatic re-login
- Screenshot capture on every reschedule attempt and on errors
- Heartbeat sent to control API every cycle
- Graceful shutdown on SIGINT/SIGTERM with 5s grace period for worker to finish current operation
- Dry run mode (default) prevents accidental rescheduling
- Minimal HTTP listener returns "worker alive" so Replit Deployments keep the process running

## Required Environment Variables
- `PORTAL_USERNAME` — San José portal login username
- `PORTAL_PASSWORD` — San José portal login password
- `CONTROL_APP_URL` — Base URL of the control application API

## Optional Environment Variables
- `DRY_RUN` — Set to `false` to enable live rescheduling (default: true/dry run mode)
- `MAX_INSPECTIONS_PER_CYCLE` — Max inspections to process per cycle (default: 3)
- `MAX_SCREENSHOTS` — Maximum number of screenshots to keep before auto-cleanup (default: 50)
- `CHROMIUM_PATH` — Path to Chromium binary (auto-configured)
- `DEBUG` — Set to `true` to enable debug logging

## Deployment

### Replit (Development)
- Deployment target: Autoscale (HTTP listener keeps process alive, but spins down after idle)
- Command: `node index.js`
- `CHROMIUM_PATH` env var points to the Nix Chromium binary

### Fly.io (Production — Always Running)
Fly.io runs this as a persistent VM that never spins down.

**Files:**
- `Dockerfile` — Node.js 20 + Playwright Chromium deps + app code
- `fly.toml` — Fly.io config (sjc region, shared-cpu-1x, 512MB, auto_stop=off)
- `.dockerignore` — Excludes node_modules, screenshots, Replit files from Docker image

**First-time setup:**
```bash
# Install flyctl CLI (https://fly.io/docs/flyctl/install/)
curl -L https://fly.io/install.sh | sh

# Login to Fly.io
fly auth login

# Create the app (only once)
fly apps create inspection-automation-worker

# Set secrets (required)
fly secrets set PORTAL_USERNAME="your-username"
fly secrets set PORTAL_PASSWORD="your-password"
fly secrets set CONTROL_APP_URL="https://inspection-scheduler-accelerator.replit.app"
fly secrets set DRY_RUN="false"

# Deploy
fly deploy
```

**Subsequent deploys:**
```bash
fly deploy
```

**Useful commands:**
```bash
fly logs                    # View live logs
fly status                  # Check machine status
fly ssh console             # SSH into the running machine
fly secrets list            # List set secrets
```

**Notes:**
- When `CHROMIUM_PATH` is not set (Docker/Fly.io), Playwright uses its own bundled Chromium
- Region `sjc` (San José) is closest to the portal server for lowest latency
- `auto_stop_machines = "off"` ensures the worker runs 24/7
- `min_machines_running = 1` guarantees at least one machine is always up

## Dependencies
- playwright (browser automation)
- axios (HTTP client)
- chromium (system-level, Nix on Replit / Playwright-bundled on Fly.io)
