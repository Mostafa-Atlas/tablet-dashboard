"""Hardware/network boundaries are fakes; these tests never transmit telemetry."""
import io
import math
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from agent import agent as windows

from agent import telemetry


class WindowsRegressionTests(unittest.TestCase):
    def test_missing_gpu_is_unavailable_not_idle(self):
        with patch.dict('sys.modules', {'GPUtil': None}), patch('subprocess.check_output', side_effect=FileNotFoundError), patch('subprocess.run', side_effect=FileNotFoundError):
            self.assertIsNone(windows.gpu_pct())

    def test_invalid_gpu_value_is_not_sent(self):
        with patch.dict('sys.modules', {'GPUtil': None}), patch('subprocess.check_output', return_value=b'inf\n'), patch('subprocess.run', return_value=NS(stdout='inf, nan\n')):
            self.assertIsNone(windows.gpu_pct())

    def test_invalid_interval_does_not_break_import(self):
        with patch.dict(os.environ, {'INTERVAL': 'not-a-number'}), patch('sys.path', [str(Path(windows.__file__).parent)] + sys.path):
            try:
                runpy.run_path(str(Path(windows.__file__)), run_name='import_test')
            except ValueError as exc:
                self.fail(f'Configuration must be validated at startup, not import: {exc}')


class SharedAgentTests(unittest.TestCase):
    def setUp(self):
        # Startup tests must never read a user's agent/.env.
        env_loader = patch.object(telemetry, 'load_env')
        env_loader.start()
        self.addCleanup(env_loader.stop)
        self.hardware = Mock()
        self.hardware.cpu_percent.return_value = 21.5
        self.hardware.virtual_memory.return_value = NS(percent=42)
        self.hardware.boot_time.return_value = 100
        self.hardware.sensors_temperatures.return_value = {'coretemp': [NS(current=51, label='Package id 0')]}
        self.hardware.disk_partitions.return_value = [NS(mountpoint='/'), NS(mountpoint='/denied')]
        self.hardware.disk_usage.side_effect = lambda mount: NS(percent=25, free=75e9, total=100e9) if mount == '/' else (_ for _ in ()).throw(PermissionError())
        self.probe = Mock(return_value=NS(stdout='35, 64\n'))
        self.clock = Mock(return_value=1000)
        self.mono = Mock(return_value=0)
        self.sampler = telemetry.Sampler(psutil_module=self.hardware, run_command=self.probe, wall_clock=self.clock, monotonic=self.mono)

    def test_linux_sample_and_cpu_warmup(self):
        first = self.sampler.sample()
        self.assertIsNone(first['cpu'])
        sample = self.sampler.sample()
        self.assertEqual({key: sample[key] for key in ('cpu', 'ram', 'gpu', 'cpuTemp', 'gpuTemp', 'uptimeSec')}, {'cpu': 21.5, 'ram': 42, 'gpu': 35, 'cpuTemp': 51, 'gpuTemp': 64, 'uptimeSec': 900})
        self.assertEqual(sample['disks'], [{'mount': '/', 'pct': 25, 'freeGb': 75, 'totalGb': 100}])
        self.assertTrue(all(type(value) is bool for value in sample['capabilities'].values()))
        self.assertTrue(sample['capabilities']['cpu'])

    def test_unavailable_hardware_returns_null(self):
        sampler = telemetry.Sampler(psutil_module=None, run_command=Mock(side_effect=FileNotFoundError), wall_clock=self.clock, monotonic=self.mono)
        sample = sampler.sample()
        self.assertEqual([sample[key] for key in ('cpu', 'ram', 'gpu', 'cpuTemp', 'gpuTemp', 'uptimeSec')], [None] * 6)
        self.assertEqual(sample['disks'], [])
        self.assertFalse(any(sample['capabilities'].values()))

    def test_sensor_failures_are_isolated(self):
        self.hardware.cpu_percent.side_effect = OSError()
        self.hardware.sensors_temperatures.side_effect = PermissionError()
        self.hardware.boot_time.side_effect = OSError()
        self.probe.side_effect = subprocess.TimeoutExpired('nvidia-smi', 2)
        sample = self.sampler.sample()
        self.assertIsNone(sample['cpu'])
        self.assertIsNone(sample['cpuTemp'])
        self.assertIsNone(sample['uptimeSec'])
        self.assertIsNone(sample['gpu'])
        self.assertEqual(sample['ram'], 42)

    def test_gpu_probe_is_bounded_direct_no_shell(self):
        self.sampler.sample()
        args, kwargs = self.probe.call_args
        self.assertEqual(args[0][0], 'nvidia-smi')
        self.assertGreater(kwargs['timeout'], 0)
        self.assertLessEqual(kwargs['timeout'], 5)
        self.assertFalse(kwargs.get('shell', False))

    def test_zero_is_valid_and_nonfinite_values_are_unavailable(self):
        self.hardware.cpu_percent.return_value = 0
        self.hardware.virtual_memory.return_value = NS(percent=float('nan'))
        self.hardware.sensors_temperatures.return_value = {'coretemp': [NS(current=float('inf'), label='Package')]}
        self.hardware.boot_time.return_value = 2000
        self.probe.return_value.stdout = '0, N/A\n'
        self.sampler.sample()
        sample = self.sampler.sample()
        self.assertEqual(sample['cpu'], 0)
        self.assertEqual(sample['gpu'], 0)
        self.assertIsNone(sample['ram'])
        self.assertIsNone(sample['cpuTemp'])
        self.assertIsNone(sample['gpuTemp'])
        self.assertIsNone(sample['uptimeSec'])

    def test_unsupported_temperature_is_not_guessed_from_unrelated_sensor(self):
        self.hardware.sensors_temperatures.return_value = {'nvme': [NS(current=70, label='Composite')]}
        self.assertIsNone(self.sampler.sample()['cpuTemp'])

    def test_disk_cache_including_empty_avoids_repeated_io(self):
        self.assertEqual(len(self.sampler.sample()['disks']), 1)
        self.hardware.disk_partitions.side_effect = OSError()
        self.mono.return_value = 10
        self.assertEqual(len(self.sampler.sample()['disks']), 1)
        self.mono.return_value = 10801
        self.assertEqual(self.sampler.sample()['disks'], [])
        self.hardware.disk_partitions.side_effect = None
        self.mono.return_value = 10802
        self.assertEqual(self.sampler.sample()['disks'], [])
        self.mono.return_value = 21602
        self.assertEqual(len(self.sampler.sample()['disks']), 1)

    def test_invalid_disk_measurements_do_not_leak_nonfinite_numbers(self):
        self.hardware.disk_partitions.return_value = [NS(mountpoint='/')]
        self.hardware.disk_usage.side_effect = None
        self.hardware.disk_usage.return_value = NS(percent=float('nan'), free=float('inf'), total=100e9)
        self.assertEqual(self.sampler.sample()['disks'], [])

    def test_config_rejects_invalid_intervals_at_startup(self):
        for value in ('0', '-1', 'nan', 'inf', '-inf', '', 'abc', '1e999'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                telemetry.Config.from_env({'INTERVAL': value})
        config = telemetry.Config.from_env({'SERVER': 'https://dashboard.invalid/', 'INTERVAL': '0.5'})
        self.assertEqual(config.server, 'https://dashboard.invalid')
        self.assertEqual(config.interval, 0.5)

    def test_server_url_validated_without_network(self):
        for value in ('ftp://host', 'http://', 'http://user:pass@host', 'http://host?token=x', 'http://host/#fragment'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                telemetry.Config.from_env({'SERVER': value})

    def test_http_transport_posts_finite_json_with_timeout(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.status = 200
        opener = Mock(return_value=response)
        self.assertTrue(telemetry.post('http://dashboard.invalid', {'cpu': None, 'ram': 0}, opener=opener))
        req = opener.call_args.args[0]
        self.assertEqual(req.full_url, 'http://dashboard.invalid/api/pc')
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.data, b'{"cpu": null, "ram": 0}')
        self.assertGreater(opener.call_args.kwargs['timeout'], 0)
        self.assertLessEqual(opener.call_args.kwargs['timeout'], 5)
        response.read.assert_not_called()

    def test_transport_errors_are_reported_without_crashing_loop(self):
        for error in (URLError('unreachable'), TimeoutError(), HTTPError('http://dashboard.invalid', 503, 'Unavailable', {}, io.BytesIO())):
            with self.subTest(error=error), self.assertLogs('tablet_agent', level='WARNING'):
                self.assertFalse(telemetry.post('http://dashboard.invalid', {}, opener=Mock(side_effect=error)))

    def test_http_error_response_is_closed(self):
        body = io.BytesIO(b'error')
        error = HTTPError('http://dashboard.invalid', 503, 'Unavailable', {}, body)
        with self.assertLogs('tablet_agent', level='WARNING'):
            self.assertFalse(telemetry.post('http://dashboard.invalid', {}, opener=Mock(side_effect=error)))
        self.assertTrue(body.closed)

    def test_startup_rejects_unrepresentable_wait_interval(self):
        with self.assertRaises(ValueError):
            telemetry.Config.from_env({'INTERVAL': '1e308'})

    def test_both_entrypoints_validate_before_hardware_or_network(self):
        for filename in ('agent.py', 'linux_agent.py'):
            path = Path(windows.__file__).with_name(filename)
            with self.subTest(entrypoint=filename), patch.dict('sys.modules', {'telemetry': telemetry}), patch.dict(os.environ, {'SERVER': 'http://dashboard.invalid', 'INTERVAL': 'nan'}), patch.object(telemetry, 'Sampler') as sampler, patch('urllib.request.urlopen') as opener, self.assertLogs('tablet_agent', level='ERROR'):
                with self.assertRaises(SystemExit) as exit_result:
                    runpy.run_path(str(path), run_name='__main__')
                self.assertEqual(exit_result.exception.code, 2)
                sampler.assert_not_called()
                opener.assert_not_called()

    def test_sigterm_requests_shutdown_and_restores_handlers(self):
        handlers = {}
        original = Mock()
        def install(signum, handler):
            handlers[signum] = handler
            return original
        def running(config, sampler, stop):
            self.assertFalse(stop.is_set())
            handlers[signal.SIGTERM](signal.SIGTERM, None)
            self.assertTrue(stop.is_set())
        with patch.dict(os.environ, {'SERVER': 'http://dashboard.invalid', 'INTERVAL': '2'}), patch.object(telemetry, 'Sampler'), patch.object(telemetry, 'run', side_effect=running), patch('signal.signal', side_effect=install), self.assertLogs('tablet_agent', level='INFO'):
            self.assertEqual(telemetry.main(), 0)
        self.assertIs(handlers[signal.SIGTERM], original)
        self.assertIs(handlers[signal.SIGINT], original)

    def test_nonfinite_json_is_rejected_before_network(self):
        opener = Mock()
        with self.assertLogs('tablet_agent', level='WARNING'):
            self.assertFalse(telemetry.post('http://dashboard.invalid', {'cpu': math.inf}, opener=opener))
        opener.assert_not_called()

    def test_loop_recovers_after_send_error_and_stops_without_sleep_delay(self):
        stop = Mock()
        stop.is_set.side_effect = [False, False, True]
        sender = Mock(side_effect=[False, True])
        sampler = Mock()
        sampler.sample.return_value = {'cpu': None}
        telemetry.run(telemetry.Config('http://dashboard.invalid', 2), sampler, stop, sender=sender)
        self.assertEqual(sender.call_count, 2)
        self.assertEqual(stop.wait.call_args_list[0].args, (2,))


if __name__ == '__main__':
    unittest.main()
