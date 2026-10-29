# Branch integration Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task, with independent review. Steps use checkbox syntax.

**Goal:** Combine all testing features with all reliability/Linux fixes and merge the verified result into local main.

**Architecture:** Keep the fixed server/storage/time/ICS primitives and shared frontend request/time foundations. Port testing feature resources and existing layouts through those primitives. Keep shared Python telemetry and add bounded optional Windows media/native fallbacks.

**Tech Stack:** Node24, Express, node-ical, vanilla HTML/CSS/JS, Python3.11+, psutil, optional Windows SDK.

**Spec:** `docs/superpowers/specs/2026-10-28-branch-integration.md`.

## Global Constraints

- Current integration checkout is `merge/dashboard-all-branches`; a real merge of origin/testing is pending. Do not commit, stage, switch branches, abort the merge or spawn agents as an implementer.
- Ours is fixes037c586; theirs testing1681533; common ancestor main6ac042f. Root selected ours for conflicted files as the safe starting point, not the final resolution. Testing-only assets/test are auto-added.
- Preserve every feature listed in the spec and every existing regression; no new product scope. Real merges of saved schemas must preserve all user-authored fields.
- APP_TIMEZONE defaults Africa/Cairo; operational time is synchronized server time, never display-clock override. Private calendar URLs/provenance must not reach public/export payloads.
- PC_ALLOW_IP default192.168.50.2, configurable, exact peer IP rather than untrusted headers; loopback tests explicitly configure it. Media freshness30seconds.
- No real user data, external private calendars, live telemetry, host services or remote publication in tests. Use temporary data and controlled boundaries.
- Run implementations sequentially with separate file ownership; root resolves/stages merge and owns Git commits/integration. Full access, no approval questions.

## Review Focus

- Every testing mutation, including import/note/routines/display/edit, must await transactional save and roll back failure (Task1).
- Existing/new saved schemas, strict schedule types, recurrence boundaries and export ordering must remain valid (Task1).
- Live new-resource sync must retain pending/dirty drafts, auth generations and resource ordering protections (Task2).
- Alarms, quiet hours, overdue recurring tasks and media expiration must use synchronized configured time and respect visibility (Task2).
- Optional Windows packages/native calls/media buffers/retries must not break Linux installation or stall PC telemetry (Task3).

### Task 1: Backend and feature data integration

**Own:** server.js, lib helpers as needed, backend/feature/time/calendar/storage tests and testing dashboard integration test; package files only necessary test-script changes.

**Inputs:** fixed server currently restored in working tree; testing server exact snapshot `/tmp/tablet-dashboard-branches/testing/server.js`; reports `/tmp/tablet-dashboard-branches/backend-review.md`, `/tmp/tablet-dashboard-branches/agent-review.md`; fixes git037c586.

**Produces:** Existing fixed APIs plus testing endpoints/shapes for recurring/scheduled/ordered tasks, note, routines, display/privacy, export/import, media. Snapshot fields include display/note/routines/media plus current timeZone and now. SSE events todos/timers/calendar/time/weather/pc plus display/note/routines/media. DueAt accepts validated epoch or local ISO string interpreted in APP_TIMEZONE; returns numeric UTC. PC/media allowlist contract and stale media metadata. Document exact contracts for UI/agent tasks.

- [x] Run testing feature test against fixed baseline to show missing behavior and add failing regressions for poisoned dueTime, import order, feature write rollback and media allowlist/freshness.
- [x] Merge feature default state/migrations without dropping current account/task/timer/settings/source-provenance guarantees; validate malformed feature fields safely before saving/rendering.
- [x] Port task/routine day/week schedules using configured shared time helpers, editing/reorder/move APIs and durable mutations; preserve resource-limit errors rather than eviction.
- [x] Port note/display/privacy/export/import/media/weather enrichment; validate all imports before mutation and preserve v1/v2 semantics and task order. Keep media transient, bounded and fresh.
- [x] Protect both telemetry POST endpoints with configurable actual-peer allowlist. Explicitly configure loopback in existing tests and preserve factory/CLI consistency.
- [x] Run focused backend and testing integration suites, syntax/diff checks; UI conflicts remain independently owned. Write report/contracts for review before Task2.

### Task 2: Full feature UI integration

**Own:** public HTML/CSS/JS, new UI regression tests and current frontend tests; package dev deps only if needed.

**Inputs:** Task1 contracts; exact testing/public snapshot; `/tmp/tablet-dashboard-branches/ui-review.md`; existing fixed common time/admin request/cache/session foundations.

**Produces:** Testing's life-left/media-and-timers-middle/PC-right layout, stacked middle and independent admin columns/navigation, all feature controls, with fixed responsive/a11y/time/request behavior. Preserve core IDs; retain new testing IDs where possible for smoke tests.

- [x] Add failing DOM tests for new-feature preservation, dirty note/display drafts, hidden task timeline/empty-message/overdue weekly visibility, alarm clock skew/quiet hours/snooze and media expiry.
- [x] Port all testing UI features through fixed request/pending/session/generation/draft mechanisms; add new-resource SSE/poll cache protections and checked import/export/reset/actions.
- [x] Keep actual event/task/alarm time independent from user clock override and device timezone; translate local schedule input through server's configured-zone API.
- [x] Preserve audio fallback/retry/gesture controls and local per-occurrence dismiss/snooze, privacy, SVG weather, metric animation/reduced motion and full feature layout.
- [x] Verify phone/tablet content/overlay clearance and hidden/empty column layouts, then full Node suite and browser smoke with feature fixtures. Report evidence and any interface needs.

### Task 3: Windows/Linux agents, media and operation documentation

**Own:** agent files/tests/.env examples/requirements/service, README/server .env example/Docker/Compose/CI/.gitignore if needed, Python npm scripts only.

**Inputs:** Task1 endpoint/allowlist/media contracts; exact testing agent source and `/tmp/tablet-dashboard-branches/agent-review.md`; existing shared telemetry/Linux tests.

- [x] Add failing mocked regressions for .env precedence, bounded media awaits, returned thumbnail buffer, successful-upload-only artwork acknowledgment, and Windows native fallback alongside existing telemetry tests.
- [x] Preserve Linux entrypoint and shared null/finite/config/transport/shutdown guarantees; integrate optional Windows media and native readings using bounded operations. Media failure must not stop PC reporting.
- [x] Correct Windows-only SDK requirement to a resolvable version and document supported Python/wheel availability; Linux dependency installation must skip Windows packages.
- [x] Document merged features, upgrades/backups/export distinction, IP/Tailscale/localhost configuration and media capability limits; keep Docker lock/health/CI correctness.
- [x] Run full Python suite, syntax/Compose checks and dependency resolution; report for independent review.

### Task 4: Final integration and verification

- [x] Independent complete combined diff review; fix material integration findings with regressions.
- [x] Run complete Node and Python suites, dependency audit, actual feature-rich browser checks at tablet/phone sizes, Docker build/startup/health/durable-save smoke and legacy main/testing database upgrade checks.
- [x] Confirm no conflict markers/unmerged index entries, stage all resolved files, commit the actual merge retaining both parent histories.
- [x] Fast-forward local main to verified merge, keep source branches, verify clean status/ancestry and report combined features/tests/main commit. Do not push.
