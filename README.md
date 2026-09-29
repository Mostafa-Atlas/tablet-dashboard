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
- Admin → http://localhost:1200/admin (user `admin`, pass `changeme123`)

You should see mock/empty stats until the agent connects (pill shows `PC OFFLINE` — normal).

## 3. Environment variables

Copy `.env.example` → `.env` and edit:

```
PORT=1200
ADMIN_USER=admin
ADMIN_PASS=changeme123        # change this!
WEATHER_LAT=29.9668           # 6th of October
WEATHER_LON=30.9333
DATA_DIR=./data
```

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

Open `http://<lab-ip>:1200/admin`, log in with Basic Auth (`ADMIN_USER` / `ADMIN_PASS`).

- **To-do:** add, check/uncheck, delete. Kiosk shows top 5 unchecked.
- **Long timer:** enter days → Set (e.g. `12` = 12 days from now).
- **Short timer:** hours + mins → Start / Pause / Resume / Reset.

## 8. API reference

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | no | `{ ok, sseClients, pcAgeSec }` |
| GET | `/api/snapshot` | no | full state for first paint |
| GET | `/api/stream` | no | SSE: `snapshot, pc, todos, timers, weather` |
| GET/POST | `/api/pc` | no (POST open for LAN agent) | agent POSTs `{ cpu, ram, gpu, disks }` |
| GET | `/api/todos` | no | list |
| POST/PATCH/DELETE | `/api/todos…` | admin | mutate |
| GET | `/api/timers` | no | `{ long, short }` |
| POST | `/api/timers/long` | admin | `{ days }` or `{ targetAt }` |
| POST | `/api/timers/short` | admin | `{ action: start\|pause\|resume\|reset, hours, mins }` |
| GET | `/api/weather` | no | cached Open-Meteo |
| GET | `/api/calendar` | no | placeholder, real OAuth in v0.2 |

## 9. Troubleshooting

- **PC OFFLINE on tablet:** agent not reaching server. Check `$env:SERVER` uses lab IP, not localhost. `curl http://<lab-ip>:1200/api/health` from main PC.
- **401 on /admin:** browser cached wrong creds — close tab, reopen, use `ADMIN_USER`/`ADMIN_PASS` from `.env` or compose.
- **Weather shows —:** no internet on server or Open-Meteo blocked. Server caches last value; check logs.
- **Port in use:** change `PORT` in `.env` (e.g. `8090`).
- **Push rejected:** repo is private — `git pull --rebase` then push, or use a PAT with `repo` scope.

## 10. v0.2 next

- Google Calendar next-event (`/api/calendar` OAuth/ICS)
- GPU temp via LibreHardwareMonitor, storage graph
- Timer alarm flash + short presets
- SQLite move if `db.json` outgrows use
