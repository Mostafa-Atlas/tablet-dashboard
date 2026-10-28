# Tablet Dashboard

A read-only tablet display at `/` and an admin page at `/admin`, hosted on your home lab over LAN or Tailscale. Node/Express serves vanilla HTML/CSS/JavaScript with live Server-Sent Events (SSE); a Python agent reports one Windows or Linux machine. State lives in a JSON file, with atomic saves and a previous-good backup.

## Start the server

Use Node 24 and npm, or Docker with Compose. From the repository directory:

```bash
npm ci
cp .env.example .env
npm start
```

In PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Open [the display](http://localhost:1200) or [admin](http://localhost:1200/admin); use the server's LAN/Tailscale address from another device. On first boot, create an admin account (username 3–32 letters, digits or `._-`; password at least 6 characters). There is no default password. Hardware readings stay unavailable until an agent sends them.

The server listens on all interfaces. Public reads and `/api/pc` telemetry writes are unauthenticated for the existing trusted LAN/Tailscale use. Admin changes require a token or HTTP Basic credentials. Keep it on that trusted network; this project does not provide public-internet deployment or agent authentication.

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `1200` | Server port; with Compose, the published host port |
| `APP_TIMEZONE` | `Africa/Cairo` | IANA timezone for clock, local timer inputs and calendar display; invalid zones stop startup |
| `WEATHER_LAT` / `WEATHER_LON` | `29.9668` / `30.9333` | Weather location (6th of October City, Giza) |
| `DATA_DIR` | `./data` | Persistent directory; Compose mounts it at `/data` |
| `ADMIN_USER` / `ADMIN_PASS` | unset | Optional legacy login, only while no stored account exists |

Create the account through `/admin` even if using the legacy login. Stored passwords are scrypt hashes. Once an account exists, environment credentials stop working; changing `ADMIN_PASS` cannot reset that account. Compose intentionally does not pass legacy credentials. Browser sessions expire after seven days and are lost when the server restarts.

## Docker

```bash
docker compose up -d --build
docker compose logs -f dashboard
```

The image installs locked production packages with `npm ci --omit=dev`; its healthcheck calls `/api/health`. The JSON data and backup persist in `./data` by default. The agent runs on the machine being measured, outside the server container. To update, back up the persistent directory, pull the code, then run `docker compose up -d --build` again.

Compose reads the configuration values above from `.env`. The container always listens on port 1200; `PORT` controls its host mapping. Give the container write access to the mounted data directory. Run exactly one server process/container against each `DATA_DIR`: there is no cross-process lock or shared-writer support.

## Choose one reporting machine

Run **either the Linux agent or the Windows agent** for a dashboard. It has one PC card, and concurrent agents overwrite that same card; there is no multi-device identity or history. Multiple device cards would require future backend/UI work.

Both entrypoints share sampling and transport. They send `cpu`, `ram`, `gpu`, `cpuTemp`, `gpuTemp`, `uptimeSec`, `disks` and boolean `capabilities` to `/api/pc`. Unavailable/unsupported readings are JSON `null` and show as unavailable; real zero readings remain zero. The first CPU reading is unavailable while psutil establishes its sampling interval. Capabilities describe availability in the current sample, not guaranteed hardware support.

- Polling defaults to every 2 seconds, plus sampling/send time. Set `INTERVAL` to a positive finite number of seconds within Python's supported wait range. Long intervals can intentionally cause the display's 10-second PC freshness threshold to mark it stale.
- Mounted disk usage is cached for three hours, including an empty result; inaccessible mounts are skipped. The API retains at most eight disks; the kiosk displays at most six. This is current cached capacity, not a usage history.
- GPU load and temperature use the first GPU from `nvidia-smi` if installed and readable, with a two-second subprocess timeout. AMD/Intel GPU readings remain unavailable in this implementation. CPU temperatures use supported psutil CPU sensor groups when readable; Windows commonly has none. No elevated agent privileges are required.
- Each HTTP attempt has a five-second socket timeout and does not read the response body. Failed sends are logged and retried on the next cycle. Ctrl+C or SIGTERM requests shutdown; an in-flight sensor/network operation can finish before exit.
- Agent variables are ordinary process environment variables; the agent does **not** read the server's `.env` file.

### Linux

Use Python 3.11+ with `venv` support. From the repository directory:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r agent/requirements.txt
SERVER=http://192.168.1.50:1200 INTERVAL=2 .venv/bin/python agent/linux_agent.py
```

Set `SERVER` to the dashboard's LAN/Tailscale address; localhost works only when the dashboard runs on the same host.

For an optional boot service, [agent/tablet-dashboard-agent.service](agent/tablet-dashboard-agent.service) runs as a dedicated unprivileged `tablet-agent` user. It assumes a readable installation at `/opt/tablet-dashboard` and a venv there. Copy the repository there first, create its venv with the commands above, then adapt these setup commands to your distribution:

```bash
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin tablet-agent
sudo install -m 600 agent/linux-agent.env.example /etc/tablet-dashboard-agent.env
sudoedit /etc/tablet-dashboard-agent.env
sudo install -m 644 agent/tablet-dashboard-agent.service /etc/systemd/system/tablet-dashboard-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now tablet-dashboard-agent.service
journalctl -u tablet-dashboard-agent.service -f
```

Run those commands yourself when ready; nothing in this repository installs or activates the service automatically. Edit `SERVER` in the environment file before starting. Keep the code/venv readable and executable by `tablet-agent`; it needs no write access to the installation or dashboard data. The service declares its working directory and environment file explicitly, drops privileges, and requests a read-only filesystem. If your distribution restricts GPU/temperature access, leave those readings unavailable or grant only the relevant device-group access; do not run the agent as root. To stop it: `sudo systemctl disable --now tablet-dashboard-agent.service`.

### Windows

From the repository in PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r agent/requirements.txt
$env:SERVER="http://192.168.1.50:1200"
$env:INTERVAL="2"
.\.venv\Scripts\python.exe agent/agent.py
```

The existing `python agent/agent.py` command also works when its Python environment has the requirements installed. For Task Scheduler, use the full venv Python path, the full script path, and the repository as **Start in**. A `.cmd` wrapper can set `SERVER` and `INTERVAL` before calling Python. Use `python.exe` with log redirection when diagnosing startup errors; `pythonw.exe` hides console logs.

## Tablet and admin behavior

Point a kiosk browser (for example Fully Kiosk Browser or Chrome) at `http://<server-ip>:1200`. Configure fullscreen, keep-screen-on and reload-on-reconnect as needed. Admin works on a phone or desktop at `/admin`.

- To-dos can be added, completed and deleted. The display shows the first five outstanding tasks and a count of additional items. New tasks are rejected at 50 rather than discarding old items.
- Named long timers use days from now or a target date. Short timers use hours/minutes or the next occurrence of a clock time. Local wall times use `APP_TIMEZONE`. Explicitly dated local times that do not exist during a DST transition are rejected; clock-only requests choose the next valid occurrence, skipping a missing occurrence. Existing timers can be marked done, recolored or deleted in admin. New timers are rejected at 20. The API also retains legacy timer routes and pause/resume/reset/restart actions; the UI does not add those controls.
- The clock override changes only the displayed dashboard clock. Timers, freshness and calendar event instants continue using real server time.
- Connect a calendar by pasting its secret iCal/ICS URL into admin. It is saved server-side and available only through authenticated settings, never in public snapshots. The display shows today's all-day and timed events, with live/past states. Recurrence, exclusions and overrides are parsed by `node-ical`; the timeline covers 14 days and next-event search is bounded to one year. Automatic calendar refresh is every 10 minutes.
- A calendar URL can be saved even if its refresh fails. Admin reports that failure and keeps the draft; the server retries automatically. Changing the URL clears the old calendar's events; a failed refresh of the same URL retains its last successful events. Disconnect prevents a pending older fetch from restoring the calendar.
- Server connectivity and PC freshness have separate indicators. PC data becomes stale after 10 seconds without a sample. Cached weather/calendar values remain visible on fetch failure, alongside warnings. Calendar is stale after 20 minutes without success, weather after 30 minutes. Weather normally refreshes every 30 minutes.
- Admin checks mutation responses, keeps failed drafts and restores rejected checkbox/color changes. Updates from other admin clients arrive through SSE, with periodic polling as fallback. Focused controls are preserved while lists reconcile later. Landscape cards scroll internally; portrait pages scroll to reach detailed PC information.

## Persistence, backups and recovery

Admin changes finish saving before reporting success. Saves serialize, fsync a temporary file and atomically replace `db.json`; `db.json.bak` contains the previous successful snapshot. Telemetry and external caches checkpoint every 15 seconds, so abrupt shutdown can lose recent transient readings. The `.bak` file is a rotating previous snapshot, **not** a backup history. Keep separate backups of the whole data directory, which contains account hashes and private calendar settings.

On upgrade, an older calendar cache with unknown source provenance is cleared once and rebuilt on refresh. Your settings, tasks, timers and accounts are retained.

To take a consistent backup, stop the server (for Compose: `docker compose stop dashboard`), copy the entire configured data directory to a protected backup location, then restart. Do not run a second writer during backup or recovery. Keep backup permissions restricted.

At startup, a missing/corrupt primary recovers automatically from a valid `db.json.bak`. A corrupt primary is retained as `db.json.corrupt-<timestamp>`. If existing primary/backup files are both invalid, startup fails and preserves them. Stop the server, copy the entire damaged directory aside, restore a known-good `db.json` and its matching backup from your independent backup, verify ownership/write permissions, then restart and check the logs and admin data. Restoring an older backup also rolls back its tasks, timers, settings and credentials. **Do not delete the database to fix corruption or login problems.**

There is no built-in password-reset screen or command. A stored account cannot be overridden by environment variables. If credentials are lost, retain the database and recover from a protected backup with known credentials; do not clear all data or remove account fields from a live file. Session tokens are in memory, so sign in again after a server restart.

## API reference

Public read and telemetry routes retain their trusted-network semantics. Protected routes accept `Authorization: Bearer <token>`; scripts may also use HTTP Basic with a valid stored account (or the legacy environment account before setup).

| Method | Endpoint | Result / request |
|---|---|---|
| GET | `/api/health` | `{ok, now, sseClients, pcAgeSec}`; server health, not hardware health |
| GET | `/api/snapshot` | Current state, server `now`, configured `timeZone` |
| GET | `/api/stream` | SSE snapshots and resource updates, with heartbeat comments |
| GET / POST | `/api/pc` | Latest sample / agent submission; nullable measurements and disk array |
| GET | `/api/todos` | Task array |
| POST | `/api/todos` | Protected: `{text}` |
| PATCH / DELETE | `/api/todos/:id` | Protected: edit `{text?, done?}` / delete |
| GET | `/api/timers` | Sorted named timer array |
| POST | `/api/timers` | Protected: `{name, type, color?, days/date/targetAt}` for long; `{name, type:"short", hours/mins or atTime, color?}` for short |
| PATCH / DELETE | `/api/timers/:id` | Protected: `{name?, done?, color?, action?}` / delete; restart may supply `hours`, `mins` |
| POST | `/api/timers/long`, `/api/timers/short` | Protected legacy compatibility endpoints |
| GET / POST | `/api/time` | Timezone/offset/dashboard epoch / protected `{datetime}`, `{offsetSec}` or `{action:"reset"}` |
| POST | `/api/setup` | First stored account only: `{user, pass}` → token |
| POST | `/api/login`, `/api/logout` | `{user, pass}` → token / revoke supplied bearer token |
| GET | `/api/me` | `{loggedIn, needsSetup}` |
| GET | `/api/weather` | Cached weather with update/attempt times, error and stale state |
| GET | `/api/calendar` | `{next, upcoming, updatedAt, attemptedAt, error, stale, configured}` |
| GET / POST | `/api/settings` | Protected: read / save `{icsUrl}`; empty URL disconnects |

Validation errors return 400, item-capacity limits 409, unauthorized changes 401, and failed durable writes 500. Calendar settings refresh can return 502 after saving the URL, or 409 if a newer request superseded it. Clients must check HTTP status as well as response JSON.

## Troubleshooting and checks

- **PC stale/unavailable:** inspect agent logs; check `SERVER`, network reachability and `INTERVAL`. A health GET from the agent host tests reachability without sending telemetry. Missing GPU/temperature support is normal and remains unavailable.
- **Login fails:** first boot requires setup; later boots require the stored account. Changing environment credentials does not reset it. See backup/recovery above.
- **Calendar/weather warning:** check outbound connectivity and server logs. Last successful cached values can remain visible during a failure.
- **Write failure/startup refuses data:** preserve primary/backup files, inspect filesystem permissions, free space and recovery logs. Never reset data as a first troubleshooting step.
- **Port already in use:** change `PORT` in `.env`, then restart; Compose uses that value for its host port mapping.

Run the regression suites from the repository root:

```bash
npm ci
npm test
python3 -m pip install -r agent/requirements.txt
python3 -m unittest discover -s agent/tests -v
# Equivalent Python shortcut on Linux: npm run test:agent
docker compose config --quiet
```

Tests use temporary databases and fake weather/calendar/hardware/network boundaries. They do not contact a live calendar, read host hardware or send telemetry. CI runs the Node 24 suite and Python 3.11 agent tests. Multi-device reporting, additional GPU backends and password-management workflows remain future work; they are not part of the current UI.
