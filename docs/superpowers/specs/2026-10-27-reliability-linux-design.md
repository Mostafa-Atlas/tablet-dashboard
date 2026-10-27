# Dashboard reliability and Linux agent

The user authorized fixing the existing application following the audit, creating a new Git branch, and adding a Linux device agent. Preserve the lightweight Node/Express, vanilla HTML/CSS/JS, JSON storage, and Python architecture. No new dashboard integrations, modes, or unrelated product features.

## Required outcomes

- Keep stored tasks, timers, account credentials and settings safe: serialized atomic writes, backup recovery, visible write failures, no silent reset of corrupt data.
- Correct calendar recurrence (old series, BYDAY, monthly/yearly, exceptions, cancellation, overrides, DST, all-day) and prevent superseded fetches restoring disconnected calendars. A maintained parser dependency is appropriate; do not build another partial recurrence engine.
- Interpret timer wall times in a configured IANA timezone (default Africa/Cairo), validate all timer inputs, preserve existing API compatibility and data, and avoid silently dropping old items at resource limits.
- Keep telemetry truthful (unavailable versus zero), validate incoming samples, and report stale PC/server/calendar/weather states accurately. Preserve documented LAN/public read semantics; do not add authentication provisioning flows.
- Make existing admin mutations check success, retain drafts and recover from failures, update clocks/countdowns live, and correct the clock override so it shifts only the dashboard clock.
- Improve the existing tablet layout, keyboard/label access, and reduced motion without redesigning the app or adding new timer/task workflows.
- Supply a Linux Python agent using the same telemetry endpoint, with safe unavailable readings, CPU/RAM/disks/uptime, best-effort GPU/temperatures, positive finite polling validation and documented systemd startup. Reuse shared sampling/transport where sensible; keep Windows startup compatible.
- Reproducible Docker builds, clear current documentation, and meaningful regression tests/CI.

## Approach

Fix the current architecture in place on `fix/dashboard-reliability-linux-agent`. A framework/database rewrite would unnecessarily enlarge this maintenance pass. Use node-ical for standards-aware calendar parsing/expansion, small focused helpers for storage/time handling, and native Node/Python test runners. Preserve API response fields; additive timezone/capability/freshness metadata may be used by the existing UI.

## Validation

Reproduce audited defects before changing behavior; add tests that fail for those defects and pass after fixes. Run the full Node and Python suites, syntax checks, Compose validation, and browser smoke checks at tablet and phone sizes. Mock external weather/calendar/hardware/network boundaries while exercising real application logic. Do not send real telemetry or modify real user data during tests.
