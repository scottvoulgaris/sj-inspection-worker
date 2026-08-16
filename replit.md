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
- `navigateToInspections(page, permitNumber)` — Clicks "Manage Inspections (Bldg & Fire)" (opens popup window), then either searches the permit directly on the Permit/reference number Query page or picks it out of the legacy permit list, then clicks the confirmation number link to reach the Modify Inspection Request page. Returns `{ inspPage, permitNumber, confirmationNumber }`.
- `permitSearchCandidates(permitNumber)` — Derives portal search terms from any permit format (see "Permit number formats").
- `searchForPermit(inspPage, permitNumber)` — Fills the Permit/reference number box and submits, retrying each candidate format until the scheduling page is reached.
- `pickConfirmation(rows, hints)` — Chooses which scheduled inspection to modify (see "Confirmation selection").
- `pageText(page)` — Reads body text with whitespace collapsed. **Always match page markers against this**, never raw `textContent`: these pages wrap headings mid-phrase, so raw text reads `Permit/reference number\nQuery` and a substring match silently fails.
- `waitForAnyMarker(page, markers)` — Polls until one of the marker phrases renders. Used instead of fixed sleeps because the Manage Inspections popup fires `domcontentloaded` on `about:blank` before navigating.

### Confirmation selection
A permit routinely has several scheduled inspections **of the same type** — the test permit carries
three "Piers" rows (Sep 1 / 3 / 9). Inspection type alone therefore cannot identify which row to
move; `currentScheduledDate` can, because it is the date the control app is asking to change.

Priority order in `pickConfirmation()`:
1. Explicit `confirmationNumber` — exact match, or status `confirmation_not_found`
2. Only one confirmation on the permit — take it
3. Narrow by `inspectionType`, but only if it matches something (portal wording like "Piers" may not
   match control-app wording like "Foundation"; a non-matching type is ignored rather than fatal)
4. Narrow by `currentScheduledDate` — the decisive filter
5. Still more than one candidate → status `multiple_confirmations`, no guess

The worker never guesses when it cannot identify the row uniquely.

### Local testing — `scripts/probe-permit.js`
Read-only probe that walks login → permit search → confirmation selection → date extraction and
**stops before rescheduling**. It does not import `rescheduleInspection`, so no code path can modify
a booking. It only fills the search box and clicks confirmation-number hyperlinks; it never touches
"Schedule New Inspection", "Resubmit Request", or "Purchase Additional Inspection Time".

```bash
node scripts/probe-permit.js "2026 107657 RS"                              # shows all confirmations
node scripts/probe-permit.js "2026 107657 RS" --current-date "Sep 03, 2026"  # full path
node scripts/probe-permit.js "2026 107657 RS" --confirmation 2556247
```

Credentials come from a gitignored `.env` at the repo root (`PORTAL_USERNAME`, `PORTAL_PASSWORD`).
Screenshots land in `./screenshots/probe-*.png`.
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
1. Login at the SJPermits login page (email + password → "Sign in") → lands on **MY SERVICES**
2. Click "Manage Inspections (Bldg & Fire)" button → opens popup window
3. The worker then branches on which page it lands on:
   - **"Permit/reference number Query"** (current behaviour — the automation account owns no
     applications, so there is no permit list): type the permit into the search box and click
     Search. See "Permit number formats" below.
   - **"Permits Under Inspection"** (legacy): find the file-number hyperlink matching the permit
     (e.g. "2026 103016 RS" matches "2026-103016-RS") and click it.
4. Either branch lands on the "Scheduling or Changing Inspection Requests" page
5. Click confirmation number link → lands on "Modify Inspection Request For Combination" page

### Permit number formats
The permit/reference search expects the **bare 10-digit permit id** — 4-digit year + 6-digit
sequence (the portal's own example is `2004113745`). The same permit is displayed elsewhere with
separators and a type suffix:

| Where | Looks like |
|---|---|
| Control app (`permitNumber`) | `2026 123456 RS` |
| Portal search box | `2026123456` |
| Portal permit header | `2026 123456 000 00 RS` |

Dash-separated (`2026-123456-RS`), lowercase suffixes, and stray whitespace all normalize to the
same search term, so the control app does not have to be strict about formatting.

`permitSearchCandidates()` derives search terms in priority order — digits-only truncated to 10,
then all digits, then the raw string — and `searchForPermit()` tries each until one reaches the
scheduling page. A format mismatch therefore costs a retry rather than failing the inspection.
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
- `TEAMS_WEBHOOK_URL` — Power Automate Workflows webhook URL for error alerts. Unset = alerts disabled (worker logs and continues normally).
- `TEAMS_ALERT_REPEAT_HOURS` — Hours before an still-active condition may re-post (default: `0` = never re-post until it clears)
- `TEAMS_ALERT_STATE_FILE` — Where dedup state is persisted (default: `./alert-state.json`)
- `DRY_RUN` — Set to `false` to enable live rescheduling (default: true/dry run mode)
- `MAX_INSPECTIONS_PER_CYCLE` — Max inspections to process per cycle (default: 3)
- `MAX_SCREENSHOTS` — Maximum number of screenshots to keep before auto-cleanup (default: 50)
- `PORTAL_LOGIN_URL` — Override the login URL (default: `https://portal.sanjoseca.gov/deployed/sfjsp?interviewID=Login`)
- `PORTAL_BASE_URL` — Override the portal base URL (default: `https://portal.sanjoseca.gov`)
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

## Teams Error Notifications (`src/notify.js`)

Posts Adaptive Cards to a Microsoft Teams channel when the worker hits a problem.

### Delivery
Uses a **Power Automate Workflows** webhook (the legacy O365 connector webhooks are retired). In Teams: channel → ⋯ → Workflows → "Post to a channel when a webhook request is received" → copy the generated URL → `fly secrets set TEAMS_WEBHOOK_URL="..."`.

### First-occurrence-only semantics
An alert fires the **first** time a condition appears, then stays silent while that same condition repeats cycle after cycle. It re-arms only when the condition clears, so a recovery followed by a new failure alerts again. Dedup state is persisted to `alert-state.json` so a watchdog restart, Fly redeploy, or crash loop does not re-announce conditions already reported.

### Alert catalog

| Condition | Dedup key | Severity | Re-armed by |
|---|---|---|---|
| Login page unreachable / form missing / credentials rejected | `login_failed` | error | a successful login |
| Cycle threw before completing | `cycle_error` | error | a cycle completing |
| Inspection exhausted max retries | `failed:<inspectionId>` | error | that inspection processing cleanly |
| Permit not found on Manage Inspections page | `permit_not_found:<permit>` | warning | that permit processing cleanly |
| Requested confirmation number not listed | `confirmation_not_found:<permit>:<requested>` | warning | that permit processing cleanly |
| Permit has multiple confirmations, selection required | `multiple_confirmations:<permit>` | warning | that permit processing cleanly |

Normal outcomes (`rescheduled`, `dry_run`, `no_earlier_date`, `no_dates_available`, …) are **not** posted to Teams — they go to the control app only.

Notification failures are swallowed and logged; they never break the automation loop. `alert()` is a no-op when `TEAMS_WEBHOOK_URL` is unset.

## Dependencies
- playwright (browser automation)
- axios (HTTP client)
- chromium (system-level, Nix on Replit / Playwright-bundled on Fly.io)
