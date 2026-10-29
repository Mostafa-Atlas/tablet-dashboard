"""Windows SDK/process/network boundaries are controlled doubles, never live I/O."""
import asyncio
import base64
import ctypes
import time
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

from agent import telemetry
try:
    from agent import media
except ImportError:
    media = None


def native_gil_stall_snapshot():
    """Test-only native stand-in: PyDLL retains the GIL during this OS sleep."""
    Path(os.environ['TABLET_AGENT_TEST_NATIVE_MARKER']).write_text('entered', encoding='utf-8')
    if os.name == 'nt':
        ctypes.PyDLL('kernel32').Sleep(3000)
    else:
        ctypes.PyDLL(None).usleep(3000000)
    return None


def discard_media_send(server, payload):
    raise AssertionError('Native-stall fixture must never submit media')


class EnvAndNativeTests(unittest.TestCase):
    def test_startup_env_file_preserves_real_environment(self):
        self.assertTrue(hasattr(telemetry, 'load_env'), 'startup .env loader is missing')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('# example\nSERVER="http://file.invalid:1200"\nINTERVAL=3\nMEDIA_ENABLED=0\n', encoding='utf-8')
            environment = {'SERVER': 'http://real.invalid:1200'}
            telemetry.load_env(path, environment)
            config = telemetry.Config.from_env(environment)
            self.assertEqual(config.server, 'http://real.invalid:1200')
            self.assertEqual(config.interval, 3)
            self.assertEqual(environment['MEDIA_ENABLED'], '0')

    def native_sampler(self, rows):
        self.assertTrue(hasattr(telemetry, 'WindowsNative'), 'Windows fallback is missing')
        run = Mock(side_effect=[NS(stdout=json.dumps(row)) for row in rows])
        native = telemetry.WindowsNative(run_command=run)
        sampler = telemetry.Sampler(psutil_module=None, run_command=Mock(side_effect=FileNotFoundError), native=native)
        return sampler, run

    def test_windows_native_cpu_ram_disks_when_psutil_missing(self):
        sampler, run = self.native_sampler([{'cpu': 0, 'total': 100, 'free': 25}, [{'DeviceID': 'C:', 'Size': 100e9, 'FreeSpace': 75e9}]])
        sample = sampler.sample()
        self.assertEqual(sample['cpu'], 0)
        self.assertEqual(sample['ram'], 75)
        self.assertEqual(sample['disks'], [{'mount': 'C:', 'pct': 25, 'freeGb': 75, 'totalGb': 100}])
        self.assertIsNone(sample['uptimeSec'])
        for args, kwargs in run.call_args_list:
            self.assertEqual(args[0][0], 'powershell')
            self.assertFalse(kwargs.get('shell', False))
            self.assertLessEqual(kwargs['timeout'], 3)

    def test_windows_native_bad_values_and_empty_disk_cache(self):
        sampler, run = self.native_sampler([{'cpu': float('inf'), 'total': 100, 'free': 101}, [{'DeviceID': 'C:', 'Size': 0, 'FreeSpace': 0}], {'cpu': 1000, 'total': -1, 'free': 0}])
        first = sampler.sample()
        second = sampler.sample()
        self.assertIsNone(first['cpu'])
        self.assertIsNone(first['ram'])
        self.assertEqual(first['disks'], [])
        self.assertEqual(second['disks'], [])
        self.assertIsNone(second['cpu'])
        self.assertEqual(run.call_count, 3)

    def test_windows_native_malformed_json_is_unavailable(self):
        self.assertTrue(hasattr(telemetry, 'WindowsNative'), 'Windows fallback is missing')
        for output in ('not-json', '[]', 'null', '1', '"text"', 'x' * 70000):
            native = telemetry.WindowsNative(run_command=Mock(return_value=NS(stdout=output)))
            self.assertEqual(native.system(), (None, None))
            self.assertEqual(native.disks(), [])

    def test_missing_psutil_on_linux_stops_before_reporting(self):
        with patch.dict(os.environ, {'SERVER': 'http://fixture.invalid', 'INTERVAL': '2'}), patch.object(telemetry, 'psutil', None), patch.object(telemetry, 'load_env'), patch.object(telemetry, 'run') as run, self.assertLogs('tablet_agent', level='ERROR'):
            self.assertEqual(telemetry.main(), 2)
            run.assert_not_called()

    def test_startup_loads_fixture_env_before_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('INTERVAL=invalid\n', encoding='utf-8')
            loader = telemetry.load_env
            with patch.dict(os.environ, {}, clear=True), patch.object(telemetry, 'load_env', side_effect=lambda: loader(path)), patch.object(telemetry, 'Sampler') as sampler, self.assertLogs('tablet_agent', level='ERROR'):
                self.assertEqual(telemetry.main(), 2)
                sampler.assert_not_called()

    def test_native_process_timeout_is_unavailable(self):
        import subprocess
        native = telemetry.WindowsNative(run_command=Mock(side_effect=subprocess.TimeoutExpired('powershell', 2)))
        self.assertEqual(native.system(), (None, None))
        self.assertEqual(native.disks(), [])

    def test_windows_automatically_uses_native_when_psutil_missing(self):
        readings = iter([NS(stdout='{"cpu":12,"total":100,"free":50}'), NS(stdout='[]')])
        def command(args, **kwargs):
            if args[0] == 'nvidia-smi':
                raise FileNotFoundError()
            return next(readings)
        with patch.object(telemetry.sys, 'platform', 'win32'):
            sample = telemetry.Sampler(psutil_module=None, run_command=command).sample()
        self.assertEqual(sample['cpu'], 12)
        self.assertEqual(sample['ram'], 50)
        self.assertEqual(sample['disks'], [])


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(media, 'optional bounded Windows media reporter is missing')

    def sdk(self, *, stream=None, hung=None, props_none=False, no_session=False):
        async def hang_or(value, name):
            if hung == name:
                await asyncio.Event().wait()
            return value
        props = NS(title='Song', artist='Artist', album_title='Album', subtitle='', thumbnail=None)
        session = NS(source_app_user_model_id='SpotifyAB!App',
                     get_playback_info=lambda: NS(playback_status=4),
                     try_get_media_properties_async=lambda: hang_or(None if props_none else props, 'properties'))
        manager = NS(get_current_session=lambda: None if no_session else session)
        if stream:
            props.thumbnail = NS(open_read_async=lambda: hang_or(stream, 'open'))
        sdk = NS(manager=NS(request_async=lambda: hang_or(manager, 'manager')),
                 buffer=lambda capacity: bytearray(capacity), read_ahead=1)
        return sdk

    def test_returned_thumbnail_buffer_consumed_and_stream_closed(self):
        async def read(buffer, capacity, options):
            return b'actual returned bytes'
        stream = NS(size=21, content_type='image/png', read_async=read, close=Mock())
        snapshot = media.snapshot(self.sdk(stream=stream))
        self.assertEqual(snapshot['thumb'], 'data:image/png;base64,' + base64.b64encode(b'actual returned bytes').decode())
        self.assertEqual(snapshot['app'], 'Spotify')
        self.assertEqual(snapshot['title'], 'Song')
        self.assertTrue(snapshot['playing'])
        stream.close.assert_called_once()


    def test_returned_buffer_uses_actual_length_instead_of_capacity(self):
        class ReturnedBuffer:
            length = 3
            def __bytes__(self):
                return b'abc\0\0'
        async def read(buffer, capacity, options):
            return ReturnedBuffer()
        stream = NS(size=5, content_type='image/png', read_async=read, close=Mock())
        result = media.snapshot(self.sdk(stream=stream))
        self.assertEqual(result['thumb'], 'data:image/png;base64,YWJj')

    def test_all_optional_awaits_are_bounded_and_stream_closes_on_timeout(self):
        async def read(buffer, capacity, options):
            await asyncio.Event().wait()
        stream = NS(size=20, content_type='image/png', read_async=read, close=Mock())
        for stage in ('manager', 'properties', 'open', 'read'):
            with self.subTest(stage=stage):
                sdk = self.sdk(stream=stream, hung=stage)
                started = __import__('time').monotonic()
                result = media.snapshot(sdk, timeout=0.01)
                self.assertLess(__import__('time').monotonic() - started, 0.3)
                self.assertTrue(result is None or 'thumb' not in result)
        stream.close.assert_called_once()

    def test_thumbnail_limits_and_invalid_types_do_not_drop_metadata(self):
        for size, content_type in ((200000, 'image/png'), (20, 'text/html')):
            stream = NS(size=size, content_type=content_type, read_async=Mock(side_effect=AssertionError('must not read')), close=Mock())
            result = media.snapshot(self.sdk(stream=stream))
            self.assertEqual(result['title'], 'Song')
            self.assertNotIn('thumb', result)
            stream.close.assert_called_once()

    def test_no_session_clears_playing_and_sdk_error_skips_update(self):
        self.assertFalse(media.snapshot(self.sdk(no_session=True))['playing'])
        self.assertFalse(media.snapshot(self.sdk(props_none=True))['playing'])
        sdk = self.sdk()
        sdk.manager.request_async = Mock(side_effect=OSError())
        self.assertIsNone(media.snapshot(sdk))

    def test_artwork_acknowledged_only_after_successful_send(self):
        sender = Mock(side_effect=[False, True, True, True])
        now = Mock(return_value=10)
        snap = {'playing': True, 'title': 'Song', 'artist': 'Artist', 'album': 'Album', 'app': 'Spotify', 'thumb': 'data:image/png;base64,YQ=='}
        reporter = media.Reporter('http://fixture.invalid', snapshotter=lambda: snap, sender=sender, monotonic=now)
        reporter.report()
        reporter.report()
        reporter.report()
        self.assertIn('thumb', sender.call_args_list[0].args[1])
        self.assertIn('thumb', sender.call_args_list[1].args[1])
        self.assertNotIn('thumb', sender.call_args_list[2].args[1])
        now.return_value = 71
        reporter.report()
        self.assertIn('thumb', sender.call_args_list[3].args[1])

    def test_track_change_failed_upload_retries_artwork(self):
        snap = {'playing': True, 'title': 'First', 'artist': '', 'album': '', 'app': '', 'thumb': 'data:image/png;base64,YQ=='}
        sender = Mock(side_effect=[True, False, True])
        reporter = media.Reporter('http://fixture.invalid', snapshotter=lambda: dict(snap), sender=sender)
        reporter.report()
        snap['title'] = 'Second'
        reporter.report()
        reporter.report()
        self.assertIn('thumb', sender.call_args_list[2].args[1])



    def test_returning_to_prior_track_resends_art_after_metadata_only_track(self):
        snap = {'playing': True, 'title': 'First', 'thumb': 'data:image/png;base64,YQ=='}
        sender = Mock(return_value=True)
        reporter = media.Reporter('http://fixture.invalid', snapshotter=lambda: dict(snap), sender=sender)
        reporter.report()
        snap.update(title='Second', thumb=None)
        reporter.report()
        snap.update(title='First', thumb='data:image/png;base64,YQ==')
        reporter.report()
        self.assertIn('thumb', sender.call_args_list[2].args[1])

    def test_missing_or_unsupported_sdk_keeps_telemetry_only_path(self):
        with patch.object(media.sys, 'platform', 'win32'), patch.object(media.sys, 'version_info', (3, 14)), patch.dict('sys.modules', {'winsdk': None}), self.assertLogs('tablet_agent', level='INFO'):
            self.assertIsNone(media.create_reporter('http://fixture.invalid'))
        with patch.dict('sys.modules', {'winsdk': None}), self.assertLogs('tablet_agent', level='INFO'):
            self.assertIsNone(media.SDKSnapshotter()())


    def test_optional_media_start_failure_still_runs_pc_loop(self):
        with patch.dict(os.environ, {'SERVER': 'http://fixture.invalid', 'INTERVAL': '2', 'MEDIA_ENABLED': '1'}), patch.object(telemetry, 'load_env'), patch.object(telemetry, 'Sampler'), patch.object(telemetry, 'run') as run, patch.object(media, 'create_reporter', side_effect=RuntimeError('SDK init failed')), patch('signal.signal'), self.assertLogs('tablet_agent', level='WARNING'):
            try:
                result = telemetry.main(windows_media=True)
            except RuntimeError as exc:
                self.fail(f'Optional media must not stop telemetry: {exc}')
            self.assertEqual(result, 0)
            run.assert_called_once()

    def test_media_exceptions_retry_without_stopping_worker(self):
        now = Mock(return_value=0)
        stop = Mock()
        stop.is_set.side_effect = [False, False, True]
        stop.wait.side_effect = lambda seconds: setattr(now, 'return_value', now.return_value + seconds)
        snapshots = Mock(side_effect=[OSError(), {'playing': False}])
        sent = []
        reporter = media.Reporter('http://fixture.invalid', snapshotter=snapshots, sender=lambda server, payload: sent.append(payload) or True, monotonic=now)
        reporter.run(stop)
        self.assertEqual(sent, [{'title': '', 'artist': '', 'album': '', 'app': '', 'playing': False}])
    def test_media_transport_bounded_and_does_not_read_response_body(self):
        response = Mock(status=204)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock(return_value=response)
        self.assertTrue(media.post('http://fixture.invalid', {'playing': False}, opener=opener))
        self.assertEqual(opener.call_args.args[0].full_url, 'http://fixture.invalid/api/now-playing')
        self.assertLessEqual(opener.call_args.kwargs['timeout'], 5)
        response.read.assert_not_called()

    def test_media_cadence_uses_monotonic_elapsed_time(self):
        now = Mock(return_value=0)
        stop = Mock()
        stop.is_set.side_effect = [False, False, False, False, True]
        def wait(seconds):
            now.return_value += seconds
        stop.wait.side_effect = wait
        sent_at = []
        def snapshotter():
            sent_at.append(now.return_value)
            now.return_value += 2  # Snapshot/send time counts toward the cadence.
            return {'playing': False}
        reporter = media.Reporter('http://fixture.invalid', snapshotter=snapshotter, sender=lambda *args: True, monotonic=now)
        reporter.run(stop)
        self.assertEqual(sent_at, [0, 5, 10, 15])

    def test_native_gil_stall_cannot_block_pc_reporting_or_shutdown(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'TABLET_AGENT_TEST_NATIVE_MARKER': str(Path(directory) / 'entered')}):
            marker = Path(directory) / 'entered'
            reporter = media.Reporter('http://fixture.invalid', snapshotter=native_gil_stall_snapshot, sender=discard_media_send)
            stop = threading.Event()
            started = time.monotonic()
            worker = reporter.start(stop)
            sent_at = []
            try:
                deadline = started + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.005)
                self.assertTrue(marker.exists(), 'native fixture did not start')
                sampler = Mock()
                sampler.sample.return_value = {'cpu': 0}
                def sender(server, sample):
                    sent_at.append(time.monotonic() - started)
                    if len(sent_at) == 3:
                        stop.set()
                telemetry.run(telemetry.Config('http://fixture.invalid', 0.01), sampler, stop, sender=sender)
            finally:
                stop.set()
                shutdown_started = time.monotonic()
                if hasattr(worker, 'close'):
                    worker.close()
                else:
                    worker.join(0.2)
                shutdown_elapsed = time.monotonic() - shutdown_started
            self.assertEqual(len(sent_at), 3)
            self.assertLess(sent_at[0], 1.0, f'GIL-retaining media stalled the first PC send: {sent_at}')
            self.assertLess(sent_at[-1], 1.2)
            self.assertLess(shutdown_elapsed, 0.6)
            self.assertFalse(worker.is_alive())

    def test_single_worker_and_bounded_cleanup_escalate_to_kill(self):
        class StuckProcess:
            running = True
            waits = []
            terminated = False
            killed = False
            closed = False
            def start(self):
                pass
            def is_alive(self):
                return self.running
            def terminate(self):
                self.terminated = True
            def kill(self):
                self.killed = True
                self.running = False
            def join(self, timeout):
                self.waits.append(timeout)
            def close(self):
                self.closed = True
        process = StuckProcess()
        context = NS(Process=Mock(return_value=process))
        with patch.object(media.multiprocessing, 'get_context', return_value=context):
            reporter = media.Reporter('http://fixture.invalid', snapshotter=discard_media_send)
            worker = reporter.start(threading.Event())
            self.assertIs(reporter.start(threading.Event()), worker)
        worker.close()
        worker.close()
        self.assertEqual(context.Process.call_count, 1)
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertEqual(process.waits, [0.2, 0.2])
        self.assertTrue(process.closed)
        self.assertFalse(worker.is_alive())

    def test_sdk_import_and_initialization_are_deferred_until_worker(self):
        import builtins
        real_import = builtins.__import__
        attempted = []
        def guarded_import(name, *args, **kwargs):
            if name.startswith('winsdk'):
                attempted.append(name)
                raise AssertionError('SDK import attempted in PC process')
            return real_import(name, *args, **kwargs)
        with patch.object(media.sys, 'platform', 'win32'), patch.object(media.sys, 'version_info', (3, 11)), patch('builtins.__import__', side_effect=guarded_import):
            reporter = media.create_reporter('http://fixture.invalid')
        self.assertIsInstance(reporter, media.Reporter)
        self.assertEqual(attempted, [])
