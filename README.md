# Tablet Dashboard v0.1 (base)

10" Samsung Android kiosk (`/`) + control page (`/admin`). Hosted on home lab, reachable over LAN or Tailscale.

**Stack choice:** Node/Express for the server + Python for the Win11 agent.
- Server needs to be always-on, low RAM, push live updates to a weak tablet → Node + SSE is ideal, zero build step.
- Win11 hardware stats (CPU/GPU/RAM/disks) are best read in Python (`psutil`, `GPUtil`, `nvidia-smi`) → small `agent/agent.py` that POSTs every 2s.
- No native DB deps: JSON file in `./data/db.json` (moves to SQLite in v0.2 if needed).

## Run locally (Windows)
```powershell
npm install
copy .env.example .env
node server.js
# open http://localhost:8080  and  http://localhost:8080/admin (admin / changeme123)
```

## Run on home lab (Docker)
```bash
docker compose up -d --build
# open http://<lab-ip>:8080
```

## Win11 agent
```powershell
pip install -r agent/requirements.txt
$env:SERVER="http://<lab-ip>:8080"
python agent/agent.py
```
Disks refresh every 3h per spec. If no data for 10s the tablet shows PC OFFLINE.

## Tablet (Samsung Android)
1. Install Fully Kiosk Browser, set Start URL to `http://<lab-ip>:8080`
2. Fullscreen, keep screen on, auto-reload on network reconnect
3. 12h clock, weather for 6th of October (Open-Meteo, cached 30 min)

## v0.2 next
- Google Calendar next-event (`/api/calendar`)
- Storage graph + GPU temp via LibreHardwareMonitor
- Timer alarm flash + multi short presets
