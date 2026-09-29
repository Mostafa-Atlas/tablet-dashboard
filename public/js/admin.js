// Admin with custom login page (token in localStorage, no browser Basic popup).
const msg = t => document.getElementById('msg').textContent = t || '';
const loginErr = t => document.getElementById('login-err').textContent = t || '';
const setupErr = t => document.getElementById('setup-err').textContent = t || '';
const getToken = () => localStorage.getItem('admin_token');

async function authFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) { showLogin('Session expired — sign in again'); }
  return r;
}

function showSetup() {
  document.getElementById('setup-card').style.display = 'block';
  document.getElementById('login-card').style.display = 'none';
  document.getElementById('panel').style.display = 'none';
}
function showLogin(err) {
  document.getElementById('setup-card').style.display = 'none';
  document.getElementById('login-card').style.display = 'block';
  document.getElementById('panel').style.display = 'none';
  if (err) loginErr(err);
}
function showPanel() {
  document.getElementById('setup-card').style.display = 'none';
  document.getElementById('login-card').style.display = 'none';
  document.getElementById('panel').style.display = 'block';
  refresh();
}

async function doSetup() {
  setupErr('');
  const user = document.getElementById('setup-user').value.trim();
  const pass = document.getElementById('setup-pass').value;
  const pass2 = document.getElementById('setup-pass2').value;
  if (pass !== pass2) { setupErr('Passwords do not match'); return; }
  const btn = document.getElementById('setup-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await fetch('/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass })
    });
    const j = await r.json();
    if (!r.ok) { setupErr(j.error || 'Setup failed'); return; }
    localStorage.setItem('admin_token', j.token);
    showPanel();
  } catch { setupErr('Cannot reach server'); }
  finally { btn.disabled = false; btn.textContent = 'Create account'; }
}
document.getElementById('setup-btn').onclick = doSetup;

async function doLogin() {
  loginErr('');
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  if (!user || !pass) { loginErr('Enter username and password'); return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass })
    });
    const j = await r.json();
    if (j.needsSetup) { showSetup(); return; }
    if (!r.ok) { loginErr(j.error || 'Login failed'); return; }
    localStorage.setItem('admin_token', j.token);
    document.getElementById('login-pass').value = '';
    showPanel();
  } catch { loginErr('Cannot reach server'); }
  finally { btn.disabled = false; btn.textContent = 'Sign in'; }
}

async function refresh() {
  const r = await authFetch('/api/todos');
  if (!r.ok) return;
  const todos = await r.json();
  const ul = document.getElementById('list'); ul.innerHTML = '';
  todos.forEach(t => {
    const li = document.createElement('li');
    if (t.done) li.className = 'done';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
    cb.onchange = async () => {
      await authFetch('/api/todos/' + t.id, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) });
      refresh();
    };
    const sp = document.createElement('span'); sp.textContent = t.text; sp.className = 'grow';
    const del = document.createElement('button'); del.textContent = '✕'; del.className = 'ghost';
    del.onclick = async () => { await authFetch('/api/todos/' + t.id, { method: 'DELETE' }); refresh(); };
    li.append(cb, sp, del); ul.appendChild(li);
  });
  refreshTimers();
}

async function refreshTimers() {
  const r = await authFetch('/api/timers');
  if (!r.ok) return;
  const list = await r.json();
  const ul = document.getElementById('timer-list'); ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="dim">No timers yet</li>';
  list.forEach(t => {
    const li = document.createElement('li');
    if (t.done) li.className = 'done';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done; cb.title = 'mark done';
    cb.onchange = async () => {
      await authFetch('/api/timers/' + t.id, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) });
      refreshTimers();
    };
    const sp = document.createElement('span'); sp.className = 'grow';
    sp.textContent = `${t.done ? '✓ ' : ''}${t.name} — ${leftText(t)}`;
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = t.type === 'long' ? '📅 long' : '⏱ short';
    const del = document.createElement('button'); del.textContent = '✕'; del.className = 'ghost';
    del.onclick = async () => { await authFetch('/api/timers/' + t.id, { method: 'DELETE' }); refreshTimers(); };
    li.append(cb, sp, tag, del); ul.appendChild(li);
  });
}
function leftText(t) {
  if (t.done) return 'done';
  let ms = null;
  if (t.targetAt) ms = t.targetAt - Date.now();
  else if (t.pausedLeftSec != null) return 'paused ' + fmtDur(t.pausedLeftSec);
  else return 'not set';
  if (ms <= 0) return 'finished';
  const s = Math.round(ms / 1000);
  if (t.type === 'long') {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600);
    return d >= 1 ? `${d}d ${h}h left` : fmtDur(s) + ' left';
  }
  return fmtDur(s) + ' left';
}
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

document.getElementById('login-btn').onclick = doLogin;
document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('logout-btn').onclick = async () => {
  try { await authFetch('/api/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('admin_token');
  showLogin();
};

document.getElementById('todo-add').onclick = async () => {
  const el = document.getElementById('todo-text');
  if (!el.value.trim()) return;
  const r = await authFetch('/api/todos', { method: 'POST', body: JSON.stringify({ text: el.value }) });
  if (!r.ok) { msg('Failed — are you logged in?'); return; }
  el.value = ''; msg('Added ✓'); refresh();
};

/* ---- timers: named, multi, long (days/date) + short (duration/clock time) ---- */
let timerType = 'long';
const typeLongBtn = document.getElementById('type-long');
const typeShortBtn = document.getElementById('type-short');
function setTimerType(t) {
  timerType = t;
  typeLongBtn.classList.toggle('on', t === 'long');
  typeShortBtn.classList.toggle('on', t === 'short');
  document.getElementById('long-inputs').style.display = t === 'long' ? 'block' : 'none';
  document.getElementById('short-inputs').style.display = t === 'short' ? 'block' : 'none';
}
typeLongBtn.onclick = () => setTimerType('long');
typeShortBtn.onclick = () => setTimerType('short');

function timerName() {
  const el = document.getElementById('tm-name');
  if (!el.value.trim()) { msg('Give the timer a name first'); return null; }
  return el.value.trim();
}
document.getElementById('tm-long-set').onclick = async () => {
  const name = timerName(); if (!name) return;
  const days = Number(document.getElementById('tm-days').value || 0);
  const r = await authFetch('/api/timers', { method: 'POST', body: JSON.stringify({ name, type: 'long', days }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg(`"${name}" set ✓`); refreshTimers();
};
document.getElementById('tm-date-set').onclick = async () => {
  const name = timerName(); if (!name) return;
  const date = document.getElementById('tm-date').value;
  if (!date) { msg('Pick a date first'); return; }
  const r = await authFetch('/api/timers', { method: 'POST', body: JSON.stringify({ name, type: 'long', date }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg(`"${name}" set ✓`); refreshTimers();
};
document.getElementById('tm-short-start').onclick = async () => {
  const name = timerName(); if (!name) return;
  const r = await authFetch('/api/timers', { method: 'POST', body: JSON.stringify({
    name, type: 'short',
    hours: Number(document.getElementById('tm-h').value || 0),
    mins: Number(document.getElementById('tm-m').value || 0)
  }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg(`"${name}" started ✓`); refreshTimers();
};
document.getElementById('tm-at-start').onclick = async () => {
  const name = timerName(); if (!name) return;
  const atTime = document.getElementById('tm-at').value;
  if (!atTime) { msg('Pick a time first'); return; }
  const r = await authFetch('/api/timers', { method: 'POST', body: JSON.stringify({ name, type: 'short', atTime }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg(`"${name}" counts down to ${atTime} ✓`); refreshTimers();
};

// Boot: setup -> login -> panel.
(async () => {
  let me = { loggedIn: false, needsSetup: false };
  try {
    const token = getToken();
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    me = await (await fetch('/api/me', { headers })).json();
  } catch { return showLogin('Cannot reach server'); }
  if (me.needsSetup) return showSetup();
  if (me.loggedIn) return showPanel();
  // No valid session. If login says setup is needed (fresh DB), show setup.
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: '', pass: '' })
    });
    const j = await r.json();
    if (j.needsSetup) return showSetup();
  } catch {}
  showLogin();
})();
