// Kiosk: 12h clock, SSE live updates, stale handling. Display only (no interaction).
const $ = id => document.getElementById(id);

// Dashboard clock = real time + server offset (set from /admin). 0 = real time.
let clockOffsetSec = 0;
function dashboardNow() { return new Date(DashboardTime.now() + clockOffsetSec * 1000); }

function tickClock() {
  const ms = dashboardNow().getTime();
  $('clock').textContent = DashboardTime.time(ms, true);
  $('date').textContent = DashboardTime.date(ms);
}
setInterval(tickClock, 1000); tickClock();

/* ---------- PC + storage ---------- */
let lastPC = null;
function renderPC(pc) {
  lastPC = pc || {};
  pc = lastPC;
  setBar('cpu', pc.cpu); setBar('gpu', pc.gpu); setBar('ram', pc.ram);
  const temps = [];
  if (pc.cpuTemp != null) temps.push(`CPU ${pc.cpuTemp}°C`);
  if (pc.gpuTemp != null) temps.push(`GPU ${pc.gpuTemp}°C`);
  $('temps').textContent = temps.join(' · ') || '—';
  renderDisks(pc.disks);
  tickPC();
}
function tickPC() {
  const pc = lastPC || {};
  const age = pc.updatedAt ? Math.max(0, Math.floor((DashboardTime.now() - pc.updatedAt) / 1000)) : null;
  const pill = $('pc-state');
  pill.textContent = age == null ? 'PC NO SAMPLE' : age < 10 ? 'PC ONLINE' : 'PC STALE';
  pill.className = 'pill ' + (age != null && age < 10 ? 'ok' : 'bad');
  $('pc-card').classList.toggle('stale', age == null || age >= 10);
  $('pc-age').textContent = age == null ? 'Agent not connected yet' : age <= 2 ? 'Updated just now' : `Last sample ${age}s ago`;
}
setInterval(tickPC, 1000);
function setBar(k, v) {
  const available = typeof v === 'number' && Number.isFinite(v);
  $(k + '-v').textContent = available ? Math.round(v) + '%' : '— unavailable';
  $(k + '-b').style.width = available ? Math.max(0, Math.min(100, v)) + '%' : '0%';
}
function renderDisks(disks) {
  const box = $('disks');
  if (!Array.isArray(disks) || !disks.length) { box.innerHTML = '<div class="dim sub">Waiting for agent…</div>'; return; }
  box.innerHTML = '';
  disks.slice(0, 6).forEach(d => {
    const pct = Math.max(0, Math.min(100, Number(d.pct) || 0));
    const row = document.createElement('div');
    row.className = 'disk' + (pct >= 80 ? ' full' : '');
    const label = document.createElement('div');
    label.className = 'disk-label';
    label.innerHTML = `<span>${escapeHtml(String(d.mount || d.disk || 'Disk'))}</span><b>${Math.round(pct)}%</b>`;
    const bar = document.createElement('div');
    bar.className = 'bar small';
    const fill = document.createElement('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    row.append(label, bar);
    const total = d.totalGb != null ? ` of ${d.totalGb} GB` : '';
    const f = document.createElement('div');
    f.className = 'disk-free dim';
    f.textContent = `${d.freeGb != null ? d.freeGb : '—'} GB free${total}`;
    row.appendChild(f);
    box.appendChild(row);
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- To-do ---------- */
function renderTodos(list) {
  const ul = $('todos'); ul.innerHTML = '';
  const vis = (list || []).filter(t => !t.done).slice(0, 5);
  const done = (list || []).filter(t => t.done).length;
  const hidden = (list || []).filter(t => !t.done).length - vis.length;
  if (!vis.length) ul.innerHTML = '<li class="empty-msg dim">You have nothing to do, sir</li>';
  vis.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="chk"></span><span></span>`;
    li.lastChild.textContent = t.text;
    ul.appendChild(li);
  });
  if (hidden > 0) { const li = document.createElement('li'); li.className = 'dim sub'; li.textContent = `+ ${hidden} more tasks in /admin`; ul.appendChild(li); }
  if (done) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = `+ ${done} done`; ul.appendChild(li); }
}

/* ---------- Timers (multiple, named) ---------- */
let timers = [];
function normalizeTimers(t) {
  if (Array.isArray(t)) return t;
  // legacy { long, short } object -> array
  const arr = [];
  if (t && t.long && t.long.targetAt) arr.push({ id: 'long', name: t.long.label || 'Long term', type: 'long', targetAt: t.long.targetAt, createdAt: t.long.createdAt, done: false });
  if (t && t.short && (t.short.endsAt || t.short.pausedLeftSec != null)) {
    arr.push({ id: 'short', name: t.short.label || 'Focus', type: 'short', targetAt: t.short.endsAt || null, pausedLeftSec: t.short.endsAt ? null : t.short.pausedLeftSec, done: false });
  }
  return arr;
}
function renderTimers(t) {
  timers = [...normalizeTimers(t)].sort((a, b) => Number(a.done) - Number(b.done) || (a.targetAt || Infinity) - (b.targetAt || Infinity));
  const box = $('timers');
  box.innerHTML = '';
  if (!timers.length) { box.innerHTML = '<div class="dim">No timers — add from /admin</div>'; return; }
  timers.forEach(tm => {
    const card = document.createElement('div');
    card.className = 'timer' + (tm.done ? ' done' : '') + (tm.type === 'short' ? ' short' : '');
    card.id = 'timer-' + tm.id;
    if (/^#[0-9a-fA-F]{6}$/.test(tm.color || '')) card.style.setProperty('--tc', tm.color);
    card.innerHTML = `
      <div class="timer-head"><span class="chk ${tm.done ? 'on' : ''}">${tm.done ? '✓' : ''}</span><span class="timer-name"></span><span class="timer-badge"></span></div>
      <div class="timer-left">–</div>
      <div class="bar big"><i></i></div>`;
    card.querySelector('.timer-name').textContent = tm.name;
    box.appendChild(card);
  });
  tickTimers();
}
function tickTimers() {
  if (!timers) return;
  const now = DashboardTime.now();
  timers.forEach(tm => {
    const card = document.getElementById('timer-' + tm.id);
    if (!card) return;
    const leftEl = card.querySelector('.timer-left');
    const fill = card.querySelector('.bar i');
    const badge = card.querySelector('.timer-badge');
    if (tm.done) {
      leftEl.textContent = '✓ DONE';
      fill.style.width = '100%';
      badge.textContent = '';
      return;
    }
    let leftMs = null, paused = false;
    if (tm.targetAt) leftMs = tm.targetAt - now;
    else if (tm.pausedLeftSec != null) { leftMs = tm.pausedLeftSec * 1000; paused = true; }
    if (leftMs == null) { leftEl.textContent = '--:--'; fill.style.width = '0%'; badge.textContent = ''; return; }
    if (leftMs <= 0 && !paused) {
      card.classList.add('fired');
      leftEl.textContent = tm.type === 'long' ? '🎉 DONE' : '⏰ TIME UP';
      fill.style.width = '100%';
      badge.textContent = '';
      return;
    }
    card.classList.remove('fired');
    badge.textContent = paused ? 'paused' : (tm.type === 'long' ? 'days left' : 'left');
    if (tm.type === 'long') {
      leftEl.textContent = fmtLong(leftMs);
      const total = tm.targetAt - (tm.createdAt || now - 1);
      fill.style.width = Math.min(100, Math.max(0, 100 * (1 - leftMs / total))) + '%';
    } else {
      const sec = Math.round(leftMs / 1000);
      leftEl.textContent = fmt(sec);
      if (tm.durationSec) fill.style.width = Math.min(100, Math.max(0, 100 * (sec / tm.durationSec))) + '%';
      else fill.style.width = '100%';
    }
  });
}
function fmtLong(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms % 86400000 / 3600000);
  const m = Math.floor(ms % 3600000 / 60000);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
setInterval(tickTimers, 1000);

let lastWeather = null;
function renderWeather(w) {
  lastWeather = w;
  if (!w || w.temp == null) { $('weather').textContent = 'Weather unavailable'; return; }
  const stale = DashboardTime.stale(w, 30 * 60000);
  $('weather').textContent = `${w.icon ? w.icon + ' ' : ''}${w.temp}°C ${w.label || ''}${w.error ? ' · refresh failed' : stale ? ' · stale' : ''}`;
  $('weather').classList.toggle('data-warning', !!w.error || stale);
}
setInterval(() => { if (lastWeather) renderWeather(lastWeather); }, 1000);

function renderTime(t) {
  if (!t) return;
  clockOffsetSec = Number(t.offsetSec) || 0;
  tickClock();
}

/* ---------- Today: vertical timeline ---------- */
let lastCal = null;
function renderEvent(cal) {
  lastCal = cal || null;
  const el = $('event');
  el.innerHTML = '';
  if (!cal || !cal.configured) {
    el.innerHTML = '<span class="dim">Connect calendar in /admin</span>';
    return;
  }
  const now = DashboardTime.now();
  const stale = DashboardTime.stale(cal, 20 * 60000);
  if (cal.error || stale) {
    const warning = document.createElement('div'); warning.className = 'data-warning sub';
    warning.textContent = cal.error ? 'Calendar refresh failed · cached events may be stale' : 'Calendar data stale · refreshing';
    el.appendChild(warning);
  }
  const list = (cal.upcoming || [])
    .filter(e => DashboardTime.today(e, now))
    .sort((a, b) => Number(a.endMs <= now) - Number(b.endMs <= now) || a.startMs - b.startMs);

  // all-day chips first
  const allDay = list.filter(e => e.allDay);
  const timed = list.filter(e => !e.allDay);
  if (allDay.length) {
    const row = document.createElement('div');
    row.className = 'tl-allday';
    allDay.forEach(e => {
      const c = document.createElement('span');
      c.className = 'tl-chip';
      c.textContent = '🗓 ' + e.summary;
      row.appendChild(c);
    });
    el.appendChild(row);
  }
  if (!timed.length && !allDay.length) {
    el.innerHTML += cal.error
      ? '<span class="dim">Calendar error — retrying…</span>'
      : '<span class="empty-msg dim">You have nothing to do, sir</span>';
    return;
  }
  const rail = document.createElement('div');
  rail.className = 'tl';
  let firstFuture = null;
  timed.forEach(e => {
    const past = e.endMs <= now, live = e.startMs <= now && now < e.endMs;
    const item = document.createElement('div');
    item.className = 'tl-item' + (past ? ' past' : '') + (live ? ' live' : '');
    const s = new Date(e.startMs);
    const en = new Date(e.endMs);
    const t = document.createElement('div');
    t.className = 'tl-time';
    t.textContent = fmtTime(s) + ' – ' + fmtTime(en);
    const body = document.createElement('div');
    body.className = 'tl-body';
    const title = document.createElement('div');
    title.className = 'tl-title';
    title.textContent = e.summary;
    const meta = document.createElement('div');
    meta.className = 'tl-meta';
    meta.textContent = (live ? 'now' : past ? 'done' : relTime(e.startMs, false)) + (e.location ? ' · ' + e.location : '');
    body.append(title, meta);
    item.append(t, body);
    rail.appendChild(item);
    if (!past && !live && !firstFuture) firstFuture = item;
  });
  // "now" marker between done/live and what's next
  if (firstFuture && firstFuture !== rail.firstChild) {
    const m = document.createElement('div');
    m.className = 'tl-now';
    m.innerHTML = '<span class="tl-now-dot"></span><span class="tl-now-line"></span><span class="tl-now-txt">now</span>';
    rail.insertBefore(m, firstFuture);
  }
  el.appendChild(rail);
}
function fmtTime(d) { return DashboardTime.time(d.getTime()); }
function relTime(startMs, ongoing) {
  if (ongoing) return 'now';
  const s = Math.max(0, Math.round((startMs - DashboardTime.now()) / 1000));
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return m ? `in ${h}h ${m}m` : `in ${h}h`; }
  return `in ${Math.round(s / 86400)}d`;
}

function applySnapshot(j) {
  DashboardTime.sync(j.now);
  DashboardTime.setZone(j.timeZone);
  renderPC(j.pc); renderTodos(j.todos); renderTimers(j.timers); renderWeather(j.weather); renderTime(j.time); renderEvent(j.calendar);
}
function serverState(connected) {
  $('server-state').textContent = connected ? 'Server connected' : 'Server reconnecting…';
  $('server-state').className = 'pill ' + (connected ? 'ok' : 'bad');
}
async function boot() {
  try {
    const r = await fetch('/api/snapshot');
    if (!r.ok) throw new Error('Snapshot failed');
    applySnapshot(await r.json());
  } catch { serverState(false); }
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => serverState(true));
  es.addEventListener('error', () => serverState(false));
  es.addEventListener('snapshot', e => { try { applySnapshot(JSON.parse(e.data)); serverState(true); } catch { serverState(false); } });
  for (const [name, render] of Object.entries({ pc: renderPC, todos: renderTodos, timers: renderTimers, weather: renderWeather, time: renderTime, calendar: renderEvent })) {
    es.addEventListener(name, e => { try { render(JSON.parse(e.data)); } catch {} });
  }
  setInterval(() => { if (lastCal) renderEvent(lastCal); }, 30000);
}
boot();
