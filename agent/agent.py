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

def post(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(SERVER + "/api/pc", data=data, headers={
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
            post(payload)
        except Exception as e:
            print("loop error:", e)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    # warm up cpu_percent
    if psutil: psutil.cpu_percent(interval=0.5)
    main()
