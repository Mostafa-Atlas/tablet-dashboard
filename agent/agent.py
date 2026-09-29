"""
Win11 PC agent -> POSTs CPU/GPU/RAM to home-lab server every 2s.
Disks only refreshed every 3h (per spec) to save IO.

Run:  pip install -r requirements.txt
      set SERVER=http://192.168.1.50:8080  (your home-lab IP, or Tailscale IP)
      python agent.py
Tip: run on startup via Task Scheduler.
"""
import os, time, shutil, socket
import urllib.request, urllib.error, json

SERVER = os.environ.get("SERVER", "http://localhost:8080").rstrip("/")
INTERVAL = float(os.environ.get("INTERVAL", "2"))
DISK_EVERY_SEC = 3 * 3600

try:
    import psutil
except ImportError:
    psutil = None
    print("WARN: psutil not installed, sending mock values. pip install psutil")

def gpu_pct():
    # Try GPUtil, else nvidia-smi, else 0
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
    return 0

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
        total, used, free = shutil.disk_usage("C:\\")
        out.append({"mount": "C:", "pct": round(used / total * 100, 1),
                    "freeGb": round(free / 1e9, 1), "totalGb": round(total / 1e9, 1)})
    last[0] = time.time()
    cache[:] = out
    return out

def post(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(SERVER + "/api/pc", data=data, headers={"Content-Type": "application/json"})
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
            cpu = psutil.cpu_percent(interval=None) if psutil else 0
            ram = psutil.virtual_memory().percent if psutil else 0
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
