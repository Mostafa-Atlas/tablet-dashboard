# Tablet Dashboard

A read-only kiosk display designed for a 10-inch Samsung tablet, with a separate `/admin` control page for a phone or PC. It shows a clock, today's calendar, to-dos, timers, weather, and live Windows PC stats. The display adapts to landscape and portrait widths.

The server is Node.js/Express, the Windows PC agent is Python, and data lives in `data/db.json`. Updates reach the tablet through Server-Sent Events (SSE). The server is intended for a trusted LAN or Tailscale network; do not expose port 1200 directly to the public internet.

## Start the server on Windows

Requirements: Node.js 24+ and npm. From the project directory:

```powershell
cd "E:\Projects\Tablet dashbaord"
npm ci
Copy-Item .env.example .env
node server.js
```

Open `http://localhost:1200/admin` and create an admin account. Open `http://localhost:1200/` for the display. Use `http://<server-LAN-or-Tailscale-IP>:1200/` on the tablet. The first display shows sample tasks and a timer until you replace them in admin.

The server listens on `0.0.0.0`; allow port 1200 only on the network you intend to use. Change `PORT` in `.env` if needed. Weather defaults to 6th of October City, Giza; change `WEATHER_LAT` and `WEATHER_LON` in `.env` for another location.

## Run with Docker on the home lab

```bash
cd /path/to/tablet-dashboard
docker compose up -d --build
docker compose logs -f
```

Open `http://<lab-ip>:1200/admin` for first-time setup. The Compose volume maps `./data` to `/data`, so `db.json` and its backup survive container recreation. After an update, run `docker compose up -d --build` again.

## Connect the Windows PC agent

Requirements: Python 3.11+ and the dependencies in `agent/requirements.txt`. In `/admin`, open **Data and agent**, select **Show token**, and copy the PC agent token. This token is required for PC statistics updates.

```powershell
cd "E:\Projects\Tablet dashbaord"
pip install -r agent/requirements.txt
$env:SERVER = "http://<lab-ip>:1200"   # or the server's Tailscale IP; not localhost on another PC
$env:AGENT_TOKEN = "<token-from-admin>"
python agent/agent.py
```

The agent posts CPU, GPU, and RAM about every 2 seconds and refreshes disk information every 3 hours. If no supported GPU reading is available, the kiosk shows `—` rather than `0%`. The tablet shows **PC OFFLINE** when updates are more than 10 seconds old, even if the agent stops without disconnecting cleanly.

For Task Scheduler, run the agent at logon with both `SERVER` and `AGENT_TOKEN` in its environment. Keep the token out of shared scripts and source control. The agent only makes outbound requests from the PC.

## Set up the 10-inch tablet

Use Fully Kiosk Browser or Chrome. Set the start URL to `http://<lab-ip>:1200/` and enable fullscreen and keep-screen-on as needed. The tablet displays information; controls stay in `/admin`.

- **Overview** shows today, timers, and PC stats. **Focus** shows today and timers.
- Portrait and narrow widths use a single column; landscape uses two or three columns based on available width.
- In `/admin` → **Tablet display**, choose text size, visible sections, calendar privacy, and quiet hours. Quiet hours dim the page on the tablet according to the tablet's local time.
- **DASHBOARD LIVE** reports the server stream. **RECONNECTING** means the display is waiting for it. **PC ONLINE/OFFLINE** separately reports agent freshness.
- Alarm sound is on by default: the tablet tries to play it when a task is due or a timer finishes. Keep the tablet's media volume up. If the browser blocks automatic playback, **Enable sound** appears inside the alarm. **Snooze 5 min** and **Dismiss** act on that tablet.

## Use `/admin`

- **To-do:** add, rename, complete, delete, and move tasks up or down. Set **High**, **Normal**, or **Low** priority, with an optional due date for one-time tasks or time and weekday for repeating tasks. Due tasks appear alongside calendar events in **Today**, with a countdown and alarm. The other incomplete tasks appear below, with high priorities first. Daily tasks reset at the next Cairo calendar day; weekly tasks reset on Monday in Cairo time.
- **Pinned note:** write and save a note from `/admin` on your phone or PC. It updates immediately above the tablet's Today/calendar section.
- **Routine checklists:** create daily or weekly routines, add steps, and check them off from `/admin`. The tablet shows the steps and progress; checks reset at the next Cairo day or week.
- **Timers:** create a long timer by number of days or target date. Create a short timer by duration, clock time, or a 25-minute, 1-hour, or 2-hour preset. The form previews its end time. Existing timers can be renamed, given a new end time or color, paused, resumed, restarted when eligible, marked done, or deleted. Finished timers pulse for 30 seconds.
- **Dashboard time:** shift only the kiosk clock for display. Timers still use real time.
- **Google Calendar:** connect a secret ICS/iCal URL from Google Calendar settings. The server refreshes every 10 minutes and the kiosk shows today's events. The secret URL remains in the server's private data file. Calendar titles and locations are normally available to display clients and in `/api/calendar`; enable **Hide calendar titles and locations** for a shared screen or network. Use a trusted network either way.
- **Data and agent:** export tasks, timers, note, routines, and display settings to JSON; import replaces those items after confirmation. Older v1 exports are accepted. The export intentionally excludes the admin account, agent token, and private calendar URL.

### Add your own alarm sound

1. Name your audio file exactly `alarm.mp3` (MP3 format; a short 5–15 second clip works well).
2. Copy it to `public/audio/alarm.mp3` in this project. On the Windows checkout this is `E:\Projects\Tablet dashbaord\public\audio\alarm.mp3`.
3. If running with Docker, run `docker compose up -d --build` so the file is copied into the image. If running directly with Node, no rebuild is needed.
4. Reload the tablet dashboard and raise the tablet's media volume. In `/admin`, use **Test sound on this device** to check the phone or PC; test a due task or timer on the tablet to check its speaker.

Until the file is present, the tablet plays a built-in chime. Some browsers block automatic audio until you tap the page or allow autoplay for the dashboard site; if that happens, **Enable sound** appears inside an active alarm. Alerts stay visible even if sound is blocked. The alarm repeats until dismissed or snoozed; it covers timers and due tasks for 24 hours after their target time. Acknowledgements and snoozes are stored in that tablet browser.

The admin session lasts seven days and is stored in that browser's local storage. The password is hashed with scrypt in `data/db.json`. Keep `data/` and `.env` private and back up the `data/` directory or use the JSON export regularly.

## Check and troubleshoot

```powershell
npm test
```

The integration test uses a temporary data directory; it checks agent authentication, tasks, timers, privacy, import/export, and backup recovery. It does not contact your running server.

- **PC OFFLINE:** check that `SERVER` points to the lab or Tailscale address and `AGENT_TOKEN` matches `/admin`. Check `http://<lab-ip>:1200/api/health` from the PC.
- **RECONNECTING:** check that the tablet can reach the server. The page reconnects automatically when the network returns.
- **Weather unavailable or stale:** the server could not reach Open-Meteo. Check connectivity and server logs.
- **Cannot sign in:** use the account created on first boot. There is no default password. Restore a known-good `data/` backup if credentials are lost; deleting `db.json` resets all dashboard data and is a last resort.
- **Damaged `db.json`:** the server tries `db.json.bak`. If both are invalid, it refuses to start rather than silently replacing your data. Restore your external backup.

### Main API endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /api/snapshot`, `/api/stream` | Display clients | Initial state and live updates |
| `GET /api/health` | Display clients | Server and PC freshness |
| `POST /api/pc` | Agent bearer token | Windows PC stats |
| `GET /api/todos`, `/api/timers`, `/api/calendar`, `/api/display` | Display clients | Read-only dashboard data |
| `POST/PATCH/DELETE /api/todos`, `/api/timers` | Admin bearer token | Edit tasks and timers |
| `POST /api/display`, `/api/settings`, `/api/time` | Admin bearer token | Display, calendar, and clock settings |
| `GET /api/export`, `POST /api/import`, `GET /api/agent-token` | Admin bearer token | Backup and agent setup |

Browser requests stay on the same origin; cross-origin API access is not enabled. Keep the server reachable only from devices you trust.
