// Kiosk: 12h clock, SSE live updates, stale handling. Display only (no interaction).
const $ = id => document.getElementById(id);

// Dashboard clock = real time + server offset (set from /admin). 0 = real time.
let clockOffsetSec = 0;
function dashboardNow() { return new Date(Date.now() + clockOffsetSec * 1000); }

function tickClock() {
  const d = dashboardNow();
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  $('clock').textContent = `${h}:${m}:${s} ${ap}`;
  // day-month-year: 12-1-2026
  $('date').textContent = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
}
setInterval(tickClock, 1000); tickClock();

/* ---------- PC + storage ---------- */
function renderPC(pc) {
  pc = pc || {};
  setBar('cpu', pc.cpu); setBar('gpu', pc.gpu); setBar('ram', pc.ram);
  const temps = [];
  if (pc.cpuTemp != null) temps.push(`CPU ${pc.cpuTemp}°C`);
  if (pc.gpuTemp != null) temps.push(`GPU ${pc.gpuTemp}°C`);
  $('temps').textContent = temps.join(' · ') || '—';
  renderDisks(pc.disks);
  // age can read negative when tablet/server clocks differ -> clamp
  const age = pc.updatedAt ? Math.max(0, Math.round((Date.now() - pc.updatedAt) / 1000)) : 999;
  const pill = $('pc-state');
  if (age < 10) { pill.textContent = 'PC ONLINE'; pill.className = 'pill ok'; }
  else { pill.textContent = 'PC OFFLINE'; pill.className = 'pill bad'; }
  $('pc-age').textContent = pc.updatedAt ? (age <= 2 ? 'updated just now' : `updated ${age}s ago`) : 'agent not connected yet';
}
function setBar(k, v) {
  v = Math.max(0, Math.min(100, Number(v) || 0));
  $(k + '-v').textContent = Math.round(v) + '%';
  $(k + '-b').style.width = v + '%';
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
    const free = d.freeGb != null ? ` · ${d.freeGb} GB free` : '';
    label.innerHTML = `<span>${escapeHtml(String(d.mount || d.disk || 'Disk'))}</span><b>${Math.round(pct)}%</b>`;
    const bar = document.createElement('div');
    bar.className = 'bar small';
    const fill = document.createElement('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    row.append(label, bar);
    if (free) { const f = document.createElement('div'); f.className = 'disk-free dim'; f.textContent = free.trim().replace(/^· /, ''); row.appendChild(f); }
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
  if (!vis.length) ul.innerHTML = '<li class="dim">All clear ✓</li>';
  vis.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="chk"></span><span></span>`;
    li.lastChild.textContent = t.text;
    ul.appendChild(li);
  });
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
  timers = normalizeTimers(t);
  const box = $('timers');
  box.innerHTML = '';
  if (!timers.length) { box.innerHTML = '<div class="dim">No timers — add from /admin</div>'; return; }
  timers.forEach(tm => {
    const card = document.createElement('div');
    card.className = 'timer' + (tm.done ? ' done' : '') + (tm.type === 'short' ? ' short' : '');
    card.id = 'timer-' + tm.id;
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
  const now = Date.now();
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

function renderWeather(w) {
  if (!w || w.temp == null) { $('weather').textContent = '—'; return; }
  $('weather').textContent = `${w.temp}°C ${w.label || ''}`;
}

function renderTime(t) {
  if (!t) return;
  clockOffsetSec = Number(t.offsetSec) || 0;
  tickClock();
}

/* ---------- Next calendar event ---------- */
let lastCal = null;
function renderEvent(cal) {
  lastCal = cal || null;
  const el = $('event');
  if (!cal || !cal.configured) { el.innerHTML = '<span class="dim">Connect calendar in /admin</span>'; return; }
  const n = cal.next;
  if (!n) {
    el.innerHTML = cal.error
      ? '<span class="dim">Calendar error — retrying…</span>'
      : 'No upcoming events';
    return;
  }
  // wall-clock display follows the dashboard offset; countdowns stay real-time
  const d = new Date(n.startMs + clockOffsetSec * 1000);
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const today = dashboardNow();
  const sameDay = d.getDate() === today.getDate() && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
  const when = sameDay ? `${h}:${m} ${ap}` : `${h}:${m} ${ap} · ${d.getDate()}-${d.getMonth() + 1}`;
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'event-title' + (n.ongoing ? ' live' : '');
  title.textContent = (n.ongoing ? '● ' : '') + n.summary;
  const sub = document.createElement('div');
  sub.className = 'event-sub';
  sub.textContent = `${relTime(n.startMs, n.ongoing)} · ${when}` + (n.location ? ` · ${n.location}` : '');
  el.append(title, sub);
}
function relTime(startMs, ongoing) {
  if (ongoing) return 'now';
  const s = Math.max(0, Math.round((startMs - Date.now()) / 1000));
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return m ? `in ${h}h ${m}m` : `in ${h}h`; }
  return `in ${Math.round(s / 86400)}d`;
}

async function boot() {
  try {
    const j = await (await fetch('/api/snapshot')).json();
    renderPC(j.pc); renderTodos(j.todos); renderTimers(j.timers); renderWeather(j.weather); renderTime(j.time); renderEvent(j.calendar);
  } catch {}
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', e => {
    try { const j = JSON.parse(e.data); renderPC(j.pc); renderTodos(j.todos); renderTimers(j.timers); renderWeather(j.weather); renderTime(j.time); renderEvent(j.calendar); } catch {}
  });
  es.addEventListener('pc', e => { try { renderPC(JSON.parse(e.data)); } catch {} });
  es.addEventListener('todos', e => { try { renderTodos(JSON.parse(e.data)); } catch {} });
  es.addEventListener('timers', e => { try { renderTimers(JSON.parse(e.data)); } catch {} });
  es.addEventListener('weather', e => { try { renderWeather(JSON.parse(e.data)); } catch {} });
  es.addEventListener('time', e => { try { renderTime(JSON.parse(e.data)); } catch {} });
  es.addEventListener('calendar', e => { try { renderEvent(JSON.parse(e.data)); } catch {} });
  setInterval(async () => {
    try { renderWeather(await (await fetch('/api/weather')).json()); } catch {}
  }, 60000);
  setInterval(() => { if (lastCal) renderEvent(lastCal); }, 30000); // refresh "in Xm" countdowns
}
boot();
