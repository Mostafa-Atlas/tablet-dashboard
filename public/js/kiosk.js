// Kiosk: 12h clock, SSE live updates, stale handling, and local alarm controls.
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
  $('date').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
setInterval(tickClock, 1000); tickClock();

/* ---------- PC + storage ---------- */
let lastPC = null;
let serverClockOffsetMs = 0;
function renderPC(pc) {
  pc = pc || {};
  lastPC = pc;
  setBar('cpu', pc.updatedAt ? pc.cpu : null);
  setBar('gpu', pc.updatedAt ? pc.gpu : null);
  setBar('ram', pc.updatedAt ? pc.ram : null);
  const temps = [];
  if (pc.cpuTemp != null) temps.push(`CPU ${pc.cpuTemp}°C`);
  if (pc.gpuTemp != null) temps.push(`GPU ${pc.gpuTemp}°C`);
  $('temps').textContent = temps.join(' · ') || '—';
  renderDisks(pc.disks);
  refreshPCStatus();
}
function refreshPCStatus() {
  const pc = lastPC || {};
  // age can read negative when tablet/server clocks differ -> clamp
  const age = pc.updatedAt ? Math.max(0, Math.round((Date.now() + serverClockOffsetMs - pc.updatedAt) / 1000)) : 999;
  const pill = $('pc-state');
  if (age < 10) { pill.textContent = 'PC ONLINE'; pill.className = 'pill ok'; }
  else { pill.textContent = 'PC OFFLINE'; pill.className = 'pill bad'; }
  $('pc-age').textContent = pc.updatedAt ? (age <= 2 ? 'updated just now' : `updated ${age}s ago`) : 'agent not connected yet';
  syncLayout();
}
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const numAnim = {};
function tweenNumber(k, target) {
  const el = $(k + '-v');
  if (numAnim[k]) cancelAnimationFrame(numAnim[k]);
  if (reduceMotion) { el.textContent = Math.round(target) + '%'; return; }
  const from = parseFloat(el.textContent) || 0;
  if (from === Math.round(target)) { el.textContent = Math.round(target) + '%'; return; }
  const start = performance.now(), dur = 600;
  const step = now => {
    const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (target - from) * e) + '%';
    if (t < 1) numAnim[k] = requestAnimationFrame(step);
    else delete numAnim[k];
  };
  numAnim[k] = requestAnimationFrame(step);
}
function setBar(k, v) {
  if (v == null) {
    if (numAnim[k]) { cancelAnimationFrame(numAnim[k]); delete numAnim[k]; }
    $(k + '-v').textContent = '—';
    $(k + '-b').style.width = '0%';
    return;
  }
  v = Math.max(0, Math.min(100, Number(v) || 0));
  tweenNumber(k, v);
  $(k + '-b').style.width = v + '%';
}
function diskVals(d) {
  const pct = Math.max(0, Math.min(100, Number(d.pct) || 0));
  const total = d.totalGb != null ? ` of ${d.totalGb} GB` : '';
  return { mount: String(d.mount || d.disk || 'Disk'), pct,
    pctTxt: Math.round(pct) + '%',
    freeTxt: `${d.freeGb != null ? d.freeGb : '—'} GB free${total}` };
}
function renderDisks(disks) {
  const box = $('disks');
  if (!Array.isArray(disks) || !disks.length) { box.innerHTML = '<div class="dim sub">Waiting for agent…</div>'; return; }
  const list = disks.slice(0, 6).map(diskVals);
  const rows = [...box.children].filter(el => el.classList?.contains('disk'));
  if (rows.length === list.length && rows.every((row, i) => row.dataset.mount === list[i].mount)) {
    // same drives: update in place so bars glide instead of rebuilding
    rows.forEach((row, i) => {
      row.classList.toggle('full', list[i].pct >= 80);
      row.querySelector('.disk-label b').textContent = list[i].pctTxt;
      row.querySelector('.bar i').style.width = list[i].pct + '%';
      row.querySelector('.disk-free').textContent = list[i].freeTxt;
    });
    return;
  }
  box.innerHTML = '';
  list.forEach(v => {
    const row = document.createElement('div');
    row.className = 'disk' + (v.pct >= 80 ? ' full' : '');
    row.dataset.mount = v.mount;
    const label = document.createElement('div');
    label.className = 'disk-label';
    label.innerHTML = `<span></span><b></b>`;
    label.firstChild.textContent = v.mount;
    label.querySelector('b').textContent = v.pctTxt;
    const bar = document.createElement('div');
    bar.className = 'bar small';
    const fill = document.createElement('i');
    fill.style.width = v.pct + '%';
    bar.appendChild(fill);
    row.append(label, bar);
    const f = document.createElement('div');
    f.className = 'disk-free dim';
    f.textContent = v.freeTxt;
    row.appendChild(f);
    box.appendChild(row);
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- To-do ---------- */
let lastTodos = [];
function renderTodos(list) {
  lastTodos = list || [];
  const ul = $('todos'); ul.innerHTML = '';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const missed = lastTodos.filter(t => !t.done && (!t.repeat || t.repeat === 'none') && t.dueAt && t.dueAt < todayStart).length;
  $('missed-summary').hidden = !missed;
  $('missed-summary').textContent = `${missed} older ${missed === 1 ? 'task needs' : 'tasks need'} a new time in admin`;
  const vis = lastTodos.filter(t => !t.done && (display.showCalendar === false || !t.dueAt || t.dueAt >= todayEnd)).sort((a, b) => {
    const rank = { high: 0, normal: 1, low: 2 };
    return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || (a.dueAt || Infinity) - (b.dueAt || Infinity);
  }).slice(0, 5);
  const done = (list || []).filter(t => t.done).length;
  if (!vis.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-msg dim';
    empty.textContent = display.emptyMsg || 'You have nothing to do now, sir';
    ul.appendChild(empty);
  }
  vis.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="chk"></span><span></span>`;
    const label = li.lastChild;
    label.textContent = t.text;
    if (t.priority === 'high') li.classList.add('high-priority');
    if (t.dueAt || (t.priority && t.priority !== 'normal')) {
      const time = document.createElement('small'); time.className = 'todo-due';
      const priority = t.priority && t.priority !== 'normal' ? t.priority[0].toUpperCase() + t.priority.slice(1) : '';
      const due = t.dueAt ? (t.dueAt <= Date.now() ? 'Overdue' : relTime(t.dueAt, false)) : '';
      time.textContent = [priority, due].filter(Boolean).join(' · ');
      label.appendChild(time);
    }
    ul.appendChild(li);
  });
  if (done) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = `+ ${done} done`; ul.appendChild(li); }
  if (lastCal) renderEvent(lastCal);
  renderNext();
  updateAlarms();
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
  if (!timers.length) { syncLayout(); renderNext(); return; }
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
  syncLayout();
  updateAlarms();
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
      card.classList.toggle('fired', now - tm.targetAt < 30000);
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
setInterval(() => { tickTimers(); updateAlarms(); }, 1000);

function weatherSymbol(w) {
  const code = Number(w.code);
  const phase = w.isDay === false ? 'night' : 'day';
  if (code === 0) return `clear-${phase}`;
  if (code === 1 || code === 2) return `partly-${phase}`;
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return 'cloudy';
}
function renderWeather(w) {
  if (!w || w.temp == null) {
    $('weather-icon').setAttribute('hidden', '');
    $('weather-text').textContent = 'Weather unavailable';
    $('weather-extra').hidden = true;
    return;
  }
  const stale = Date.now() + serverClockOffsetMs - (w.updatedAt || 0) > 90 * 60 * 1000;
  $('weather-icon-use').setAttribute('href', `/icons/weather.svg#${weatherSymbol(w)}`);
  $('weather-icon').removeAttribute('hidden');
  $('weather-text').textContent = `${w.temp}°C ${w.label || 'Weather'}${stale ? ' · stale' : ''}`;
  const details = [];
  if (Number.isFinite(w.high)) details.push(`High ${w.high}°`);
  if (Number.isFinite(w.low)) details.push(`Low ${w.low}°`);
  if (Number.isFinite(w.rainChance)) details.push(`Rain up to ${w.rainChance}%`);
  $('weather-extra').textContent = details.join(' · ');
  $('weather-extra').hidden = !details.length;
}

function renderTime(t) {
  if (!t) return;
  clockOffsetSec = Number(t.offsetSec) || 0;
  tickClock();
}

/* ---------- Now playing (Windows SMTC via agent) ---------- */
let lastMedia = null;
function renderMedia(m) {
  lastMedia = m || null;
  const has = !!(m && m.playing && m.title);
  $('media-card').hidden = !has;
  if (!has) { syncLayout(); return; }
  $('media-title').textContent = m.title;
  $('media-artist').textContent = [m.artist, m.album].filter(Boolean).join(' · ');
  $('media-app').textContent = m.app ? '▶ ' + m.app : '▶ Playing';
  const art = $('media-art');
  if (m.thumb) { art.src = m.thumb; art.hidden = false; }
  else art.hidden = true;
  syncLayout();
}

/* ---------- Today: vertical timeline ---------- */
let lastCal = null;
function renderEvent(cal) {
  lastCal = cal || null;
  const el = $('event');
  el.innerHTML = '';
  const now = Date.now();
  const dn = new Date();
  const dayStart = new Date(dn.getFullYear(), dn.getMonth(), dn.getDate()).getTime();
  const dayEnd = new Date(dn.getFullYear(), dn.getMonth(), dn.getDate() + 1).getTime();
  const list = (cal?.upcoming || [])
    .filter(e => e.startMs < dayEnd && e.endMs > dayStart)
    .sort((a, b) => a.startMs - b.startMs);

  // all-day chips first
  const allDay = list.filter(e => e.allDay);
  const timed = list.filter(e => !e.allDay).map(e => ({ ...e, kind: 'event' }));
  const dueTasks = lastTodos.filter(t => !t.done && t.dueAt && t.dueAt >= dayStart && t.dueAt < dayEnd)
    .map(t => ({ kind: 'task', startMs: t.dueAt, endMs: t.dueAt, summary: t.text, priority: t.priority || 'normal' }));
  timed.push(...dueTasks);
  timed.sort((a, b) => a.startMs - b.startMs || (a.kind === 'task' ? -1 : 1));
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
    el.innerHTML += cal?.error
      ? '<span class="dim">Calendar error — retrying…</span>'
      : '<span class="empty-msg dim">No events or due tasks today</span>';
    renderNext();
    return;
  }
  const rail = document.createElement('div');
  rail.className = 'tl';
  let firstFuture = null;
  timed.forEach(e => {
    const task = e.kind === 'task';
    const past = !task && e.endMs <= now, live = !task && e.startMs <= now && now < e.endMs;
    const overdue = task && e.startMs <= now;
    const item = document.createElement('div');
    item.className = 'tl-item' + (past ? ' past' : '') + (live ? ' live' : '') + (overdue ? ' overdue' : '') + (task ? ' task' : '');
    const s = new Date(e.startMs);
    const en = new Date(e.endMs);
    const t = document.createElement('div');
    t.className = 'tl-time';
    t.textContent = task ? fmtTime(s) + ' · TASK' : fmtTime(s) + ' – ' + fmtTime(en);
    const body = document.createElement('div');
    body.className = 'tl-body';
    const title = document.createElement('div');
    title.className = 'tl-title';
    title.textContent = e.summary;
    const meta = document.createElement('div');
    meta.className = 'tl-meta';
    meta.textContent = task
      ? `${(e.priority || 'normal').toUpperCase()} priority · ${overdue ? 'Due now' : relTime(e.startMs, false)}`
      : (live ? 'now' : past ? 'done' : relTime(e.startMs, false)) + (e.location ? ' · ' + e.location : '');
    body.append(title, meta);
    item.append(t, body);
    rail.appendChild(item);
    if (e.startMs > now && !firstFuture) firstFuture = item;
  });
  // "now" marker between done/live and what's next
  if (firstFuture && firstFuture !== rail.firstChild) {
    const m = document.createElement('div');
    m.className = 'tl-now';
    m.innerHTML = '<span class="tl-now-dot"></span><span class="tl-now-line"></span><span class="tl-now-txt">now</span>';
    rail.insertBefore(m, firstFuture);
  }
  el.appendChild(rail);
  renderNext();
}
let nextDismissedAt = 0, nextDismissedKey = '';
$('next-close').onclick = () => { nextDismissedAt = Date.now(); $('next-card').hidden = true; };
function renderNext() {
  const now = Date.now();
  const future = [];
  if (display.showTodos !== false) lastTodos.filter(t => !t.done && t.dueAt > now)
    .forEach(t => future.push({ at: t.dueAt, name: t.text, kind: 'Task', priority: t.priority || 'normal' }));
  if (display.showCalendar !== false) (lastCal?.upcoming || []).filter(e => !e.allDay && e.startMs > now)
    .forEach(e => future.push({ at: e.startMs, name: e.summary, kind: 'Calendar' }));
  future.sort((a, b) => a.at - b.at || Number(b.priority === 'high') - Number(a.priority === 'high'));
  const next = future[0];
  const key = next ? `${next.kind}:${next.name}:${next.at}` : '';
  if (key !== nextDismissedKey) { nextDismissedKey = key; nextDismissedAt = 0; }
  if (nextDismissedAt && now - nextDismissedAt < 3600000) { $('next-card').hidden = true; return; }
  $('next-card').hidden = !next || next.at - now > 7 * 86400000;
  if ($('next-card').hidden) return;
  const at = new Date(next.at), today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const day = at.toDateString() === today.toDateString() ? 'Today'
    : at.toDateString() === tomorrow.toDateString() ? 'Tomorrow'
      : at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  $('next-title').textContent = next.name;
  $('next-countdown').textContent = relTime(next.at, false);
  $('next-detail').textContent = `${next.kind}${next.priority === 'high' ? ' · High priority' : ''} · ${day} ${fmtTime(at)}`;
}
setInterval(renderNext, 30000);
let renderedDay = new Date().toDateString();
setInterval(() => {
  const day = new Date().toDateString();
  if (day !== renderedDay) { renderedDay = day; renderTodos(lastTodos); }
}, 60000);
function fmtTime(d) {
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}
function relTime(startMs, ongoing) {
  if (ongoing) return 'now';
  const s = Math.max(0, Math.round((startMs - Date.now()) / 1000));
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return m ? `in ${h}h ${m}m` : `in ${h}h`; }
  return `in ${Math.round(s / 86400)}d`;
}

/* ---------- Note, routines, and reminders ---------- */
function renderNote(note) {
  const value = note?.text || '';
  $('note-section').hidden = !value;
  $('pinned-note').textContent = value;
}
function renderRoutines(routines) {
  const box = $('routines'); box.replaceChildren();
  $('routine-section').hidden = !routines?.length;
  (routines || []).forEach(routine => {
    const card = document.createElement('div'); card.className = 'routine-card';
    const done = routine.items.filter(i => i.done).length;
    const heading = document.createElement('div'); heading.className = 'routine-heading';
    const name = document.createElement('strong'); name.textContent = routine.name;
    const count = document.createElement('span'); count.textContent = `${done}/${routine.items.length}`;
    heading.append(name, count); card.appendChild(heading);
    const progress = document.createElement('div'); progress.className = 'bar small';
    const fill = document.createElement('i'); fill.style.width = routine.items.length ? `${done / routine.items.length * 100}%` : '0%';
    progress.appendChild(fill); card.appendChild(progress);
    const list = document.createElement('ul'); list.className = 'routine-steps';
    routine.items.forEach(item => {
      const li = document.createElement('li'); if (item.done) li.className = 'done';
      const check = document.createElement('span'); check.className = `chk${item.done ? ' on' : ''}`; check.textContent = item.done ? '✓' : '';
      const label = document.createElement('span'); label.textContent = item.text;
      li.append(check, label); list.appendChild(li);
    });
    card.appendChild(list); box.appendChild(card);
  });
  syncLayout();
}
let soundContext = null, fallbackLoop = null, soundAttempt = 0, customSoundFailed = false;
async function customSoundReady() {
  try {
    const response = await within(fetch('/audio/alarm.mp3', { method: 'HEAD', cache: 'no-store' }), 5000);
    return response.ok;
  } catch { return false; }
}
let currentAlarm = null;
const alarmMemory = (() => { try { return JSON.parse(localStorage.getItem('dashboard-alarms') || '{}'); } catch { return {}; } })();
function saveAlarmMemory() { try { localStorage.setItem('dashboard-alarms', JSON.stringify(alarmMemory)); } catch {} }
function chime() {
  if (!soundContext || soundContext.state !== 'running') return;
  const oscillator = soundContext.createOscillator(), gain = soundContext.createGain();
  oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(880, soundContext.currentTime);
  oscillator.frequency.setValueAtTime(660, soundContext.currentTime + 0.2);
  gain.gain.setValueAtTime(0.12, soundContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, soundContext.currentTime + 0.5);
  oscillator.connect(gain).connect(soundContext.destination);
  oscillator.start(); oscillator.stop(soundContext.currentTime + 0.5);
}
function stopAlarmSound() {
  soundAttempt++;
  $('alarm-audio').pause(); $('alarm-audio').currentTime = 0;
  if (fallbackLoop) clearInterval(fallbackLoop);
  fallbackLoop = null;
}
function showSoundRecovery(show, detail = 'Sound blocked by browser', action = 'Enable sound') {
  $('alarm-enable').hidden = !show;
  $('alarm-sound-help').hidden = !show;
  if (show) {
    $('alarm-sound-help').textContent = ` · ${detail}`;
    $('alarm-enable').textContent = action;
  }
}
function within(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Audio start timed out')), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function startAlarmSound() {
  if (!currentAlarm) return;
  stopAlarmSound();
  const attempt = soundAttempt, alarmId = currentAlarm.id;
  const stale = () => attempt !== soundAttempt || currentAlarm?.id !== alarmId;
  let resume = null;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) soundContext ||= new AudioContextClass();
    if (soundContext?.state === 'suspended') resume = soundContext.resume().catch(() => {});
  } catch { /* the custom MP3 can still play without Web Audio */ }
  const available = !customSoundFailed && await customSoundReady();
  if (available) {
    if (stale()) return;
    try {
      await within($('alarm-audio').play(), 6000);
      if (stale()) { $('alarm-audio').pause(); return; }
      showSoundRecovery(false);
      return;
    } catch (error) {
      if (error.name !== 'NotAllowedError') customSoundFailed = true;
      $('alarm-audio').pause();
    }
  }
  if (resume) await Promise.race([resume, new Promise(resolve => setTimeout(resolve, 400))]);
  if (stale()) return;
  if (soundContext?.state === 'running') {
    chime(); fallbackLoop = setInterval(chime, 2500);
    showSoundRecovery(true, 'Custom sound unavailable; built-in chime is playing', 'Retry custom sound');
  } else showSoundRecovery(true);
}
$('alarm-audio').onerror = () => { customSoundFailed = true; if (currentAlarm && !fallbackLoop) startAlarmSound(); };
$('alarm-enable').onclick = () => { customSoundFailed = false; startAlarmSound(); };
function updateAlarms() {
  const now = Date.now();
  const candidates = [];
  const stillEligible = (id, at) => now - at < 86400000 || alarmMemory[id]?.snoozedUntil > at;
  lastTodos.filter(t => !t.done && t.dueAt && now >= t.dueAt && stillEligible(`task:${t.id}:${t.dueAt}`, t.dueAt))
    .forEach(t => candidates.push({ id: `task:${t.id}:${t.dueAt}`, name: t.text, detail: 'Task due', at: t.dueAt }));
  timers.filter(t => !t.done && t.targetAt && now >= t.targetAt && stillEligible(`timer:${t.id}:${t.targetAt}`, t.targetAt))
    .forEach(t => candidates.push({ id: `timer:${t.id}:${t.targetAt}`, name: t.name, detail: 'Timer finished', at: t.targetAt }));
  candidates.sort((a, b) => a.at - b.at);
  const next = candidates.find(a => !alarmMemory[a.id]?.dismissed && (!alarmMemory[a.id]?.snoozedUntil || alarmMemory[a.id].snoozedUntil <= now));
  if (next?.id === currentAlarm?.id) return;
  stopAlarmSound(); customSoundFailed = false; currentAlarm = next || null;
  $('alarm-banner').hidden = !next;
  showSoundRecovery(false);
  if (next) {
    $('alarm-title').textContent = next.name;
    $('alarm-detail').textContent = next.detail;
    startAlarmSound();
  }
}
$('alarm-dismiss').onclick = () => {
  if (!currentAlarm) return;
  alarmMemory[currentAlarm.id] = { dismissed: true }; saveAlarmMemory(); updateAlarms();
};
document.querySelectorAll('.alarm-snooze').forEach(button => {
  button.onclick = () => {
    if (!currentAlarm) return;
    const minutes = Number(button.dataset.minutes);
    if (![5, 10, 30].includes(minutes)) return;
    alarmMemory[currentAlarm.id] = { snoozedUntil: Date.now() + minutes * 60000 };
    saveAlarmMemory(); updateAlarms();
  };
});

/* ---------- Kiosk display and connection state ---------- */
let display = {};
let streamConnected = false;
let lastStreamAt = 0;
function syncLayout() {
  const pc = lastPC || {};
  const age = pc.updatedAt ? Math.max(0, Date.now() + serverClockOffsetMs - pc.updatedAt) : Infinity;
  const showPC = display.showPC !== false && display.mode !== 'focus' && age < 10000;
  const showTimers = display.showTimers !== false && timers.length > 0;
  const showRoutines = !$('routine-section').hidden;
  $('pc-card').hidden = !showPC;
  $('timer-card').hidden = !showTimers;
  $('life-card').hidden = display.showCalendar === false && display.showTodos === false;
  document.body.classList.toggle('compact-grid', !showPC || !showTimers || display.mode === 'focus');
  document.body.classList.toggle('solo-grid', !showPC && !showTimers && !showRoutines);
}
function quietNow(start, end) {
  const d = new Date(), hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}
function applyDisplay(prefs) {
  const previousShowCalendar = display.showCalendar;
  display = prefs || display;
  document.body.classList.toggle('focus', display.mode === 'focus');
  document.body.classList.toggle('large-text', display.textSize === 'large');
  document.body.classList.toggle('quiet', !!display.quietEnabled && quietNow(display.quietStart || '23:00', display.quietEnd || '07:00'));
  $('today-section').hidden = display.showCalendar === false;
  $('todo-section').hidden = display.showTodos === false;
  $('pc-state').hidden = display.showPC === false || display.mode === 'focus';
  syncLayout();
  renderNext();
  if (previousShowCalendar !== display.showCalendar && lastTodos.length) renderTodos(lastTodos);
}
function updateConnection() {
  const online = streamConnected && Date.now() - lastStreamAt < 45000;
  const pill = $('dashboard-state');
  pill.textContent = online ? 'DASHBOARD LIVE' : 'RECONNECTING';
  pill.className = 'pill ' + (online ? 'ok' : 'bad');
}
function renderSnapshot(j) {
  serverClockOffsetMs = Number(j.now) ? Number(j.now) - Date.now() : serverClockOffsetMs;
  renderPC(j.pc); renderTodos(j.todos); renderTimers(j.timers); renderWeather(j.weather);
  renderTime(j.time); applyDisplay(j.display); renderEvent(j.calendar);
  renderNote(j.note); renderRoutines(j.routines); renderMedia(j.media);
}

async function boot() {
  try {
    const j = await (await fetch('/api/snapshot')).json();
    renderSnapshot(j);
  } catch {}
  const es = new EventSource('/api/stream');
  es.onopen = () => { streamConnected = true; lastStreamAt = Date.now(); updateConnection(); };
  es.onerror = () => { streamConnected = false; updateConnection(); };
  es.addEventListener('heartbeat', () => { lastStreamAt = Date.now(); updateConnection(); });
  es.addEventListener('snapshot', e => {
    try { lastStreamAt = Date.now(); renderSnapshot(JSON.parse(e.data)); updateConnection(); } catch {}
  });
  es.addEventListener('pc', e => { try { renderPC(JSON.parse(e.data)); } catch {} });
  es.addEventListener('todos', e => { try { renderTodos(JSON.parse(e.data)); } catch {} });
  es.addEventListener('timers', e => { try { renderTimers(JSON.parse(e.data)); } catch {} });
  es.addEventListener('weather', e => { try { renderWeather(JSON.parse(e.data)); } catch {} });
  es.addEventListener('time', e => { try { renderTime(JSON.parse(e.data)); } catch {} });
  es.addEventListener('calendar', e => { try { renderEvent(JSON.parse(e.data)); } catch {} });
  es.addEventListener('display', e => { try { applyDisplay(JSON.parse(e.data)); } catch {} });
  es.addEventListener('note', e => { try { renderNote(JSON.parse(e.data)); } catch {} });
  es.addEventListener('media', e => { try { renderMedia(JSON.parse(e.data)); } catch {} });
  es.addEventListener('routines', e => { try { renderRoutines(JSON.parse(e.data)); } catch {} });
  setInterval(async () => {
    try { renderWeather(await (await fetch('/api/weather')).json()); } catch {}
  }, 60000);
  setInterval(() => { if (lastCal) renderEvent(lastCal); }, 30000); // refresh "in Xm" countdowns
  setInterval(() => { refreshPCStatus(); updateConnection(); applyDisplay(); }, 5000);
}
boot();
