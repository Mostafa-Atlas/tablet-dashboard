# Tablet Dashboard v0.1 (base)

10" Samsung Android kiosk display (`/`) + control page (`/admin`).
Hosted on your home lab, reachable over LAN or Tailscale.

**Stack:** Node/Express server + Python agent (Win11).
- Server is always-on, low RAM, pushes live updates to the tablet via SSE — Node is ideal, zero build step.
- Win11 hardware stats (CPU/GPU/RAM/disks) are read best in Python (`psutil`, `GPUtil` / `nvidia-smi`) — `agent/agent.py` POSTs every 2s.
- Storage: JSON file in `./data/db.json` (no native deps, works on Windows + Docker).
- Time: 12h clock. Weather: 6th of October, Giza (Open-Meteo, cached 30 min).

---

## 1. Prerequisites

| Where | Need |
|---|---|
| Dev PC / home lab server | Node 24+, npm, (optional) Docker + Docker Compose |
| Main PC (Win11) | Python 3.11+, `pip install -r agent/requirements.txt` |
| Tablet (Samsung Android) | Fully Kiosk Browser (free) or Chrome |
| Network | Same LAN, or Tailscale on all devices |

## 2. Quickstart (Windows, 2 min)

```powershell
cd "E:\Projects\Tablet dashbaord"
npm install
copy .env.example .env
node server.js
```

Open:
- Display → http://localhost:1200
- Admin → http://localhost:1200/admin → create your account on first boot

You should see mock/empty stats until the agent connects (pill shows `PC OFFLINE` — normal).

## 3. Environment variables

Copy `.env.example` → `.env` and edit:

```
PORT=1200
WEATHER_LAT=29.9668           # 6th of October
WEATHER_LON=30.9333
DATA_DIR=./data
# Optional legacy fallback (only used if no account created yet via setup page):
# ADMIN_USER=admin
# ADMIN_PASS=changeme123
```

> First boot: open `/admin` and **create your admin account** (username 3-32 chars, password min 6).
> It's hashed (scrypt) and stored in `./data/db.json`. Setting `ADMIN_USER` + `ADMIN_PASS` env vars
> enables an additional fallback login (for scripts/docker) — otherwise only created accounts work.

Server listens on `0.0.0.0` so it works over LAN + Tailscale with no extra config.

## 4. Run on home lab (Docker, recommended)

```bash
cd /path/to/tablet-dashboard
docker compose up -d --build
docker compose logs -f
# open http://<lab-ip>:1200  (e.g. http://192.168.1.50:1200)
```

Data persists in `./data/db.json` (mounted to `/data` in container).
To change admin password: edit `docker-compose.yml` → `ADMIN_PASS`, then `docker compose up -d`.

To update after a `git pull`:
```bash
docker compose up -d --build
```

## 5. Win11 agent (sends CPU/GPU/RAM)

On your main Win11 PC:

```powershell
cd "E:\Projects\Tablet dashbaord"
pip install -r agent/requirements.txt
$env:SERVER="http://<lab-ip>:1200"   # use home-lab LAN or Tailscale IP, NOT localhost
python agent/agent.py
```

Expected output: `agent -> http://<lab-ip>:1200 ...` and the tablet pill flips to `PC ONLINE`.

- Posts every 2s (`INTERVAL=2` to change).
- Disks refresh every 3h per spec.
- GPU: tries `GPUtil` → `nvidia-smi` → falls back to 0 (AMD iGPU shows 0 in v0.1).
- No firewall change needed on main PC (it only makes outbound POSTs).

### Auto-start on boot (Task Scheduler)

1. Task Scheduler → Create Task → Run whether user is logged on or not.
2. Trigger: At log on. Action: `pythonw.exe "E:\Projects\Tablet dashbaord\agent\agent.py"`.
3. Set env `SERVER` in the script or wrap in a `.bat`:
   ```bat
   set SERVER=http://192.168.1.50:1200
   pythonw "E:\Projects\Tablet dashbaord\agent\agent.py"
   ```

## 6. Tablet setup (Samsung Android)

1. Install **Fully Kiosk Browser**.
2. Start URL: `http://<lab-ip>:1200`.
3. Enable: Fullscreen, Keep Screen On, Auto-reload on network reconnect.
4. Optional: Screen dim 11pm–7am in Fully settings.

No touch needed — display is read-only. All control is from `/admin` on your phone/PC.

## 7. Using /admin

Open `http://<lab-ip>:1200/admin` and sign in on the custom login page (`ADMIN_USER` / `ADMIN_PASS`).
Session lasts 7 days (token in browser localStorage). No browser popup — wrong creds show an inline error.

- **To-do:** add, check/uncheck, delete. Kiosk shows top 5 unchecked.
- **Timers (multiple, named):** pick 📅 Long or ⏱ Short, type a name, then:
  - Long → days from now **or** a target date (kiosk shows `12d 4h` counting from today).
  - Short → countdown hours/mins **or** a clock time today like `18:30` (kiosk counts down to it).
  - All timers list below with a **checkbox** to mark done, tag, and delete. Done timers show ✓ on the kiosk.
- **Storage:** per-disk bars on the kiosk turn red past 80%. Agent sends disks every 3h.
- **Dashboard time:** pick date + time in `/admin` to shift the kiosk clock (shows day-month-year like `12-1-2026`), or reset to real time. Only the clock display shifts — timers keep real time.
- **Google Calendar:** paste your calendar's **Secret address in iCal format** (Calendar Settings → Integrate calendar) into the `/admin` Calendar card → Connect. Tablet shows the next event (`in 2h · 3:30 PM`), refreshed every 10 min. Supports recurring events. The URL stays server-side — never sent to the tablet.

## 8. API reference

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | no | `{ ok, sseClients, pcAgeSec }` |
| GET | `/api/snapshot` | no | full state for first paint |
| GET | `/api/stream` | no | SSE: `snapshot, pc, todos, timers, weather` |
| GET/POST | `/api/pc` | no (POST open for LAN agent) | agent POSTs `{ cpu, ram, gpu, disks }` |
| GET | `/api/todos` | no | list |
| POST/PATCH/DELETE | `/api/todos…` | admin token (Bearer) | mutate |
| GET | `/api/timers` | no | `{ long, short }` |
| GET | `/api/timers` | no | named timers array |
| POST | `/api/timers` | admin token (Bearer) | `{ name, type: long\|short, days\|date\|targetAt, hours\|mins\|atTime }` |
| PATCH | `/api/timers/:id` | admin token (Bearer) | `{ name?, done?, action: pause\|resume\|reset }` |
| DELETE | `/api/timers/:id` | admin token (Bearer) | remove |
| POST | `/api/setup` | no (only when no users exist) | `{ user, pass }` → `{ token }` — first-boot create |
| POST | `/api/login` | no | `{ user, pass }` → `{ token }` |
| GET | `/api/me` | no | `{ loggedIn }` |
| GET | `/api/weather` | no | cached Open-Meteo |
| GET | `/api/calendar` | no | `{ next, updatedAt, error, configured }` (no secret URL) |
| GET | `/api/settings` | admin token | `{ icsUrl }` |
| POST | `/api/settings` | admin token | `{ icsUrl }` → saves + refreshes calendar |

## 9. Troubleshooting

- **PC OFFLINE on tablet:** agent not reaching server. Check `$env:SERVER` uses lab IP, not localhost. `curl http://<lab-ip>:1200/api/health` from main PC.
- **Can't log in on /admin:** on first boot you must **create** the account on the setup screen — there is no default password. If you forgot it, stop the server, delete the `users` array in `./data/db.json` (or the whole file to reset), restart, and create a new one. Scripts can still use HTTP Basic on the API with the created account.
- **Weather shows —:** no internet on server or Open-Meteo blocked. Server caches last value; check logs.
- **Port in use:** change `PORT` in `.env` (e.g. `8090`).
- **Push rejected:** repo is private — `git pull --rebase` then push, or use a PAT with `repo` scope.

## 10. v0.2 next

- Google Calendar next-event (`/api/calendar` OAuth/ICS)
- GPU temp via LibreHardwareMonitor, storage graph
- Timer alarm flash + short presets
- SQLite move if `db.json` outgrows use
