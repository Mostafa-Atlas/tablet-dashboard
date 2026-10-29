"""Optional Windows SMTC publisher, isolated from PC sampling and shutdown."""
import asyncio
import base64
import logging
import multiprocessing
import sys
import threading
import time
from types import SimpleNamespace

if __package__:
    from .telemetry import post as post_payload
else:
    from telemetry import post as post_payload

LOG = logging.getLogger('tablet_agent')
MEDIA_INTERVAL_SEC = 5
MEDIA_TIMEOUT_SEC = 2.5
THUMB_MAX_BYTES = 160 * 1024
IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}


def pretty_app(uid):
    uid = uid if isinstance(uid, str) else ''
    for fragment, name in (('spotify', 'Spotify'), ('chrome', 'Chrome'), ('msedge', 'Edge'), ('edge', 'Edge'), ('firefox', 'Firefox')):
        if fragment in uid.lower():
            return name
    return uid.split('!')[0].split('_')[0][:120]


async def _snapshot(sdk):
    manager = await sdk.manager.request_async()
    session = manager.get_current_session()
    if session is None:
        return {'playing': False}
    status = session.get_playback_info().playback_status
    playing = getattr(status, 'name', '') == 'PLAYING' or int(status) == 4
    props = await session.try_get_media_properties_async()
    if props is None:
        return {'playing': False}
    def text(value, limit):
        return value[:limit] if isinstance(value, str) else ''
    result = {'playing': playing, 'title': text(getattr(props, 'title', ''), 300),
              'artist': text(getattr(props, 'artist', ''), 300),
              'album': text(getattr(props, 'album_title', '') or getattr(props, 'subtitle', ''), 300),
              'app': pretty_app(getattr(session, 'source_app_user_model_id', ''))}
    stream = None
    try:
        ref = getattr(props, 'thumbnail', None)
        if ref is not None:
            stream = await ref.open_read_async()
            size = stream.size
            content_type = (getattr(stream, 'content_type', '') or 'image/jpeg').lower()
            if isinstance(size, int) and 0 < size < THUMB_MAX_BYTES and content_type in IMAGE_TYPES:
                # WinRT can return a different IBuffer from the one passed in.
                buffer = await stream.read_async(sdk.buffer(size), size, sdk.read_ahead)
                raw = bytes(buffer)
                length = getattr(buffer, 'length', len(raw))
                raw = raw[:length] if isinstance(length, int) and 0 < length <= len(raw) else b''
                if 0 < len(raw) <= size:
                    result['thumb'] = 'data:' + content_type + ';base64,' + base64.b64encode(raw).decode('ascii')
    except Exception:
        LOG.debug('Media artwork unavailable', exc_info=True)
    finally:
        if stream is not None:
            try:
                stream.close()
            except Exception:
                LOG.debug('Media artwork stream close failed', exc_info=True)
    return result


def snapshot(sdk, timeout=MEDIA_TIMEOUT_SEC):
    async def bounded():
        return await asyncio.wait_for(_snapshot(sdk), timeout=timeout)
    try:
        return asyncio.run(bounded())
    except Exception:
        LOG.debug('Media snapshot unavailable', exc_info=True)
        return None


def post(server, payload, opener=None):
    return post_payload(server, payload, opener=opener, path='/api/now-playing')


class Reporter:
    def __init__(self, server, snapshotter, sender=post, monotonic=time.monotonic):
        self.server, self.snapshotter, self.sender = server, snapshotter, sender
        self.monotonic = monotonic
        self.art_key = None
        self.art_at = None
        self.worker = None

    def report(self):
        snap = self.snapshotter()
        if snap is None:
            return
        payload = {key: snap.get(key, '') for key in ('title', 'artist', 'album', 'app')}
        payload['playing'] = bool(snap.get('playing'))
        key = tuple(payload[name] for name in ('title', 'artist', 'album', 'app'))
        now = self.monotonic()
        if snap.get('thumb') and (key != self.art_key or self.art_at is None or now - self.art_at >= 60):
            payload['thumb'] = snap['thumb']
        if self.sender(self.server, payload):
            if 'thumb' in payload:
                self.art_key, self.art_at = key, now
            elif key != self.art_key:
                # A successful different-track metadata update clears the server's old art.
                self.art_key, self.art_at = None, None

    def run(self, stop):
        while not stop.is_set():
            started = self.monotonic()
            try:
                self.report()
            except Exception:
                LOG.debug('Media cycle failed; PC reporting continues', exc_info=True)
            stop.wait(max(0, MEDIA_INTERVAL_SEC - (self.monotonic() - started)))

    def start(self, stop):
        if self.worker is not None:
            return self.worker
        if stop.is_set():
            return None
        worker = ProcessWorker(self.server, self.snapshotter, self.sender, self.monotonic)
        try:
            worker.start()
        except Exception:
            worker.close()
            raise
        self.worker = worker
        return worker


class ProcessWorker:
    """One spawn child; no native calls, media payload pipes or shared locks in parent."""
    def __init__(self, server, snapshotter, sender, monotonic):
        self.process = multiprocessing.get_context('spawn').Process(
            target=_run_reporter, args=(server, snapshotter, sender, monotonic),
            name='tablet-media', daemon=True,
        )
        self.closed = False

    def start(self):
        self.process.start()

    def is_alive(self):
        return not self.closed and self.process.is_alive()

    def close(self):
        if self.closed:
            return
        try:
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(timeout=0.2)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join(timeout=0.2)
            else:
                self.process.join(timeout=0)
            if self.process.is_alive():
                LOG.warning('Media child has not exited after terminate/kill deadlines')
                return
            self.process.close()
            self.closed = True
        except (OSError, ValueError, AssertionError):
            LOG.warning('Media child cleanup failed', exc_info=True)


def _run_reporter(server, snapshotter, sender, monotonic):
    # Spawn imports this module afresh without loading the SDK or agent/.env.
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    Reporter(server, snapshotter, sender=sender, monotonic=monotonic).run(threading.Event())


class SDKSnapshotter:
    """Lazy SDK loading happens only when called in the isolated worker."""
    def __init__(self):
        self.sdk = None
        self.attempted = False

    def __call__(self):
        if not self.attempted:
            self.attempted = True
            try:
                from winsdk.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
                from winsdk.windows.storage.streams import Buffer, InputStreamOptions
                self.sdk = SimpleNamespace(manager=GlobalSystemMediaTransportControlsSessionManager,
                                           buffer=Buffer, read_ahead=InputStreamOptions.READ_AHEAD)
            except Exception:
                LOG.info('Optional winsdk unavailable; PC telemetry continues')
        return snapshot(self.sdk) if self.sdk is not None else None


def create_reporter(server):
    if sys.platform != 'win32' or not (3, 8) <= sys.version_info[:2] < (3, 13):
        LOG.info('Now Playing unavailable on this platform/Python; PC telemetry continues')
        return None
    # Do not import or initialize native SDK code on the PC startup path.
    return Reporter(server, snapshotter=SDKSnapshotter())
