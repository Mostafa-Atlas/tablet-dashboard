"""
Win11 PC agent -> POSTs CPU/GPU/RAM to home-lab server every 2s.
Disks only refreshed every 3h (per spec) to save IO.

Run:  pip install -r requirements.txt
      copy .env.example .env   (then edit SERVER inside)
      python agent.py
Tip: run on startup via Task Scheduler.
Env can also come from real environment variables; those override .env.
Only 192.168.50.2 may POST stats (server checks the sender IP, no token).
"""
import os, time, shutil, socket
import urllib.request, urllib.error, json

def _load_dotenv():
    # Minimal .env loader (stdlib only): reads agent/.env, never overrides real env.
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        p = os.path.join(here, '.env')
        if not os.path.exists(p):
            return
        with open(p, encoding='utf-8') as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass

_load_dotenv()

SERVER = os.environ.get("SERVER", "http://localhost:1200").rstrip("/")
INTERVAL = float(os.environ.get("INTERVAL", "2"))
DISK_EVERY_SEC = 3 * 3600

try:
    import psutil
except ImportError:
    psutil = None
    print("WARN: psutil not installed, using Windows readings (pip install psutil for better accuracy)")

def sys_fallback():
    # (cpu_pct, ram_pct) straight from Windows when psutil is missing.
    # One PowerShell call; (None, None) when unreadable — never fake zeros.
    try:
        import subprocess
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; "
             "$os = Get-CimInstance Win32_OperatingSystem; "
             "@{cpu=$cpu; total=$os.TotalVisibleMemorySize; free=$os.FreePhysicalMemory} | ConvertTo-Json -Compress"],
            stderr=subprocess.DEVNULL, timeout=20).decode().strip()
        m = json.loads(out)
        cpu = m.get("cpu")
        cpu = None if cpu is None else round(float(cpu), 1)
        total = float(m.get("total") or 0)
        free = float(m.get("free") or 0)
        ram = round((total - free) / total * 100, 1) if total > 0 else None
        return cpu, ram
    except Exception:
        return None, None

def disks_fallback():
    # All fixed drives via Windows when psutil is missing. None when unreadable.
    try:
        import subprocess
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "(Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | "
             "Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress)"],
            stderr=subprocess.DEVNULL, timeout=20).decode().strip()
        items = json.loads(out)
        if isinstance(items, dict):
            items = [items]
        drives = []
        for d in items or []:
            try:
                size = float(d.get("Size") or 0)
                free = float(d.get("FreeSpace") or 0)
                if size <= 0:
                    continue
                drives.append({"mount": str(d.get("DeviceID") or "?"),
                               "pct": round((size - free) / size * 100, 1),
                               "freeGb": round(free / 1e9, 1), "totalGb": round(size / 1e9, 1)})
            except Exception:
                continue
        return drives or None
    except Exception:
        return None

def gpu_pct():
    # Try GPUtil, else nvidia-smi; None means no supported reading.
    try:
        import GPUtil
        gpus = GPUtil.getGPUs()
        if gpus: return round(gpus[0].load * 100, 1)
    except Exception:
        pass
    try:
        import subprocess
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL, timeout=5).decode().strip().splitlines()
        if out: return float(out[0].strip())
    except Exception:
        pass
    return None

def disks_cached(cache, last):
    if time.time() - last[0] < DISK_EVERY_SEC and cache:
        return cache
    out = []
    if psutil:
        for p in psutil.disk_partitions(all=False):
            try:
                u = psutil.disk_usage(p.mountpoint)
                out.append({"mount": p.mountpoint, "pct": round(u.percent, 1),
                            "freeGb": round(u.free / 1e9, 1), "totalGb": round(u.total / 1e9, 1)})
            except Exception:
                continue
    else:
        fb = disks_fallback()
        if fb:
            out.extend(fb)
        else:
            total, used, free = shutil.disk_usage("C:\\")
            out.append({"mount": "C:", "pct": round(used / total * 100, 1),
                        "freeGb": round(free / 1e9, 1), "totalGb": round(total / 1e9, 1)})
    last[0] = time.time()
    cache[:] = out
    return out

try:
    from winsdk.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as _SM
    from winsdk.windows.storage.streams import Buffer as _Buf, InputStreamOptions as _ISO
    _HAS_SM = True
except Exception:
    _HAS_SM = False

def _pretty_app(uid):
    u = (uid or "").lower()
    if "spotify" in u:
        return "Spotify"
    if "chrome" in u:
        return "Chrome"
    if "edge" in u or "msedge" in u:
        return "Edge"
    if "firefox" in u:
        return "Firefox"
    return (uid or "").split("!")[0].split("_")[0] or None

def media_snapshot():
    # What's playing on this PC (Spotify, browser, anything) via Windows SMTC.
    # Returns None when unreadable so the server keeps its last state.
    if not _HAS_SM:
        return None
    try:
        import asyncio, base64

        async def _get():
            mgr = await _SM.request_async()
            sess = mgr.get_current_session()
            if sess is None:
                return {"playing": False}
            status = sess.get_playback_info().playback_status
            playing = getattr(status, "name", "") == "PLAYING" or int(status) == 4
            props = await sess.try_get_media_properties_async()
            if props is None:
                return {"playing": False}
            try:
                app = _pretty_app(sess.source_app_user_model_id)
            except Exception:
                app = None
            thumb = None
            try:
                ref = props.thumbnail
                if ref is not None:
                    stream = await ref.open_read_async()
                    if stream.size and stream.size < 160 * 1024:
                        buf = _Buf(stream.size)
                        n = await stream.read_async(buf, buf.capacity, _ISO.READ_AHEAD)
                        raw = bytes(bytearray(buf)[:n])
                        if raw:
                            try:
                                ctype = stream.content_type or "image/jpeg"
                            except Exception:
                                ctype = "image/jpeg"
                            thumb = "data:" + ctype + ";base64," + base64.b64encode(raw).decode()
            except Exception:
                pass
            return {"playing": bool(playing),
                    "title": getattr(props, "title", "") or "",
                    "artist": getattr(props, "artist", "") or "",
                    "album": getattr(props, "album_title", "") or getattr(props, "subtitle", "") or "",
                    "app": app, "thumb": thumb}

        return asyncio.run(_get())
    except Exception:
        return None

_media_state = {"key": None, "thumb_at": 0}

def post_media():
    snap = media_snapshot()
    if snap is None:
        return
    key = "\n".join([snap.get("title", ""), snap.get("artist", ""), snap.get("album", "")])
    payload = {"playing": snap["playing"], "title": snap.get("title") or "",
               "artist": snap.get("artist") or "", "album": snap.get("album") or "",
               "app": snap.get("app") or ""}
    if (key != _media_state["key"] or time.time() - _media_state["thumb_at"] > 60) and snap.get("thumb"):
        payload["thumb"] = snap["thumb"]
        _media_state["thumb_at"] = time.time()
    _media_state["key"] = key
    post("now-playing", payload)

def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(SERVER + "/api/" + path, data=data, headers={
        "Content-Type": "application/json"
    })
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            r.read()
        return True
    except (urllib.error.URLError, OSError) as e:
        print("send failed:", e)
        return False

def main():
    print(f"agent -> {SERVER}  hostname={socket.gethostname()}")
    cache, last = [], [0]
    import time as t
    boot = t.time() - (psutil.boot_time() if psutil else t.time())
    tick = 0
    while True:
        try:
            if psutil:
                cpu = psutil.cpu_percent(interval=None)
                ram = psutil.virtual_memory().percent
            else:
                cpu, ram = sys_fallback()
            uptime = int(t.time() - (psutil.boot_time() if psutil else t.time() - boot))
            payload = {
                "cpu": cpu, "ram": ram, "gpu": gpu_pct(),
                "uptimeSec": uptime,
                "disks": disks_cached(cache, last),
            }
            post("pc", payload)
            tick += 1
            if tick % 5 == 0:
                post_media()
        except Exception as e:
            print("loop error:", e)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    # warm up cpu_percent
    if psutil: psutil.cpu_percent(interval=0.5)
    main()
