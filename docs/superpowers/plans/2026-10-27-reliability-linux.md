# Dashboard reliability and Linux agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the existing dashboard's reliability and usability defects and add a Linux telemetry agent.

**Architecture:** Retain Express, vanilla frontend, JSON storage and Python. Use focused storage/time helpers and a maintained calendar parser, preserving existing data and routes.

**Tech Stack:** Node 24+, Express, node-ical, Python 3.11+, psutil; native test runners.

**Spec:** `docs/superpowers/specs/2026-10-27-reliability-linux-design.md`

## Global Constraints

- Work on `fix/dashboard-reliability-linux-agent` in the existing checkout as requested.
- Preserve existing user data, routes, frontend structure and Windows agent startup.
- No new dashboard integrations, modes, or unrelated product features.
- Default application timezone is `Africa/Cairo`; timestamps sent over the API are epoch milliseconds or offset-aware ISO strings.
- No real telemetry, private calendar requests, or real data-directory writes in tests.
- Each implementation task owns its listed files; implementers do not spawn agents or commit. Parent coordinates review and integration.

## Review Focus

- Simultaneous saves, corrupt primary/backup files, and write errors must not lose accounts or report durable success incorrectly (Task 1).
- Calendar old series, cancellation/moved exceptions, all-day and Cairo DST must preserve dates and times (Task 1).
- Failed authenticated mutations must leave existing visible state and unsaved drafts recoverable (Task 2).
- PC age, server disconnect, long content and narrow/short viewports must remain clear without hiding essential information (Task 2).
- Hardware unavailable, subprocess timeout, invalid interval and startup outside repo must fail clearly or continue with unavailable values (Task 3).

### Task 1: Backend reliability

**Files:** `server.js`, `lib/ics.js`, new focused `lib/` helpers as needed, `package.json`, `package-lock.json`, backend tests under `test/`.

**Interfaces:** Preserve `/api/*` endpoints and snapshot fields. Add `timeZone` to snapshot/time responses, nullable telemetry values and optional `capabilities` metadata. Settings save must expose calendar fetch failure accurately. Keep calendar fields `next`, `upcoming`, `updatedAt`, `error`, `configured`. Frontend Task 2 consumes these contracts.

- [x] Write and run failing tests for persistence recovery and overlapping writes, recurrence cases, timer timezone/validation, malformed PC samples, calendar refresh race and false calendar success.
- [x] Implement atomic serialized JSON persistence with backup recovery and errors; make mutations await durable writes and avoid silently resetting corrupt data.
- [x] Replace partial ICS recurrence handling using node-ical; retain all-day dates and timezone semantics, expand an appropriate current window, honor exclusions and overrides.
- [x] Fix timer wall time and datetime handling, reject invalid values in current/legacy routes, and return an error instead of silently evicting existing tasks/timers.
- [x] Validate telemetry, preserve null measurements and metadata; add stream heartbeat, bounded weather fetch and stale/error metadata, superseded calendar request protection. Correct legacy auth fallback behavior to match documentation.
- [x] Run full Node tests and syntax checks. Report modified interfaces, commands/results, and remaining concerns to parent for independent review.

### Task 2: Existing UI correctness and tablet usability

**Files:** `public/index.html`, `public/admin.html`, `public/js/*.js`, `public/css/style.css`, frontend tests under `test/`; dev dependency/test script changes in package files only if needed.

**Interfaces:** Consume Task 1's preserved API plus `timeZone`, nullable readings/capabilities and actual calendar fetch outcome. Keep current task/timer creation, completion, color and deletion workflows; no new editing/presets/focus workflows in this pass.

- [x] Write and run failing behavioral tests for aging PC samples, failed mutations, fresh admin clock/countdown and calendar stale states.
- [x] Recalculate sample age independently and distinguish stale samples from server connectivity; show unavailable readings and stale weather/calendar values.
- [x] Centralize checked requests/errors/pending states; show success only after success, preserve failed drafts, restore checkboxes on failure and stop expired-session actions.
- [x] Keep admin countdown/time live and synchronize remote changes without clobbering focused edits. Clock override affects the main clock only; calendar stays at actual event instants in the configured timezone.
- [x] Improve existing breakpoints/overflow for tablet/phone and long content, prioritize visible active/next content, add hidden-task count, labels/contextual names/live regions and reduced motion.
- [x] Run the full suite and frontend/browser smoke verification. Report modified interfaces and results for independent review.

### Task 3: Linux agent and operations

**Files:** `agent/agent.py`, new `agent/linux_agent.py` and shared helper if useful, `agent/requirements.txt`, agent tests, Linux systemd example; `README.md`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, CI workflow, Python test script in package metadata if appropriate.

**Interfaces:** Python agents POST existing CPU/RAM/GPU/uptime/disks fields to `/api/pc`; unsupported readings are null, optional capabilities identifies availability. Linux entrypoint is `python3 agent/linux_agent.py`; Windows `python agent/agent.py` remains supported.

- [x] Write and run failing Python tests for Linux sampling, unsupported hardware, subprocess timeout, positive finite interval validation and transport errors. Use fake external hardware/network boundaries.
- [x] Implement Linux sampling with psutil and bounded optional GPU probes; validate configuration, provide graceful shutdown/logging and keep Windows compatible.
- [x] Supply a systemd service example with explicit working directory/environment and least-privileged execution; document venv installation and startup.
- [x] Use package-lock plus `npm ci` in Docker, add .dockerignore and healthcheck, ensure application timezone is configured, and add CI for Node/Python suites.
- [x] Correct obsolete README routes/future lists, environment fallback/password recovery advice and agent details; document safe persistence recovery and existing dashboard behavior.
- [x] Run full Node/Python suites, syntax checks and Compose validation. Report results for independent review.

### Final verification

- [ ] Independent whole-change review and fix material findings.
- [ ] Run full suites, relevant syntax/config checks and real browser smoke checks with temporary data. Inspect final Git diff/status and leave changes on requested branch.
- [ ] Summarize changes, verification, remaining limitations and suggested future additions; do not merge or publish.
