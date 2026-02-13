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
- `login(page)` — Authenticates with the San José portal
- `getAvailableDates(page)` — Extracts dates from inspection scheduling dropdown
- `rescheduleInspection(page, targetDate)` — Attempts to reschedule to an earlier date
- `mainLoop()` — Infinite loop: fetch inspections → process each → heartbeat → pause → repeat

### Features
- Exponential backoff with jitter on failures
- Session expiration detection and automatic re-login
- Screenshot capture on every reschedule attempt and on errors
- Heartbeat sent to control API every cycle
- Graceful shutdown on SIGINT/SIGTERM

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
