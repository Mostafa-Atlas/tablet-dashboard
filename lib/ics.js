// Minimal ICS (iCal) fetch + parse for Google Calendar "secret address in iCal format".
// No deps. Handles: VEVENT, DTSTART/DTEND (UTC, TZID, floating, all-day),
// DURATION fallback, SUMMARY/LOCATION, RRULE FREQ=DAILY|WEEKLY (+INTERVAL/COUNT/UNTIL).
const DEFAULT_TZ = 'Africa/Cairo';

async function fetchIcs(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'tablet-dashboard/1.0', Accept: 'text/calendar' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n')
    .reduce((acc, line) => {
      if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += line.slice(1);
      else acc.push(line);
      return acc;
    }, []);
}

function parseProp(line) {
  // NAME(;PARAM=VAL)*:value
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i), value = line.slice(i + 1);
  const parts = left.split(';');
  const name = parts[0];
  const params = {};
  for (const p of parts.slice(1)) {
    const e = p.indexOf('=');
    if (e > 0) params[p.slice(0, e)] = p.slice(e + 1);
  }
  return { name, params, value };
}

// --- timezone handling (stdlib Intl, no deps) ---
const fmtCache = {};
function tzFormatter(tz) {
  if (!fmtCache[tz]) {
    fmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  return fmtCache[tz];
}
function zonedToUtcMs(c, tz) {
  // wall-clock components c in zone tz -> epoch ms
  const guess = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s);
  let off = 0;
  try {
    const parts = Object.fromEntries(
      tzFormatter(tz).formatToParts(new Date(guess)).map(p => [p.type, p.value])
    );
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    off = asUtc - guess;
  } catch { off = 0; /* unknown TZID -> treat as UTC */ }
  return guess - off;
}

function parseDt(value, params) {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const c = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
    if (m[7] === 'Z') return { ms: Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s), dateOnly: false };
    const tz = params.TZID || DEFAULT_TZ;
    return { ms: zonedToUtcMs(c, tz), dateOnly: false };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const c = { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 };
    return { ms: zonedToUtcMs(c, DEFAULT_TZ), dateOnly: true };
  }
  const t = Date.parse(v);
  if (Number.isFinite(t)) return { ms: t, dateOnly: false };
  return null;
}

function parseDur(s) {
  // PnDTnHnMnS (weeks/days/time subset is enough for calendar DURATION)
  const m = String(s).match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  return (((+m[1] || 0) * 7 + (+m[2] || 0)) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000;
}

function parseRrule(s) {
  const o = {};
  for (const kv of String(s).split(';')) {
    const e = kv.indexOf('=');
    if (e > 0) o[kv.slice(0, e)] = kv.slice(e + 1);
  }
  return o;
}

function parseIcs(text) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { rrule: null }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) events.push(cur);
      cur = null; continue;
    }
    if (!cur) continue;
    const p = parseProp(line);
    if (!p) continue;
    if (p.name === 'DTSTART') {
      const d = parseDt(p.value, p.params);
      if (d) { cur.start = d.ms; cur.allDay = d.dateOnly; }
    }
    else if (p.name === 'DTEND') { const d = parseDt(p.value, p.params); if (d) cur.end = d.ms; }
    else if (p.name === 'DURATION' && cur.end == null) { const ms = parseDur(p.value); if (ms != null) cur.durMs = ms; }
    else if (p.name === 'SUMMARY') cur.summary = p.value.replace(/\\(.)/g, '$1');
    else if (p.name === 'LOCATION') cur.location = p.value.replace(/\\(.)/g, '$1');
    else if (p.name === 'RRULE') cur.rrule = parseRrule(p.value);
  }
  // normalize end times
  for (const e of events) {
    if (e.end == null) e.end = e.start + (e.durMs != null ? e.durMs : (e.allDay ? 86400000 : 3600000));
    delete e.durMs;
  }
  return events;
}

function expand(events, now, windowDays = 60) {
  const out = [];
  const horizon = now + windowDays * 86400000;
  for (const e of events) {
    out.push(e);
    const r = e.rrule;
    if (!r || (r.FREQ !== 'DAILY' && r.FREQ !== 'WEEKLY')) continue;
    const step = (r.FREQ === 'WEEKLY' ? 7 : 1) * (Math.max(1, parseInt(r.INTERVAL || '1', 10))) * 86400000;
    const until = r.UNTIL ? (parseDt(r.UNTIL, {} ) || {}).ms : null;
    const maxCount = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    const len = e.end - e.start;
    let n = 1, t = e.start + step;
    while (t < horizon && n < maxCount && n < 500 && (until == null || t <= until)) {
      out.push({ ...e, start: t, end: t + len });
      t += step; n++;
    }
  }
  return out;
}

function toItem(e, now) {
  return {
    summary: e.summary || '(no title)',
    location: e.location || null,
    startMs: e.start, endMs: e.end,
    ongoing: e.start <= now && now < e.end,
    allDay: !!e.allDay
  };
}

function findNext(events, now = Date.now()) {
  const occ = expand(events, now);
  let ongoing = null, upcoming = null;
  for (const e of occ) {
    if (e.start <= now && now < e.end) {
      if (!ongoing || e.start > ongoing.start) ongoing = e;
    } else if (e.start > now) {
      if (!upcoming || e.start < upcoming.start) upcoming = e;
    }
  }
  const pick = ongoing || upcoming;
  if (!pick) return null;
  return toItem(pick, now);
}

// All occurrences in the next `days` days (sorted, capped) for day timelines.
function upcoming(events, now = Date.now(), days = 14, cap = 100) {
  const horizon = now + days * 86400000;
  return expand(events, now)
    .filter(e => e.end > now - 86400000 && e.start < horizon) // keep last 24h so "today" stays complete
    .sort((a, b) => a.start - b.start)
    .slice(0, cap)
    .map(e => toItem(e, now));
}

module.exports = { fetchIcs, parseIcs, expand, findNext, upcoming, DEFAULT_TZ };
