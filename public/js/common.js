// Application wall time is independent of the browser/device timezone.
const DashboardTime = {
  zone: 'Africa/Cairo',
  serverOffsetMs: 0,
  sync(serverNow) { if (Number.isFinite(serverNow)) this.serverOffsetMs = serverNow - Date.now(); },
  now() { return Date.now() + this.serverOffsetMs; },
  setZone(zone) { if (zone) this.zone = zone; },
  parts(ms) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: this.zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  },
  time(ms, seconds = false) { const p = this.parts(ms); return `${p.hour}:${p.minute}${seconds ? ':' + p.second : ''} ${p.dayPeriod}`; },
  date(ms) { const p = this.parts(ms); return `${p.day}-${p.month}-${p.year}`; },
  day(ms) { const p = this.parts(ms); return `${p.year}-${p.month.padStart(2, '0')}-${p.day.padStart(2, '0')}`; },
  today(event, now = this.now()) { const day = this.day(now); return this.day(event.startMs) <= day && this.day(Math.max(event.startMs, event.endMs - 1)) >= day; },
  stale(cache, maxAge) { return !!cache && (cache.stale || !cache.updatedAt || this.now() - cache.updatedAt > maxAge); }
};
