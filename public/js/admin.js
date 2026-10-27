// Checked mutations preserve drafts and keep remote updates away from active controls.
const $ = id => document.getElementById(id);
let authenticated = false, stream = null, msgTimer;
let todos = [], timers = [], clockOffsetSec = 0, calendar = null, calendarDirty = false;
const pending = new Map();
let sessionGeneration = 0;
const readEpoch = { todos: 0, timers: 0, time: 0, calendar: 0, settings: 0 };
const readSequence = { todos: 0, timers: 0, time: 0, calendar: 0, settings: 0 };
// Read epochs invalidate whole-resource GETs. Only an authoritative change to the
// same item can supersede its mutation response; unrelated operations cannot.
let authorityClock = 0;
const itemVersions = { todos: new Map(), timers: new Map() };
const valueVersions = { time: 0, calendar: 0 };
function authorityVersion(resource, id) {
  return itemVersions[resource]?.get(id) || valueVersions[resource] || 0;
}
function recordAuthority(resource, id) {
  if (itemVersions[resource]) itemVersions[resource].set(id, ++authorityClock);
  else if (Object.hasOwn(valueVersions, resource)) valueVersions[resource] = ++authorityClock;
}
function recordSnapshotAuthority(resource, data) {
  if (!itemVersions[resource]) { recordAuthority(resource); return; }
  const before = new Map((resource === 'todos' ? todos : timers).map(item => [item.id, item]));
  const after = new Map(data.map(item => [item.id, item]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    // Retain deletion stamps so a late response cannot resurrect a removed item.
    if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) recordAuthority(resource, id);
  }
}
const sessionStamp = () => ({ generation: sessionGeneration, token: getToken() });
const currentSession = stamp => stamp.generation === sessionGeneration && stamp.token === getToken();
function assertSession(stamp) { if (!currentSession(stamp)) throw new Error('Superseded session'); }
function resourceFor(group) { return group.startsWith('todo:') ? 'todos' : group.startsWith('timer:') ? 'timers' : group === 'time' || group === 'calendar' ? group : null; }
function advanceResource(resource) {
  if (resource) readEpoch[resource]++;
}
function commitResource(resource, apply, data) { advanceResource(resource); recordSnapshotAuthority(resource, data); apply(); }
function invalidateSession() {
  sessionGeneration++;
  authenticated = false; stream?.close(); stream = null;
  clearTimeout(msgTimer); msg('');
  for (const operation of pending.values()) operation.controls.forEach((control, i) => control.disabled = operation.previous[i]);
  pending.clear();
  todos = []; timers = []; calendar = null;
  $('list').replaceChildren(); $('timer-list').replaceChildren();
  renderTodos(); renderTimers();
}
const getToken = () => localStorage.getItem('admin_token');
function msg(text) {
  $('msg').textContent = text || ''; $('msg').classList.toggle('show', !!text);
  clearTimeout(msgTimer);
  // Errors remain visible until the next action. Successful actions dismiss naturally.
  if (text && /✓/.test(text)) msgTimer = setTimeout(() => $('msg').classList.remove('show'), 3500);
}
function showScreen(name) {
  for (const id of ['setup', 'login']) $(id + '-shell').style.display = name === id ? 'block' : 'none';
  $('panel').style.display = name === 'panel' ? 'block' : 'none';
}
function showLogin(error = '') {
  invalidateSession();
  localStorage.removeItem('admin_token');
  showScreen('login'); $('login-err').textContent = error;
}
async function request(url, opts = {}, protect = true) {
  const stamp = sessionStamp();
  if (protect && !authenticated) throw new Error('Sign in again to continue');
  const headers = { ...opts.headers };
  if (protect && getToken()) headers.Authorization = 'Bearer ' + getToken();
  if (opts.body) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(url, { ...opts, headers }); }
  catch { assertSession(stamp); throw new Error('Cannot reach server — please retry'); }
  assertSession(stamp);
  let data;
  try { data = await response.json(); }
  catch { assertSession(stamp); throw new Error('Invalid server response — please retry'); }
  assertSession(stamp);
  if (response.status === 401 && protect) {
    showLogin('Session expired — sign in again');
    const error = new Error('Session expired — sign in again'); error.sessionExpired = true; throw error;
  }
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || 'Request failed — please retry');
    error.data = data; throw error;
  }
  return data;
}
async function mutate(group, controls, url, method, body, onSuccess, rollback) {
  if (pending.has(group) || !authenticated) return;
  const stamp = sessionStamp(), resource = resourceFor(group);
  advanceResource(resource);
  if (resource === 'calendar') advanceResource('settings');
  const beganAt = authorityClock;
  const operation = { controls, previous: controls.map(control => control.disabled) };
  pending.set(group, operation);
  controls.forEach(control => control.disabled = true);
  msg('Saving…');
  try {
    const data = await request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!currentSession(stamp)) return;
    const id = itemVersions[resource] ? (method === 'POST' ? data.id : group.slice(group.indexOf(':') + 1)) : null;
    const apply = authorityVersion(resource, id) <= beganAt;
    if (apply) { advanceResource(resource); recordAuthority(resource, id); }
    onSuccess?.(data, apply);
  } catch (error) {
    if (!currentSession(stamp)) return;
    rollback?.();
    if (error.data?.calendar && authorityVersion('calendar') <= beganAt) commitResource('calendar', () => renderCalendar(error.data.calendar));
    msg(error.message);
  } finally {
    if (currentSession(stamp) && pending.get(group) === operation) {
      advanceResource(resource);
      if (resource === 'calendar') advanceResource('settings');
      pending.delete(group);
      controls.forEach((control, i) => control.disabled = operation.previous[i]);
      renderTodos(); renderTimers();
    }
  }
}
async function refresh() {
  if (!authenticated) return;
  const stamp = sessionStamp();
  async function read(resource, url, apply, protect = true) {
    const revision = readEpoch[resource], sequence = ++readSequence[resource];
    const current = () => currentSession(stamp) && authenticated && readEpoch[resource] === revision && readSequence[resource] === sequence && ![...pending.keys()].some(group => resourceFor(group) === resource || resource === 'settings' && group === 'calendar');
    try {
      const data = await request(url, {}, protect);
      if (current()) commitResource(resource, () => apply(data), data);
    } catch (error) { if (current()) msg(error.message); }
  }
  await Promise.all([
    read('todos', '/api/todos', renderTodos),
    read('timers', '/api/timers', renderTimers),
    read('time', '/api/time', renderTime, false),
    read('settings', '/api/settings', settings => {
      if (!calendarDirty && document.activeElement !== $('cal-ics') && !pending.has('calendar')) $('cal-ics').value = settings.icsUrl || '';
    }),
    read('calendar', '/api/calendar', renderCalendar, false)
  ]);
}
function safeToRender(list, group) {
  return !list.contains(document.activeElement) && ![...pending.keys()].some(key => key.startsWith(group));
}
function renderTodos(list = todos) {
  todos = list;
  const ul = $('list');
  if (!safeToRender(ul, 'todo:')) return;
  ul.replaceChildren();
  if (!list.length) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = 'No tasks yet'; ul.append(li); }
  for (const task of list) {
    const li = document.createElement('li'); li.classList.toggle('done', !!task.done);
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!task.done; cb.setAttribute('aria-label', 'Mark ' + task.text + ' done');
    const text = document.createElement('span'); text.className = 'grow'; text.textContent = task.text;
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete task ' + task.text);
    const update = (data, apply) => { if (apply) { renderTodos(todos.map(item => item.id === task.id ? data : item)); li.classList.toggle('done', !!data.done); } msg('Task updated ✓'); };
    cb.onchange = () => mutate('todo:' + task.id, [cb, del], '/api/todos/' + task.id, 'PATCH', { done: cb.checked }, update, () => cb.checked = !!(todos.find(item => item.id === task.id) || task).done);
    del.onclick = () => mutate('todo:' + task.id, [cb, del], '/api/todos/' + task.id, 'DELETE', undefined, (data, apply) => { if (apply) { renderTodos(todos.filter(item => item.id !== task.id)); li.remove(); } msg('Task deleted ✓'); });
    li.append(cb, text, del); ul.append(li);
  }
}
function renderTimers(list = timers) {
  timers = list;
  const ul = $('timer-list');
  if (!safeToRender(ul, 'timer:')) return;
  ul.replaceChildren();
  if (!list.length) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = 'No timers yet'; ul.append(li); }
  for (const timer of list) {
    const li = document.createElement('li'); li.dataset.timerId = timer.id; li.classList.toggle('done', !!timer.done);
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!timer.done; cb.setAttribute('aria-label', 'Mark ' + timer.name + ' done');
    const text = document.createElement('span'); text.className = 'grow timer-description';
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = timer.type === 'long' ? 'long' : 'short';
    const color = document.createElement('input'); color.type = 'color'; color.className = 'timer-color'; color.setAttribute('aria-label', 'Color for timer ' + timer.name);
    const confirmedColor = /^#[0-9a-fA-F]{6}$/.test(timer.color || '') ? timer.color : '#2b6cff'; color.value = confirmedColor;
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete timer ' + timer.name);
    const update = (data, apply) => { if (apply) { renderTimers(timers.map(item => item.id === timer.id ? data : item)); li.classList.toggle('done', !!data.done); } msg('Timer updated ✓'); };
    cb.onchange = () => mutate('timer:' + timer.id, [cb, color, del], '/api/timers/' + timer.id, 'PATCH', { done: cb.checked }, update, () => cb.checked = !!(timers.find(item => item.id === timer.id) || timer).done);
    color.onchange = () => mutate('timer:' + timer.id, [cb, color, del], '/api/timers/' + timer.id, 'PATCH', { color: color.value }, update, () => color.value = (timers.find(item => item.id === timer.id) || timer).color || confirmedColor);
    del.onclick = () => mutate('timer:' + timer.id, [cb, color, del], '/api/timers/' + timer.id, 'DELETE', undefined, (data, apply) => { if (apply) { renderTimers(timers.filter(item => item.id !== timer.id)); li.remove(); } msg('Timer deleted ✓'); });
    li.append(cb, text, tag, color, del); ul.append(li);
  }
  tick();
}
function fmtDur(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function leftText(timer) {
  if (timer.done) return 'done';
  if (!timer.targetAt) return timer.pausedLeftSec != null ? 'paused ' + fmtDur(timer.pausedLeftSec) : 'not set';
  const seconds = Math.ceil((timer.targetAt - DashboardTime.now()) / 1000);
  if (seconds <= 0) return 'finished';
  if (timer.type === 'long' && seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h left`;
  return fmtDur(seconds) + ' left';
}
function tick() {
  const now = DashboardTime.now() + clockOffsetSec * 1000;
  $('dash-now').textContent = `${DashboardTime.time(now, true)}  ${DashboardTime.date(now)} · ${DashboardTime.zone} ${clockOffsetSec ? '(shifted)' : '(real time)'}`;
  for (const row of $('timer-list').children) {
    const timer = timers.find(item => item.id === row.dataset.timerId);
    if (timer) row.querySelector('.timer-description').textContent = `${timer.name} — ${leftText(timer)}`;
  }
}
function renderTime(time) {
  DashboardTime.setZone(time.timeZone);
  if (Number.isFinite(time.dashboardNow)) DashboardTime.sync(time.dashboardNow - (Number(time.offsetSec) || 0) * 1000);
  clockOffsetSec = Number(time.offsetSec) || 0; tick();
}
function renderCalendar(cal) {
  calendar = cal;
  const status = $('cal-status'), next = $('cal-next');
  const stale = DashboardTime.stale(cal, 20 * 60000);
  status.className = !cal?.configured || cal.error || stale ? 'data-warning' : 'ok-dot';
  status.textContent = !cal?.configured ? 'Not connected' : cal.error ? 'Refresh failed · saved URL will retry; cached data may be stale' : stale ? 'Stale · refreshing' : 'Connected';
  next.replaceChildren(); next.style.display = cal?.next ? 'block' : 'none';
  if (cal?.next) {
    const title = document.createElement('b'); title.textContent = `Next: ${cal.next.summary}`;
    const sub = document.createElement('div'); sub.className = 'hint';
    sub.textContent = `${cal.next.allDay ? 'All day' : DashboardTime.time(cal.next.startMs)} · ${DashboardTime.date(cal.next.startMs)}` + (cal.next.location ? ' · ' + cal.next.location : '');
    next.append(title, sub);
  }
}
function subscribe() {
  stream?.close(); stream = new EventSource('/api/stream');
  const stamp = sessionStamp();
  const active = () => authenticated && currentSession(stamp);
  const listen = (name, render) => stream.addEventListener(name, event => { if (active()) { try { render(JSON.parse(event.data)); } catch { msg('Could not read live update'); } } });
  listen('snapshot', snapshot => {
    DashboardTime.sync(snapshot.now); DashboardTime.setZone(snapshot.timeZone);
    commitResource('todos', () => renderTodos(snapshot.todos), snapshot.todos);
    commitResource('timers', () => renderTimers(snapshot.timers), snapshot.timers);
    commitResource('time', () => renderTime(snapshot.time));
    commitResource('calendar', () => renderCalendar(snapshot.calendar));
  });
  for (const [resource, render] of Object.entries({ todos: renderTodos, timers: renderTimers, time: renderTime, calendar: renderCalendar })) listen(resource, data => commitResource(resource, () => render(data), data));
  stream.addEventListener('error', () => { if (active()) $('admin-sync').textContent = 'Server reconnecting…'; });
  stream.addEventListener('open', () => { if (active()) $('admin-sync').textContent = 'Live updates connected'; });
}
function showPanel() { invalidateSession(); authenticated = true; showScreen('panel'); subscribe(); return refresh(); }
async function authenticate(setup) {
  const prefix = setup ? 'setup' : 'login', button = $(prefix + '-btn');
  if (button.disabled) return;
  const errorEl = $(prefix + '-err'); errorEl.textContent = '';
  const user = $(prefix + '-user').value.trim(), pass = $(prefix + '-pass').value;
  if (setup && pass !== $('setup-pass2').value) { errorEl.textContent = 'Passwords do not match'; return; }
  button.disabled = true;
  const stamp = sessionStamp();
  try {
    const data = await request('/api/' + prefix, { method: 'POST', body: JSON.stringify({ user, pass }) }, false);
    if (!currentSession(stamp)) return;
    button.disabled = false;
    localStorage.setItem('admin_token', data.token);
    $(prefix + '-pass').value = ''; if (setup) $('setup-pass2').value = '';
    await showPanel();
  } catch (error) { if (currentSession(stamp)) errorEl.textContent = error.message; }
  finally { if (currentSession(stamp)) button.disabled = false; }
}
$('setup-btn').onclick = () => authenticate(true);
$('login-btn').onclick = () => authenticate(false);
for (const id of ['login-user', 'login-pass', 'setup-user', 'setup-pass', 'setup-pass2']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') authenticate(id.startsWith('setup') ); });
$('logout-btn').onclick = async () => {
  await mutate('logout', [$('logout-btn')], '/api/logout', 'POST', undefined, () => { showLogin(); msg('Signed out ✓'); });
};
$('todo-add').onclick = () => {
  const draft = $('todo-text').value;
  if (!draft.trim()) { msg('Enter a task first'); return; }
  return mutate('todo:add', [$('todo-add')], '/api/todos', 'POST', { text: draft }, (data, apply) => {
    if ($('todo-text').value === draft) $('todo-text').value = '';
    if (apply) renderTodos([...todos.filter(item => item.id !== data.id), data]); msg('Added ✓');
  });
};
$('todo-text').addEventListener('keydown', event => { if (event.key === 'Enter') $('todo-add').onclick(); });
const timeControls = [$('time-set'), $('time-reset')];
$('time-set').onclick = () => {
  const datetime = $('tm-datetime').value;
  if (!datetime) { msg('Pick a date + time first'); return; }
  return mutate('time', timeControls, '/api/time', 'POST', { datetime }, (data, apply) => { if (apply) renderTime(data); msg('Dashboard time set ✓'); });
};
$('time-reset').onclick = () => mutate('time', timeControls, '/api/time', 'POST', { action: 'reset' }, (data, apply) => { if (apply) renderTime(data); msg('Back to real time ✓'); });
const calendarControls = [$('cal-save'), $('cal-clear')];
$('cal-ics').addEventListener('input', () => calendarDirty = true);
$('cal-save').onclick = () => {
  const draft = $('cal-ics').value;
  if (!draft.trim()) { msg('Paste the ICS URL first'); return; }
  calendarDirty = true;
  return mutate('calendar', calendarControls, '/api/settings', 'POST', { icsUrl: draft.trim() }, (data, apply) => {
    if ($('cal-ics').value === draft) calendarDirty = false;
    if (apply) renderCalendar(data.calendar); msg('Calendar connected ✓');
  });
};
$('cal-clear').onclick = () => {
  const draft = $('cal-ics').value;
  return mutate('calendar', calendarControls, '/api/settings', 'POST', { icsUrl: '' }, (data, apply) => {
    if ($('cal-ics').value === draft) { $('cal-ics').value = ''; calendarDirty = false; }
    if (apply) renderCalendar(data.calendar); msg('Calendar disconnected ✓');
  });
};
function setTimerType(type) {
  for (const value of ['long', 'short']) {
    $('type-' + value).classList.toggle('on', value === type);
    $('type-' + value).setAttribute('aria-pressed', value === type ? 'true' : 'false');
    $(value + '-inputs').style.display = value === type ? 'block' : 'none';
  }
}
$('type-long').onclick = () => setTimerType('long'); $('type-short').onclick = () => setTimerType('short');
const timerButtons = ['tm-long-set', 'tm-date-set', 'tm-short-start', 'tm-at-start'].map($);
function createTimer(button, fields) {
  const name = $('tm-name').value.trim();
  if (!name) { msg('Give the timer a name first'); return; }
  if (Object.values(fields).some(value => value === '')) { msg('Enter the timer date or time first'); return; }
  return mutate('timer:create', timerButtons, '/api/timers', 'POST', { name, color: $('tm-color').value, ...fields }, (data, apply) => {
    if (apply) renderTimers([...timers.filter(item => item.id !== data.id), data]); msg('Timer created ✓');
  });
}
$('tm-long-set').onclick = () => createTimer('tm-long-set', { type: 'long', days: $('tm-days').value });
$('tm-date-set').onclick = () => createTimer('tm-date-set', { type: 'long', date: $('tm-date').value });
$('tm-short-start').onclick = () => createTimer('tm-short-start', { type: 'short', hours: $('tm-h').value, mins: $('tm-m').value });
$('tm-at-start').onclick = () => createTimer('tm-at-start', { type: 'short', atTime: $('tm-at').value });
for (const [id, render] of [['list', renderTodos], ['timer-list', renderTimers]]) {
  $(id).addEventListener('focusout', () => { const stamp = sessionStamp(); setTimeout(() => { if (currentSession(stamp)) render(); }, 0); });
}
setInterval(() => { if (authenticated) { tick(); if (calendar) renderCalendar(calendar); } }, 1000);
setInterval(refresh, 30000);
// Deferred list reconciliation never replaces an in-flight or focused control.
setInterval(() => { if (authenticated) { renderTodos(); renderTimers(); } }, 2000);
(async () => {
  const stamp = sessionStamp();
  try {
    const headers = getToken() ? { Authorization: 'Bearer ' + getToken() } : {};
    const me = await request('/api/me', { headers }, false);
    if (!currentSession(stamp)) return;
    if (me.needsSetup) { showScreen('setup'); return; }
    if (me.loggedIn) { await showPanel(); return; }
    showLogin();
  } catch (error) { if (currentSession(stamp)) showLogin(error.message); }
})();
