// Admin with custom login page (token in localStorage, no browser Basic popup).
let msgTimer = null;
const msg = t => {
  const el = document.getElementById('msg');
  el.textContent = t || '';
  el.classList.toggle('show', !!t);
  clearTimeout(msgTimer);
  if (t) msgTimer = setTimeout(() => el.classList.remove('show'), 2600);
};
const loginErr = t => document.getElementById('login-err').textContent = t || '';
const setupErr = t => document.getElementById('setup-err').textContent = t || '';
const getToken = () => localStorage.getItem('admin_token');
const byId = id => document.getElementById(id);
function actionButton(text, label, onClick, className = 'ghost') {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = text; button.className = className;
  button.setAttribute('aria-label', label); button.onclick = onClick;
  return button;
}

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
  document.getElementById('setup-shell').style.display = 'block';
  document.getElementById('login-shell').style.display = 'none';
  document.getElementById('panel').style.display = 'none';
}
function showLogin(err) {
  document.getElementById('setup-shell').style.display = 'none';
  document.getElementById('login-shell').style.display = 'block';
  document.getElementById('panel').style.display = 'none';
  if (err) loginErr(err);
}
function showPanel() {
  document.getElementById('setup-shell').style.display = 'none';
  document.getElementById('login-shell').style.display = 'none';
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
  if (!r.ok) return;  const todos = await r.json();
  const ul = document.getElementById('list'); ul.innerHTML = '';
  todos.forEach((t, index) => {
    const li = document.createElement('li');
    if (t.done) li.className = 'done';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
    cb.setAttribute('aria-label', `Mark ${t.text} ${t.done ? 'not done' : 'done'}`);
    cb.onchange = async () => {
      const result = await authFetch('/api/todos/' + t.id, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) });
      if (!result.ok) msg('Could not update task');
      refresh();
    };
    const sp = document.createElement('span'); sp.textContent = t.text; sp.className = 'grow';
    if (t.repeat && t.repeat !== 'none') {
      const repeat = document.createElement('small'); repeat.className = 'sub2'; repeat.textContent = `Repeats ${t.repeat}`;
      sp.appendChild(repeat);
    }
    const actions = document.createElement('div'); actions.className = 'item-actions';
    const move = async direction => {
      const result = await authFetch('/api/todos/' + t.id, { method: 'PATCH', body: JSON.stringify({ action: direction }) });
      if (!result.ok) msg('Could not reorder task');
      refresh();
    };
    const up = actionButton('↑', `Move ${t.text} up`, () => move('up'));
    const down = actionButton('↓', `Move ${t.text} down`, () => move('down'));
    up.disabled = index === 0; down.disabled = index === todos.length - 1;
    const edit = actionButton('Edit', `Edit ${t.text}`, () => {
      const field = document.createElement('input'); field.value = t.text; field.maxLength = 200;
      const label = document.createElement('label'); label.textContent = 'Task text'; label.appendChild(field);
      label.className = 'field'; sp.replaceWith(label); actions.hidden = true;
      const save = actionButton('Save', `Save ${t.text}`, async () => {
        if (!field.value.trim()) return msg('Task cannot be empty');
        const result = await authFetch('/api/todos/' + t.id, { method: 'PATCH', body: JSON.stringify({ text: field.value }) });
        if (!result.ok) msg('Could not save task');
        refresh();
      });
      const cancel = actionButton('Cancel', `Cancel editing ${t.text}`, refresh);
      li.append(save, cancel); field.focus();
    });
    const repeatSelect = document.createElement('select');
    repeatSelect.setAttribute('aria-label', `Repeat ${t.text}`);
    for (const [value, label] of [['none', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly']]) {
      repeatSelect.add(new Option(label, value));
    }
    repeatSelect.value = t.repeat || 'none';
    repeatSelect.onchange = async () => {
      const result = await authFetch('/api/todos/' + t.id, { method: 'PATCH', body: JSON.stringify({ repeat: repeatSelect.value }) });
      if (!result.ok) msg('Could not change repeat');
      refresh();
    };
    const del = actionButton('Delete', `Delete ${t.text}`, async () => {
      if (!confirm(`Delete task "${t.text}"?`)) return;
      const result = await authFetch('/api/todos/' + t.id, { method: 'DELETE' });
      if (!result.ok) msg('Could not delete task');
      refresh();
    }, 'danger');
    actions.append(up, down, edit, repeatSelect, del);
    li.append(cb, sp, actions); ul.appendChild(li);
  });
  refreshTimers();
  refreshTime();
  refreshCal();
  refreshDisplay();
  refreshAgentToken();
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
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
    cb.setAttribute('aria-label', `Mark ${t.name} ${t.done ? 'not done' : 'done'}`);
    cb.onchange = async () => {
      const result = await authFetch('/api/timers/' + t.id, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) });
      if (!result.ok) msg('Could not update timer');
      refreshTimers();
    };
    const sp = document.createElement('span'); sp.className = 'grow';
    sp.textContent = `${t.done ? '✓ ' : ''}${t.name} — ${leftText(t)}`;
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = t.type === 'long' ? 'Long' : 'Short';
    const actions = document.createElement('div'); actions.className = 'item-actions';
    const col = document.createElement('input'); col.type = 'color';
    col.setAttribute('aria-label', `Color for ${t.name}`);
    col.value = /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : '#2b6cff';
    col.style.cssText = 'width:34px;padding:2px;cursor:pointer';
    col.onchange = async () => {
      const result = await authFetch('/api/timers/' + t.id, { method: 'PATCH', body: JSON.stringify({ color: col.value }) });
      msg(result.ok ? 'Color updated' : 'Could not update color');
    };
    const paused = t.pausedLeftSec != null;
    const pause = actionButton(paused ? 'Resume' : 'Pause', `${paused ? 'Resume' : 'Pause'} ${t.name}`, async () => {
      const result = await authFetch('/api/timers/' + t.id, { method: 'PATCH', body: JSON.stringify({ action: paused ? 'resume' : 'pause' }) });
      if (!result.ok) msg('Could not change timer');
      refreshTimers();
    });
    pause.disabled = !!t.done || (!t.targetAt && !paused);
    const edit = actionButton('Edit', `Edit ${t.name}`, () => {
      const name = document.createElement('input'); name.value = t.name; name.maxLength = 60;
      const target = document.createElement('input'); target.type = 'datetime-local';
      if (t.targetAt) target.value = localInputValue(t.targetAt);
      const editor = document.createElement('div'); editor.className = 'row'; editor.style.width = '100%';
      const nameField = document.createElement('label'); nameField.className = 'field'; nameField.textContent = 'Timer name'; nameField.appendChild(name);
      const targetField = document.createElement('label'); targetField.className = 'field'; targetField.textContent = 'End time (optional)'; targetField.appendChild(target);
      const save = actionButton('Save', `Save ${t.name}`, async () => {
        const body = { name: name.value.trim() };
        if (!body.name) return msg('Timer name cannot be empty');
        if (target.value) body.targetAt = new Date(target.value).getTime();
        const result = await authFetch('/api/timers/' + t.id, { method: 'PATCH', body: JSON.stringify(body) });
        if (!result.ok) msg((await result.json()).error || 'Could not save timer');
        refreshTimers();
      });
      const cancel = actionButton('Cancel', `Cancel editing ${t.name}`, refreshTimers);
      sp.hidden = true; tag.hidden = true; actions.hidden = true;
      editor.append(nameField, targetField, save, cancel); li.appendChild(editor); name.focus();
    });
    const restart = actionButton('Restart', `Restart ${t.name}`, async () => {
      const result = await authFetch('/api/timers/' + t.id, { method: 'PATCH',
        body: JSON.stringify({ targetAt: Date.now() + t.durationSec * 1000 }) });
      if (!result.ok) msg('Could not restart timer');
      refreshTimers();
    });
    restart.hidden = t.type !== 'short' || !t.durationSec || (t.targetAt && t.targetAt > Date.now() && !t.done);
    const del = actionButton('Delete', `Delete ${t.name}`, async () => {
      if (!confirm(`Delete timer "${t.name}"?`)) return;
      const result = await authFetch('/api/timers/' + t.id, { method: 'DELETE' });
      if (!result.ok) msg('Could not delete timer');
      refreshTimers();
    }, 'danger');
    actions.append(pause, edit, restart, col, del);
    li.append(cb, sp, tag, actions); ul.appendChild(li);
  });
}
function localInputValue(ms) {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
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
  const r = await authFetch('/api/todos', { method: 'POST', body: JSON.stringify({ text: el.value, repeat: byId('todo-repeat').value }) });
  if (!r.ok) { msg('Failed — are you logged in?'); return; }
  el.value = ''; msg('Added ✓'); refresh();
};
byId('todo-text').addEventListener('keydown', e => { if (e.key === 'Enter') byId('todo-add').click(); });

/* ---- dashboard clock override ---- */
async function refreshTime() {
  try {
    const t = await (await fetch('/api/time')).json();
    const d = new Date(t.dashboardNow);
    let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const off = t.offsetSec || 0;
    const offTxt = off === 0 ? '(real time)' : `(shifted ${off > 0 ? '+' : ''}${Math.round(off / 3600 * 10) / 10}h)`;
    document.getElementById('dash-now').textContent =
      `${h}:${m} ${ap}  ${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()} ${offTxt}`;
  } catch {}
}
document.getElementById('time-set').onclick = async () => {
  const v = document.getElementById('tm-datetime').value;
  if (!v) { msg('Pick a date + time first'); return; }
  const r = await authFetch('/api/time', { method: 'POST', body: JSON.stringify({ datetime: v }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg('Dashboard time set ✓'); refreshTime();
};
document.getElementById('time-reset').onclick = async () => {
  await authFetch('/api/time', { method: 'POST', body: JSON.stringify({ action: 'reset' }) });
  msg('Back to real time ✓'); refreshTime();
};

/* ---- google calendar (private ICS url) ---- */
async function refreshCal() {
  try {
    const s = await authFetch('/api/settings');
    if (!s.ok) return;
    const set = await s.json();
    const inp = document.getElementById('cal-ics');
    if (document.activeElement !== inp) inp.value = set.icsUrl || '';
    const cal = await (await fetch('/api/calendar')).json();
    const st = document.getElementById('cal-status');
    const nx = document.getElementById('cal-next');
    if (!set.icsUrl) {
      st.innerHTML = '<span class="bad-dot">●</span> not connected';
      nx.style.display = 'none';
    } else if (cal.error && !cal.next) {
      st.textContent = '';
      st.appendChild(Object.assign(document.createElement('span'), { className: 'bad-dot', textContent: '●' }));
      st.appendChild(document.createTextNode(' error — will retry'));
      nx.style.display = 'none';
    } else {
      st.innerHTML = '<span class="ok-dot">●</span> connected';
      if (cal.next) {
        const d = new Date(cal.next.startMs);
        let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        const today = new Date();
        const ds = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        const todays = (cal.upcoming || []).filter(e => e.startMs < ds + 86400000 && e.endMs > ds).length;
        nx.style.display = 'block';
        nx.innerHTML = '';
        const b = document.createElement('b');
        b.textContent = `Next: ${cal.next.summary}`;
        const sub = document.createElement('div');
        sub.className = 'hint';
        sub.textContent = `${h}:${m} ${ap} · ${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}` +
          (cal.next.location ? ` · ${cal.next.location}` : '') +
          (todays > 1 ? ` · +${todays - 1} more today` : todays === 1 ? ' · only event today' : '');
        nx.append(b, sub);
      } else nx.style.display = 'none';
    }
  } catch {}
}
document.getElementById('cal-save').onclick = async () => {
  const v = document.getElementById('cal-ics').value.trim();
  if (!v) { msg('Paste the ICS URL first'); return; }
  const r = await authFetch('/api/settings', { method: 'POST', body: JSON.stringify({ icsUrl: v }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg('Calendar connected ✓'); refreshCal();
};
document.getElementById('cal-clear').onclick = async () => {
  await authFetch('/api/settings', { method: 'POST', body: JSON.stringify({ icsUrl: '' }) });
  document.getElementById('cal-ics').value = '';
  msg('Calendar disconnected'); refreshCal();
};
let timerType = 'long';
const typeLongBtn = document.getElementById('type-long');
const typeShortBtn = document.getElementById('type-short');
function setTimerType(t) {
  timerType = t;
  typeLongBtn.classList.toggle('on', t === 'long');
  typeShortBtn.classList.toggle('on', t === 'short');
  typeLongBtn.setAttribute('aria-pressed', String(t === 'long'));
  typeShortBtn.setAttribute('aria-pressed', String(t === 'short'));
  document.getElementById('long-inputs').style.display = t === 'long' ? 'block' : 'none';
  document.getElementById('short-inputs').style.display = t === 'short' ? 'block' : 'none';
}
typeLongBtn.onclick = () => setTimerType('long');
typeShortBtn.onclick = () => setTimerType('short');
byId('tm-long-method').onchange = updateTimerMethods;
byId('tm-short-method').onchange = updateTimerMethods;
function updateTimerMethods() {
  const byDays = byId('tm-long-method').value === 'days';
  byId('long-days-row').hidden = !byDays;
  byId('long-date-row').hidden = byDays;
  const byDuration = byId('tm-short-method').value === 'duration';
  byId('short-duration-row').hidden = !byDuration;
  byId('short-time-row').hidden = byDuration;
  updateTimerPreview();
}
function updateTimerPreview() {
  let longTarget = null, shortTarget = null;
  if (byId('tm-long-method').value === 'days') {
    const days = Number(byId('tm-days').value);
    if (days > 0) longTarget = Date.now() + days * 86400000;
  } else if (byId('tm-date').value) longTarget = new Date(byId('tm-date').value + 'T23:59:59').getTime();
  if (byId('tm-short-method').value === 'duration') {
    const mins = Number(byId('tm-h').value) * 60 + Number(byId('tm-m').value);
    if (mins > 0) shortTarget = Date.now() + mins * 60000;
  } else if (byId('tm-at').value) {
    const [h, m] = byId('tm-at').value.split(':').map(Number);
    const target = new Date(); target.setHours(h, m, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    shortTarget = target.getTime();
  }
  byId('long-preview').textContent = longTarget ? `Ends ${new Date(longTarget).toLocaleString()}` : 'Choose a future end date.';
  byId('short-preview').textContent = shortTarget ? `Ends ${new Date(shortTarget).toLocaleString()}` : 'Choose a duration or clock time.';
}
for (const id of ['tm-days', 'tm-date', 'tm-h', 'tm-m', 'tm-at']) byId(id).addEventListener('input', updateTimerPreview);
for (const button of document.querySelectorAll('.preset')) button.onclick = () => {
  const minutes = Number(button.dataset.minutes);
  byId('tm-h').value = Math.floor(minutes / 60);
  byId('tm-m').value = minutes % 60;
  updateTimerPreview();
};
updateTimerMethods();

function timerName() {
  const el = document.getElementById('tm-name');
  if (!el.value.trim()) { msg('Give the timer a name first'); return null; }
  return el.value.trim();
}
function timerColor() { return document.getElementById('tm-color').value; }
document.getElementById('tm-long-create').onclick = async () => {
  const name = timerName(); if (!name) return;
  const byDays = byId('tm-long-method').value === 'days';
  const days = Number(byId('tm-days').value);
  const targetAt = byDays ? Date.now() + days * 86400000 : new Date(byId('tm-date').value + 'T23:59:59').getTime();
  if (!Number.isFinite(targetAt) || targetAt <= Date.now() || (byDays && days < 1)) return msg('Choose a future date');
  const r = await authFetch('/api/timers', { method: 'POST', body: JSON.stringify({ name, type: 'long', targetAt, color: timerColor() }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg(`"${name}" set ✓`); refreshTimers();
};
document.getElementById('tm-short-create').onclick = async () => {
  const name = timerName(); if (!name) return;
  const byDuration = byId('tm-short-method').value === 'duration';
  const hours = Number(byId('tm-h').value), mins = Number(byId('tm-m').value);
  if (byDuration && (!Number.isFinite(hours) || !Number.isFinite(mins) || hours < 0 || hours > 12 || mins < 0 || mins > 59 || hours + mins === 0)) return msg('Choose 1 minute to 12 hours');
  let targetAt = null;
  if (!byDuration) {
    if (!byId('tm-at').value) return msg('Choose a clock time');
    const [h, m] = byId('tm-at').value.split(':').map(Number);
    const target = new Date(); target.setHours(h, m, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    targetAt = target.getTime();
  }
  const r = await authFetch('/api/timers', { method: 'POST', body: JSON.stringify({
    name, type: 'short', color: timerColor(),
    ...(byDuration ? { hours, mins } : { targetAt })
  }) });
  if (!r.ok) { msg((await r.json()).error || 'Failed'); return; }
  msg(`"${name}" started ✓`); refreshTimers();
};

async function refreshDisplay() {
  try {
    const prefs = await (await fetch('/api/display')).json();
    byId('display-mode').value = prefs.mode || 'overview';
    byId('display-text').value = prefs.textSize || 'normal';
    for (const [id, key] of [['show-calendar', 'showCalendar'], ['show-todos', 'showTodos'],
      ['show-timers', 'showTimers'], ['show-pc', 'showPC'], ['display-privacy', 'privacy'],
      ['quiet-enabled', 'quietEnabled']]) byId(id).checked = !!prefs[key];
    byId('quiet-start').value = prefs.quietStart || '23:00';
    byId('quiet-end').value = prefs.quietEnd || '07:00';
  } catch { msg('Could not load display settings'); }
}
byId('display-save').onclick = async () => {
  const body = { mode: byId('display-mode').value, textSize: byId('display-text').value,
    quietStart: byId('quiet-start').value, quietEnd: byId('quiet-end').value };
  for (const [id, key] of [['show-calendar', 'showCalendar'], ['show-todos', 'showTodos'],
    ['show-timers', 'showTimers'], ['show-pc', 'showPC'], ['display-privacy', 'privacy'],
    ['quiet-enabled', 'quietEnabled']]) body[key] = byId(id).checked;
  const result = await authFetch('/api/display', { method: 'POST', body: JSON.stringify(body) });
  if (!result.ok) return msg('Could not save display settings');
  msg('Display settings saved'); refreshDisplay();
};
async function refreshAgentToken() {
  try {
    const result = await authFetch('/api/agent-token');
    if (result.ok) byId('agent-token').value = (await result.json()).token;
  } catch { msg('Could not load agent token'); }
}
byId('agent-token-toggle').onclick = () => {
  const shown = byId('agent-token').type === 'password';
  byId('agent-token').type = shown ? 'text' : 'password';
  byId('agent-token-toggle').textContent = shown ? 'Hide token' : 'Show token';
  byId('agent-token-toggle').setAttribute('aria-pressed', String(shown));
};
byId('export-btn').onclick = async () => {
  const result = await authFetch('/api/export');
  if (!result.ok) return msg('Could not export data');
  const url = URL.createObjectURL(await result.blob());
  const link = document.createElement('a'); link.href = url; link.download = 'tablet-dashboard-export.json';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  msg('Export downloaded');
};
byId('import-btn').onclick = () => byId('import-file').click();
byId('import-file').onchange = async () => {
  const file = byId('import-file').files[0];
  if (!file) return;
  if (file.size > 256 * 1024) return msg('Export file is too large');
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('Replace current tasks, timers, and display settings with this export?')) return;
    const result = await authFetch('/api/import', { method: 'POST', body: JSON.stringify(data) });
    if (!result.ok) return msg((await result.json()).error || 'Could not import data');
    msg('Data imported'); refresh();
  } catch { msg('Invalid JSON export'); }
  finally { byId('import-file').value = ''; }
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
