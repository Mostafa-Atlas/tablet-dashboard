"""Shared, best-effort telemetry for one Windows or Linux reporting machine."""
from dataclasses import dataclass
import json
import logging
import math
import os
from pathlib import Path
import sys
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import psutil
except ImportError:
    psutil = None

LOG = logging.getLogger('tablet_agent')
DISK_EVERY_SEC = 3 * 3600
GPU_TIMEOUT_SEC = 2
HTTP_TIMEOUT_SEC = 5
_DEFAULT_PSUTIL = object()
_DEFAULT_NATIVE = object()


def load_env(path=None, environ=None):
    """Load agent/.env at startup only, preserving process/service settings."""
    environ = os.environ if environ is None else environ
    path = Path(__file__).with_name('.env') if path is None else Path(path)
    try:
        for raw in path.read_text(encoding='utf-8-sig').splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = (item.strip() for item in line.split('=', 1))
            if key not in ('SERVER', 'INTERVAL', 'MEDIA_ENABLED'):
                continue
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            environ.setdefault(key, value)
    except FileNotFoundError:
        pass
    except (OSError, UnicodeError):
        LOG.warning('Cannot read agent environment file')


class WindowsNative:
    """Bounded CIM fallback for Windows installations without psutil."""
    def __init__(self, run_command=None):
        self.run_command = subprocess.run if run_command is None else run_command

    def _query(self, command):
        try:
            result = self.run_command(
                ['powershell', '-NoProfile', '-NonInteractive', '-Command', command],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                timeout=2, check=True,
            )
            if len(result.stdout) > 65536:
                return None
            return json.loads(result.stdout)
        except (OSError, subprocess.SubprocessError, ValueError, TypeError):
            return None

    def system(self):
        data = self._query(
            '$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; '
            '$os=Get-CimInstance Win32_OperatingSystem; '
            '@{cpu=$cpu;total=$os.TotalVisibleMemorySize;free=$os.FreePhysicalMemory} | ConvertTo-Json -Compress'
        )
        if not isinstance(data, dict):
            return None, None
        cpu = measurement(data.get('cpu'), 0, 100)
        total, free = measurement(data.get('total')), measurement(data.get('free'))
        ram = measurement((total - free) / total * 100, 0, 100) if total and free is not None and free <= total else None
        return cpu, ram

    def disks(self):
        data = self._query(
            '(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | '
            'Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress)'
        )
        if isinstance(data, dict):
            data = [data]
        disks = []
        for row in data if isinstance(data, list) else []:
            if not isinstance(row, dict):
                continue
            mount = row.get('DeviceID')
            total, free = measurement(row.get('Size')), measurement(row.get('FreeSpace'))
            if not isinstance(mount, str) or not mount or not total or free is None or free > total:
                continue
            disks.append({'mount': mount, 'pct': round((total - free) / total * 100, 1),
                          'freeGb': round(free / 1e9, 1), 'totalGb': round(total / 1e9, 1)})
        return disks


def measurement(value, minimum=0, maximum=None):
    """Only finite sensor numbers within the backend's supported range."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < minimum or (maximum is not None and value > maximum):
        return None
    return round(value, 1)


@dataclass(frozen=True)
class Config:
    server: str
    interval: float

    @classmethod
    def from_env(cls, environ=None):
        environ = os.environ if environ is None else environ
        try:
            interval = float(environ.get('INTERVAL', '2'))
        except (TypeError, ValueError) as exc:
            raise ValueError('INTERVAL must be a positive finite number of seconds') from exc
        if not math.isfinite(interval) or interval <= 0 or interval > threading.TIMEOUT_MAX:
            raise ValueError('INTERVAL must be a positive finite number of seconds')
        server = environ.get('SERVER', 'http://localhost:1200').strip().rstrip('/')
        try:
            url = urllib.parse.urlsplit(server)
            valid = (url.scheme in ('http', 'https') and url.hostname and not url.username
                     and not url.password and not url.query and not url.fragment
                     and not any(char.isspace() for char in server))
            url.port  # Reject malformed ports before starting the loop.
        except ValueError as exc:
            raise ValueError('SERVER must be an http(s) URL without credentials, query or fragment') from exc
        if not valid:
            raise ValueError('SERVER must be an http(s) URL without credentials, query or fragment')
        return cls(server, interval)


def probe_gpu(run_command=None):
    """First NVIDIA GPU only; no GPUtil subprocess with an unbounded wait."""
    run_command = subprocess.run if run_command is None else run_command
    try:
        result = run_command(
            ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            timeout=GPU_TIMEOUT_SEC, check=True,
        )
        row = result.stdout.splitlines()[0].split(',')
        def parse(index, minimum, maximum):
            try:
                return measurement(float(row[index].strip()), minimum, maximum)
            except (ValueError, IndexError):
                return None
        return parse(0, 0, 100), parse(1, -100, 250)
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return None, None


class Sampler:
    def __init__(self, psutil_module=_DEFAULT_PSUTIL, run_command=None,
                 wall_clock=time.time, monotonic=time.monotonic, native=_DEFAULT_NATIVE):
        self.psutil = psutil if psutil_module is _DEFAULT_PSUTIL else psutil_module
        self.run_command = run_command
        self.native = (WindowsNative(run_command) if sys.platform == 'win32' else None) if native is _DEFAULT_NATIVE else native
        self.wall_clock = wall_clock
        self.monotonic = monotonic
        self.cpu_primed = False
        self.disk_sample = []
        self.disk_checked_at = None

    def _read(self, getter, minimum=0, maximum=None):
        try:
            return measurement(getter(), minimum, maximum)
        except Exception as exc:
            LOG.debug('Sensor unavailable: %s', exc)
            return None

    def _cpu_temperature(self):
        try:
            sensors = self.psutil.sensors_temperatures()
            # Do not label motherboard, SSD or unrelated thermal-zone heat as CPU heat.
            readings = []
            for name, entries in sensors.items():
                if name.lower() in ('coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal'):
                    readings.extend(measurement(entry.current, -100, 250) for entry in entries)
            return max((value for value in readings if value is not None), default=None)
        except Exception as exc:
            LOG.debug('CPU temperature unavailable: %s', exc)
            return None

    def _disks(self):
        now = self.monotonic()
        if self.disk_checked_at is not None and now - self.disk_checked_at < DISK_EVERY_SEC:
            return list(self.disk_sample)
        disks = []
        if self.psutil is not None:
            try:
                partitions = self.psutil.disk_partitions(all=False)
            except Exception as exc:
                LOG.debug('Disk list unavailable: %s', exc)
                partitions = []
            seen = set()
            for partition in partitions:
                try:
                    mount = partition.mountpoint
                    if not isinstance(mount, str) or not mount or mount in seen:
                        continue
                    seen.add(mount)
                    usage = self.psutil.disk_usage(mount)
                    pct = measurement(usage.percent, 0, 100)
                    if pct is None:
                        continue
                    free = measurement(usage.free)
                    total = measurement(usage.total)
                    disks.append({'mount': mount, 'pct': pct,
                                  'freeGb': round(free / 1e9, 1) if free is not None else None,
                                  'totalGb': round(total / 1e9, 1) if total is not None else None})
                except Exception as exc:
                    LOG.debug('Disk unavailable: %s', exc)
        elif self.native is not None:
            disks = self.native.disks()
        self.disk_sample, self.disk_checked_at = disks, now
        return list(disks)

    def sample(self):
        cpu = ram = cpu_temp = uptime = None
        if self.psutil is not None:
            # psutil's first nonblocking CPU result has no prior interval and is meaningless.
            cpu = self._read(lambda: self.psutil.cpu_percent(interval=None), 0, 100)
            if not self.cpu_primed:
                cpu = None
                self.cpu_primed = True
            ram = self._read(lambda: self.psutil.virtual_memory().percent, 0, 100)
            cpu_temp = self._cpu_temperature()
            uptime = self._read(lambda: self.wall_clock() - self.psutil.boot_time())
        elif self.native is not None:
            cpu, ram = self.native.system()
        gpu, gpu_temp = probe_gpu(self.run_command)
        sample = {'cpu': cpu, 'ram': ram, 'gpu': gpu, 'cpuTemp': cpu_temp,
                  'gpuTemp': gpu_temp, 'uptimeSec': uptime, 'disks': self._disks()}
        sample['capabilities'] = {key: value is not None for key, value in sample.items() if key != 'disks'}
        sample['capabilities']['disks'] = bool(sample['disks'])
        return sample


def post(server, payload, opener=None, path='/api/pc'):
    opener = urllib.request.urlopen if opener is None else opener
    try:
        data = json.dumps(payload, allow_nan=False).encode('utf-8')
        request = urllib.request.Request(server + path, data=data, headers={'Content-Type': 'application/json'})
        with opener(request, timeout=HTTP_TIMEOUT_SEC) as response:
            if not 200 <= response.status < 300:
                LOG.warning('Telemetry rejected: HTTP %s', response.status)
                return False
            # The response body is unnecessary; do not wait on an unbounded streaming read.
        return True
    except urllib.error.HTTPError as exc:
        LOG.warning('Telemetry rejected: HTTP %s', exc.code)
        exc.close()
        return False
    except (urllib.error.URLError, OSError, ValueError, TypeError) as exc:
        LOG.warning('Telemetry send failed (%s)', type(exc).__name__)
        return False


def run(config, sampler, stop, sender=post):
    while not stop.is_set():
        try:
            sender(config.server, sampler.sample())
        except Exception:
            LOG.exception('Telemetry cycle failed; retrying after interval')
        stop.wait(config.interval)


def main(windows_media=False):
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    load_env()
    try:
        config = Config.from_env()
    except ValueError as exc:
        LOG.error('%s', exc)
        return 2
    if psutil is None:
        if sys.platform != 'win32':
            LOG.error('psutil is required on Linux; install agent/requirements.txt')
            return 2
        LOG.warning('psutil is not installed; using bounded Windows CPU/RAM/disk fallback')
    LOG.info('Agent reporting to %s every %gs; one reporting machine per dashboard', config.server, config.interval)
    stop = threading.Event()
    previous_handlers = {}
    def shutdown(signum, frame):
        stop.set()
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, shutdown)
    worker = None
    if windows_media and os.environ.get('MEDIA_ENABLED', '1').strip().lower() not in ('0', 'false', 'no'):
        if __package__:
            from .media import create_reporter
        else:
            from media import create_reporter
        try:
            reporter = create_reporter(config.server)
            if reporter is not None:
                worker = reporter.start(stop)
        except Exception:
            LOG.warning('Optional media startup failed; PC telemetry continues', exc_info=True)
    try:
        run(config, Sampler(), stop)
    except KeyboardInterrupt:
        stop.set()
    finally:
        stop.set()
        if worker is not None:
            worker.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        LOG.info('Agent stopped')
    return 0
