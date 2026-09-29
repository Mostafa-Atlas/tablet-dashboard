// Kiosk: 12h clock, SSE live updates, stale handling. No interaction.
const $ = id => document.getElementById(id);

function tickClock() {
  const d = new Date();
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  $('clock').textContent = `${h}:${m}:${s} ${ap}`;
  $('date').textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
setInterval(tickClock, 1000); tickClock();

let timers = null;
function renderPC(pc) {
  pc = pc || {};
  setBar('cpu', pc.cpu); setBar('gpu', pc.gpu); setBar('ram', pc.ram);
  const temps = [];
  if (pc.cpuTemp != null) temps.push(`CPU ${pc.cpuTemp}°C`);
  if (pc.gpuTemp != null) temps.push(`GPU ${pc.gpuTemp}°C`);
  $('temps').textContent = temps.join(' · ') || '—';
  if (Array.isArray(pc.disks) && pc.disks.length) {
    $('disks').textContent = 'Storage: ' + pc.disks.map(d => `${d.mount || d.disk || ''} ${d.pct}%`).join(' · ');
  }
  const age = pc.updatedAt ? Math.round((Date.now() - pc.updatedAt) / 1000) : 999;
  const pill = $('pc-state');
  if (age < 10) { pill.textContent = 'PC ONLINE'; pill.className = 'pill ok'; }
  else { pill.textContent = 'PC OFFLINE'; pill.className = 'pill bad'; }
  $('pc-age').textContent = pc.updatedAt ? `updated ${age}s ago` : 'agent not connected yet';
}
function setBar(k, v) {
  v = Math.max(0, Math.min(100, Number(v) || 0));
  $(k + '-v').textContent = Math.round(v) + '%';
  $(k + '-b').style.width = v + '%';
}
function renderTodos(list) {
  const ul = $('todos'); ul.innerHTML = '';
  const vis = (list || []).filter(t => !t.done).slice(0, 5);
  const done = (list || []).filter(t => t.done).length;
  if (!vis.length) ul.innerHTML = '<li class="dim">All clear ✓</li>';
  vis.forEach(t => { const li = document.createElement('li'); li.textContent = t.text; ul.appendChild(li); });
  if (done) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = `+ ${done} done`; ul.appendChild(li); }
}
function renderTimers(t) {
  timers = t;
  if (t && t.long) { $('long-label').textContent = t.long.label || 'Long term'; }
}
function tickTimers() {
  if (!timers) return;
  const now = Date.now();
  // long
  if (timers.long && timers.long.targetAt) {
    const ms = timers.long.targetAt - now;
    if (ms <= 0) { $('long-left').textContent = 'DONE'; $('long-b').style.width = '100%'; }
    else {
      const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000);
      $('long-left').textContent = `${d}d ${h}h`;
      const total = timers.long.targetAt - (timers.long.createdAt || now - 1);
      $('long-b').style.width = Math.min(100, Math.max(0, 100 * (1 - ms / total))) + '%';
    }
  }
  // short
  const s = timers.short;
  if (s) {
    $('short-label').textContent = s.label || 'Focus';
    let left = null;
    if (s.endsAt) left = Math.max(0, Math.round((s.endsAt - now) / 1000));
    else if (s.pausedLeftSec != null) left = s.pausedLeftSec;
    $('short-left').textContent = left == null ? '--:--' : fmt(left);
  }
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

async function boot() {
  try {
    const j = await (await fetch('/api/snapshot')).json();
    renderPC(j.pc); renderTodos(j.todos); renderTimers(j.timers); renderWeather(j.weather);
  } catch {}
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', e => {
    try { const j = JSON.parse(e.data); renderPC(j.pc); renderTodos(j.todos); renderTimers(j.timers); renderWeather(j.weather); } catch {}
  });
  es.addEventListener('pc', e => { try { renderPC(JSON.parse(e.data)); } catch {} });
  es.addEventListener('todos', e => { try { renderTodos(JSON.parse(e.data)); } catch {} });
  es.addEventListener('timers', e => { try { renderTimers(JSON.parse(e.data)); } catch {} });
  es.addEventListener('weather', e => { try { renderWeather(JSON.parse(e.data)); } catch {} });
  // refresh weather text every 60s + re-snapshot every 60s as safety
  setInterval(async () => {
    try { renderWeather(await (await fetch('/api/weather')).json()); } catch {}
  }, 60000);
}
boot();
