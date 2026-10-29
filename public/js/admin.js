// Checked mutations preserve drafts and keep remote updates away from active controls.
const $ = id => document.getElementById(id);
let authenticated = false, stream = null, msgTimer;
let todos = [], timers = [], clockOffsetSec = 0, calendar = null, calendarDirty = false;
const pending = new Map();
// Membership and ordering writes share one lane; item edits remain independent.
const taskListWrites = [];
const taskReservations = new Map();
let taskListWriting = false, taskListLane = 0, todoOrderVersion = 0;
let sessionGeneration = 0;
const contentResources = ['todos', 'timers', 'display', 'note', 'routines'];
let contentGeneration = 0;
let note = { text: '' }, display = {}, routines = [], noteDirty = false, displayDirty = false;
const readEpoch = { todos: 0, timers: 0, time: 0, calendar: 0, settings: 0, display: 0, note: 0, routines: 0 };
const readSequence = Object.fromEntries(Object.keys(readEpoch).map(key => [key, 0]));
// Read epochs invalidate whole-resource GETs. Only an authoritative change to the
// same item can supersede its mutation response; unrelated operations cannot.
let authorityClock = 0;
const itemVersions = { todos: new Map(), timers: new Map() };
const valueVersions = { time: 0, calendar: 0, display: 0, note: 0, routines: 0 };
function authorityVersion(resource, id) {
  return itemVersions[resource]?.get(id) || valueVersions[resource] || 0;
}
function recordAuthority(resource, id) {
  if (itemVersions[resource]) itemVersions[resource].set(id, ++authorityClock);
  else if (Object.hasOwn(valueVersions, resource)) valueVersions[resource] = ++authorityClock;
}
function recordSnapshotAuthority(resource, data) {
  if (resource === 'todos' && JSON.stringify(todos.map(item => [item.id, item.order])) !== JSON.stringify(data.map(item => [item.id, item.order]))) todoOrderVersion++;
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
function resourceFor(group) { return group.startsWith('todo:') ? 'todos' : group.startsWith('timer:') ? 'timers' : ['time', 'calendar', 'note', 'display', 'routines'].includes(group) ? group : null; }
function advanceResource(resource) {
  if (resource) readEpoch[resource]++;
}
function commitResource(resource, apply, data) { advanceResource(resource); recordSnapshotAuthority(resource, data); apply(); }
function invalidateSession() {
  sessionGeneration++; taskListLane++; taskListWriting = false;
  for (const job of taskListWrites.splice(0)) { releaseTaskReservation(job); job.resolve(); }
  authenticated = false; stream?.close(); stream = null;
  clearTimeout(msgTimer); msg('');
  for (const operation of pending.values()) operation.controls.forEach((control, i) => control.disabled = operation.previous[i]);
  pending.clear();
  todos = []; timers = []; calendar = null; note = { text: '' }; display = {}; routines = [];
  noteDirty = false; displayDirty = false; contentGeneration++; routineDrafts.clear();
  $('note-text').value = ''; $('routine-list').replaceChildren();
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
function mutate(group, controls, url, method, body, onSuccess, rollback) {
  const structural = resourceFor(group) === 'todos' && (method === 'POST' || method === 'DELETE' || body?.action === 'up' || body?.action === 'down');
  if (!structural) {
    if (taskReservations.has(group)) { rollback?.(); return Promise.resolve(); }
    return mutateNow(group, controls, url, method, body, onSuccess, rollback);
  }
  if (!authenticated || pending.has(group) || pending.has('import') || taskReservations.has(group)) return Promise.resolve();
  const stamp = sessionStamp(), contentStamp = contentGeneration;
  return new Promise(resolve => {
    const rowControls = [...document.querySelectorAll('[data-task-id]')].filter(row => row.dataset.taskId === group.slice(5)).flatMap(row => [...row.querySelectorAll('input,button,select')]);
    const reservedControls = [...new Set([...controls, ...rowControls])];
    const job = { args: [group, reservedControls, url, method, body, onSuccess, rollback], stamp, contentStamp, lane: taskListLane, resolve, previous: reservedControls.map(control => control.disabled) };
    taskReservations.set(group, job); reservedControls.forEach(control => control.disabled = true);
    taskListWrites.push(job);
    drainTaskListWrites();
  });
}
function releaseTaskReservation(job) {
  if (taskReservations.get(job.args[0]) !== job) return;
  taskReservations.delete(job.args[0]);
  job.args[1].forEach((control, i) => control.disabled = job.previous[i]);
}
function drainTaskListWrites() {
  if (taskListWriting || !taskListWrites.length) return;
  const job = taskListWrites.shift(); taskListWriting = true;
  // Transfer the reservation synchronously to mutateNow's active pending guard.
  releaseTaskReservation(job);
  const writing = currentSession(job.stamp) && job.contentStamp === contentGeneration ? mutateNow(...job.args) : Promise.resolve();
  const finish = () => { job.resolve(); if (job.lane === taskListLane) { taskListWriting = false; drainTaskListWrites(); } };
  Promise.resolve(writing).then(finish, finish);
}
async function mutateNow(group, controls, url, method, body, onSuccess, rollback) {
  if (pending.has(group) || pending.has('import') || !authenticated) { if (group === 'routines') rollback?.(); return; }
  const stamp = sessionStamp(), resource = resourceFor(group);
  // All routine actions share one pending group. Lock every covered action;
  // text draft fields remain available unless part of the submitted editor.
  if (resource === 'routines') controls = [...new Set([...controls, ...document.querySelectorAll('#routine-list button, #routine-list select, #routine-list input[type="checkbox"], #routine-add, #routine-repeat')])];
  advanceResource(resource);
  if (resource === 'calendar') advanceResource('settings');
  const beganAt = authorityClock, contentStamp = contentGeneration;
  const operation = { controls, previous: controls.map(control => control.disabled), orderVersion: todoOrderVersion };
  pending.set(group, operation);
  controls.forEach(control => control.disabled = true);
  msg('Saving…');
  try {
    const data = await request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!currentSession(stamp) || contentStamp !== contentGeneration) return;
    const id = itemVersions[resource] ? (method === 'POST' ? data.id : group.slice(group.indexOf(':') + 1)) : null;
    const apply = authorityVersion(resource, id) <= beganAt;
    if (apply) { advanceResource(resource); recordAuthority(resource, id); }
    onSuccess?.(data, apply, operation);
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
      renderTodos(); renderTimers(); renderRoutines();
    }
  }
}
async function refresh() {
  if (!authenticated) return;
  const stamp = sessionStamp();
  async function read(resource, url, apply, protect = true) {
    const revision = readEpoch[resource], sequence = ++readSequence[resource];
    const current = () => currentSession(stamp) && authenticated && readEpoch[resource] === revision && readSequence[resource] === sequence && !pending.has('import') && ![...pending.keys()].some(group => resourceFor(group) === resource || resource === 'settings' && group === 'calendar');
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
    read('calendar', '/api/calendar', renderCalendar, false),
    read('note', '/api/note', renderNote),
    read('display', '/api/display', renderDisplay),
    read('routines', '/api/routines', renderRoutines)
  ]);
}
function safeToRender(list, group) {
  return !(list.id === 'list' && taskListWrites.length) && !list.querySelector('[data-editing]') && !list.contains(document.activeElement) && ![...pending.keys()].some(key => key.startsWith(group));
}
function renderTodos(list = todos) {
  todos = list;
  const ul = $('list');
  renderMissedTasks();
  if (!safeToRender(ul, 'todo:')) return;
  ul.replaceChildren();
  if (!list.length) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = 'No tasks yet'; ul.append(li); }
  for (const task of list) {
    const li = document.createElement('li'); li.dataset.taskId = task.id; li.classList.toggle('done', !!task.done);
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!task.done; cb.setAttribute('aria-label', 'Mark ' + task.text + ' done');
    const text = document.createElement('span'); text.className = 'grow'; text.textContent = task.text;
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete task ' + task.text);
    const update = (data, apply) => { if (apply) { renderTodos(todos.map(item => item.id === task.id ? { ...data, order: item.order } : item)); li.classList.toggle('done', !!data.done); } msg('Task updated ✓'); };
    cb.onchange = () => mutate('todo:' + task.id, [...li.querySelectorAll('input,button,select')], '/api/todos/' + task.id, 'PATCH', { done: cb.checked }, update, () => cb.checked = !!(todos.find(item => item.id === task.id) || task).done);
    del.onclick = () => { if (!confirm(`Delete task "${task.text}"?`)) return; return mutate('todo:' + task.id, [...li.querySelectorAll('input,button,select')], '/api/todos/' + task.id, 'DELETE', undefined, (data, apply) => { if (apply) { renderTodos(todos.filter(item => item.id !== task.id)); li.remove(); } msg('Task deleted ✓'); }) };
    const detail = document.createElement('small'); detail.className = 'sub2';
    detail.textContent = `${(task.priority || 'normal').toUpperCase()} priority${task.dueAt ? ' · ' + dateTimeText(task.dueAt) : ''}${task.repeat && task.repeat !== 'none' ? ' · repeats ' + task.repeat : ''}`; text.append(detail);
    const actions = taskActions(task, li, text, cb, del);
    li.append(cb, text, actions, del); ul.append(li);
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
    cb.onchange = () => mutate('timer:' + timer.id, [...li.querySelectorAll('input,button')], '/api/timers/' + timer.id, 'PATCH', { done: cb.checked }, update, () => cb.checked = !!(timers.find(item => item.id === timer.id) || timer).done);
    color.onchange = () => mutate('timer:' + timer.id, [...li.querySelectorAll('input,button')], '/api/timers/' + timer.id, 'PATCH', { color: color.value }, update, () => color.value = (timers.find(item => item.id === timer.id) || timer).color || confirmedColor);
    del.onclick = () => { if (!confirm(`Delete timer "${timer.name}"?`)) return; return mutate('timer:' + timer.id, [...li.querySelectorAll('input,button')], '/api/timers/' + timer.id, 'DELETE', undefined, (data, apply) => { if (apply) { renderTimers(timers.filter(item => item.id !== timer.id)); li.remove(); } msg('Timer deleted ✓'); }) };
    const actions = timerActions(timer, li, text);
    li.append(cb, text, tag, actions, color, del); ul.append(li);
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
    for (const [resource, render] of Object.entries({ note: renderNote, display: renderDisplay, routines: renderRoutines })) if (snapshot[resource] !== undefined) commitResource(resource, () => render(snapshot[resource]), snapshot[resource]);
  });
  for (const [resource, render] of Object.entries({ todos: renderTodos, timers: renderTimers, time: renderTime, calendar: renderCalendar, note: renderNote, display: renderDisplay, routines: renderRoutines })) listen(resource, data => commitResource(resource, () => render(data), data));
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
  const repeat = $('todo-repeat').value;
  const body = { text: draft, repeat, priority: $('todo-priority').value, dueAt: repeat === 'none' ? $('todo-due-date').value || null : null, dueTime: repeat === 'none' ? null : $('todo-due-time').value || null, dueWeekday: Number($('todo-weekday').value) };
  return mutate('todo:add', [$('todo-add')], '/api/todos', 'POST', body, (data, apply) => {
    if ($('todo-text').value === draft) $('todo-text').value = '';
    if (apply) { renderTodos([...todos.filter(item => item.id !== data.id), data].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))); todoOrderVersion++; } msg('Added ✓');
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
$('tm-long-set').onclick = () => createTimer('tm-long-set', $('tm-long-method').value === 'days' ? { type: 'long', days: $('tm-days').value } : { type: 'long', date: $('tm-date').value ? $('tm-date').value + 'T23:59:59' : '' });
$('tm-date-set').onclick = () => createTimer('tm-date-set', { type: 'long', date: $('tm-date').value ? $('tm-date').value + 'T23:59:59' : '' });
$('tm-short-start').onclick = () => createTimer('tm-short-start', $('tm-short-method').value === 'duration' ? { type: 'short', hours: $('tm-h').value, mins: $('tm-m').value } : { type: 'short', atTime: $('tm-at').value });
$('tm-at-start').onclick = () => createTimer('tm-at-start', { type: 'short', atTime: $('tm-at').value });
for (const [id, render] of [['list', renderTodos], ['timer-list', renderTimers], ['routine-list', renderRoutines]]) {
  $(id).addEventListener('focusout', () => { const stamp = sessionStamp(); setTimeout(() => { if (currentSession(stamp)) render(); }, 0); });
}
setInterval(() => { if (authenticated) { tick(); if (calendar) renderCalendar(calendar); } }, 1000);
setInterval(refresh, 30000);
// Deferred list reconciliation never replaces an in-flight or focused control.
setInterval(() => { if (authenticated) { renderTodos(); renderTimers(); renderRoutines(); } }, 2000);
// Feature controls share the checked request, session, and resource cache boundary.
function actionButton(text, label, onclick, className = 'ghost') {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
  button.setAttribute('aria-label', label); button.className = className; button.onclick = onclick; return button;
}
function dateTimeText(ms) { return `${DashboardTime.date(ms)} ${DashboardTime.time(ms)} · ${DashboardTime.zone}`; }
function localInputValue(ms) {
  const p = DashboardTime.parts(ms), hour = Number(p.hour) % 12 + (p.dayPeriod === 'PM' ? 12 : 0);
  return `${DashboardTime.day(ms)}T${String(hour).padStart(2, '0')}:${p.minute}`;
}
const adminGrid = document.querySelector('#panel .grid'), adminCards = [...adminGrid.children];
const adminColumns = ['left', 'right'].map(() => { const el = document.createElement('div'); el.className = 'admin-column'; return el; });
const adminDesktop = matchMedia('(min-width: 861px)');
function arrangeAdminCards() {
  if (adminDesktop.matches) { adminGrid.replaceChildren(...adminColumns); adminCards.forEach(card => adminColumns[card.dataset.column === 'left' ? 0 : 1].append(card)); }
  else adminGrid.replaceChildren(...adminCards);
}
adminDesktop.addEventListener?.('change', arrangeAdminCards); arrangeAdminCards();
function editRow(row, fields, saveAction, cancelAction) {
  row.dataset.editing = 'true';
  const editor = document.createElement('div'); editor.className = 'row'; editor.style.width = '100%';
  const controls = [];
  for (const [label, field] of fields) { const wrapper = document.createElement('label'); wrapper.className = 'field'; wrapper.textContent = label; wrapper.append(field); editor.append(wrapper); controls.push(field); }
  const cancel = () => { delete row.dataset.editing; editor.remove(); cancelAction(); };
  const save = actionButton('Save', 'Save changes', () => saveAction([...controls, save, cancelButton], cancel));
  const cancelButton = actionButton('Cancel', 'Cancel editing', cancel);
  editor.append(save, cancelButton); row.append(editor); controls[0]?.focus();
}
function field(type, value, max) { const input = document.createElement('input'); input.type = type; input.value = value || ''; if (max) input.maxLength = max; return input; }
function select(values, value, label) { const el = document.createElement('select'); el.setAttribute('aria-label', label); values.forEach(([key, text]) => el.add(new Option(text, key))); el.value = value; return el; }
function updateTask(task, body, controls = [], done) {
  return mutate('todo:' + task.id, controls, '/api/todos/' + task.id, 'PATCH', body, (data, apply, operation) => {
    const ordering = body.action === 'up' || body.action === 'down';
    if (apply && (!ordering || operation.orderVersion === todoOrderVersion)) {
      if (ordering) {
        // A serialized move response supplies its persisted absolute position.
        const next = todos.filter(item => item.id !== task.id);
        next.splice(Math.max(0, Math.min(next.length, data.order)), 0, data);
        todos = next.map((item, order) => ({ ...item, order })); todoOrderVersion++;
      } else todos = todos.map(item => item.id === task.id ? { ...data, order: item.order } : item);
    }
    done?.(); renderTodos(); msg('Task updated ✓');
  });
}
function taskActions(task, li, text, cb, del) {
  const actions = document.createElement('div'); actions.className = 'item-actions';
  const up = actionButton('↑', `Move ${task.text} up`, () => updateTask(task, { action: 'up' }, [...li.querySelectorAll('button,input,select')]));
  const down = actionButton('↓', `Move ${task.text} down`, () => updateTask(task, { action: 'down' }, [...li.querySelectorAll('button,input,select')]));
  up.disabled = todos[0]?.id === task.id; down.disabled = todos.at(-1)?.id === task.id;
  const edit = actionButton('Edit', `Edit ${task.text}`, () => {
    if (li.dataset.editing) return; const input = field('text', task.text, 200);
    editRow(li, [['Task text', input]], (controls, done) => input.value.trim() ? updateTask(task, { text: input.value }, controls, done) : msg('Task cannot be empty'), renderTodos);
  });
  const repeat = select([['none', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly']], task.repeat || 'none', `Repeat ${task.text}`);
  repeat.onchange = () => updateTask(task, { repeat: repeat.value, dueAt: null, dueTime: null }, [repeat]).then(() => repeat.value = (todos.find(item => item.id === task.id) || task).repeat || 'none');
  const schedule = actionButton('Schedule', `Edit priority and due time for ${task.text}`, () => {
    if (li.dataset.editing) return;
    const recurring = task.repeat && task.repeat !== 'none';
    const priority = select([['normal', 'Normal'], ['high', 'High'], ['low', 'Low']], task.priority || 'normal', 'Priority');
    const due = field(recurring ? 'time' : 'datetime-local', recurring ? task.dueTime : task.dueAt ? localInputValue(task.dueAt) : '');
    const weekday = select(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((day, i) => [String(i), day]), String(task.dueWeekday || 0), 'Day of week');
    const fields = [['Priority', priority], [`Due time (${DashboardTime.zone})`, due]]; if (task.repeat === 'weekly') fields.push(['Day of week', weekday]);
    editRow(li, fields, (controls, done) => updateTask(task, { priority: priority.value, dueWeekday: Number(weekday.value), ...(recurring ? { dueTime: due.value || null } : { dueAt: due.value || null }) }, controls, done), renderTodos);
  });
  actions.append(up, down, edit, schedule, repeat); return actions;
}
function renderMissedTasks() {
  const missed = todos.filter(task => !task.done && (!task.repeat || task.repeat === 'none') && task.dueAt && task.dueAt < DashboardTime.now());
  $('missed-tasks').hidden = !missed.length;
  const list = $('missed-list'); if (!safeToRender(list, 'todo:')) return; list.replaceChildren();
  missed.forEach(task => {
    const li = document.createElement('li'), name = document.createElement('span'); li.dataset.taskId = task.id; name.className = 'grow'; name.textContent = `${task.text} · Was due ${dateTimeText(task.dueAt)}`;
    const buttons = document.createElement('div'); buttons.className = 'item-actions';
    for (const [label, body] of [['Today', { action: 'moveToday' }], ['Tomorrow · 9 AM', { action: 'moveTomorrow' }], ['Done', { done: true }]]) {
      const button = actionButton(label, `${label} ${task.text}`, () => updateTask(task, body, [...buttons.children])); buttons.append(button);
    }
    li.append(name, buttons); list.append(li);
  });
}
function timerActions(timer, li, text) {
  const box = document.createElement('div'); box.className = 'item-actions';
  const update = (body, controls, done) => mutate('timer:' + timer.id, controls, '/api/timers/' + timer.id, 'PATCH', body, (data, apply) => {
    if (apply) timers = timers.map(item => item.id === timer.id ? data : item); done?.(); renderTimers(); msg('Timer updated ✓');
  });
  const paused = timer.pausedLeftSec != null;
  const pause = actionButton(paused ? 'Resume' : 'Pause', `${paused ? 'Resume' : 'Pause'} ${timer.name}`, () => update({ action: paused ? 'resume' : 'pause' }, [...li.querySelectorAll('input,button')]));
  pause.disabled = timer.done || (!timer.targetAt && !paused);
  const edit = actionButton('Edit', `Edit ${timer.name}`, () => {
    if (li.dataset.editing) return;
    const name = field('text', timer.name, 60), end = field('datetime-local', timer.targetAt ? localInputValue(timer.targetAt) : '');
    editRow(li, [['Timer name', name], [`End time (${DashboardTime.zone})`, end]], (controls, done) => {
      if (!name.value.trim()) return msg('Timer name cannot be empty');
      return update({ name: name.value.trim(), ...(end.value ? { targetAt: end.value } : {}) }, controls, done);
    }, renderTimers);
  });
  const restart = actionButton('Restart', `Restart ${timer.name}`, () => update({ targetAt: DashboardTime.now() + timer.durationSec * 1000 }, [...li.querySelectorAll('input,button')]));
  restart.hidden = timer.type !== 'short' || !timer.durationSec || timer.targetAt > DashboardTime.now() && !timer.done;
  box.append(pause, edit, restart); return box;
}
function showTodoDueFields() {
  const repeat = $('todo-repeat').value;
  $('todo-date-wrap').hidden = repeat !== 'none'; $('todo-time-wrap').hidden = repeat === 'none'; $('todo-weekday-wrap').hidden = repeat !== 'weekly';
}
$('todo-repeat').onchange = showTodoDueFields; showTodoDueFields();
function renderNote(data = note) { note = data || { text: '' }; if (!noteDirty && document.activeElement !== $('note-text')) $('note-text').value = note.text || ''; }
$('note-text').addEventListener('input', () => noteDirty = true);
function saveNote(clear) {
  const draft = $('note-text').value, text = clear ? '' : draft;
  return mutate('note', [$('note-save'), $('note-clear')], '/api/note', 'POST', { text }, (data, apply) => {
    if (apply) note = data;
    if ($('note-text').value === draft) { noteDirty = false; $('note-text').value = note.text || ''; } msg('Note saved ✓');
  });
}
$('note-save').onclick = () => saveNote(false); $('note-clear').onclick = () => saveNote(true);
const displayFields = { 'display-mode': 'mode', 'display-text': 'textSize', 'quiet-start': 'quietStart', 'quiet-end': 'quietEnd', 'empty-msg': 'emptyMsg', 'show-calendar': 'showCalendar', 'show-todos': 'showTodos', 'show-timers': 'showTimers', 'show-pc': 'showPC', 'display-privacy': 'privacy', 'quiet-enabled': 'quietEnabled' };
function displayDraft() { return Object.fromEntries(Object.entries(displayFields).map(([id,key]) => [key, $(id).type === 'checkbox' ? $(id).checked : $(id).value])); }
function renderDisplay(data = display) {
  display = data || {}; if (displayDirty || document.querySelector('#sec-display input:focus,#sec-display select:focus,#sec-display textarea:focus')) return;
  for (const [id,key] of Object.entries(displayFields)) if (display[key] !== undefined) { if ($(id).type === 'checkbox') $(id).checked = display[key]; else $(id).value = display[key]; }
}
for (const id of Object.keys(displayFields)) for (const event of ['input', 'change']) $(id).addEventListener(event, () => displayDirty = true);
$('display-save').onclick = () => {
  const body = displayDraft();
  return mutate('display', [$('display-save')], '/api/display', 'POST', body, (data, apply) => {
    if (apply) display = data;
    if (JSON.stringify(displayDraft()) === JSON.stringify(body)) { displayDirty = false; renderDisplay(); } msg('Display settings saved ✓');
  });
};
const routineDrafts = new Map();
function routinePeriod(repeat) {
  const day = DashboardTime.day(DashboardTime.now()); if (repeat !== 'weekly') return day;
  const monday = new Date(day + 'T12:00:00Z'); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7); return monday.toISOString().slice(0, 10);
}
function renderRoutines(data = routines) {
  routines = (data || []).map(routine => ({ ...routine, items: routine.items.map(item => ({ ...item, done: typeof item.done === 'boolean' ? item.done : item.doneOn === routinePeriod(routine.repeat) })) })); const box = $('routine-list'); if (!safeToRender(box, 'routines') || box.querySelector('[data-editing]')) return;
  box.replaceChildren();
  if (!routines.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No routines yet'; box.append(empty); }
  routines.forEach(routine => {
    const section = document.createElement('div'); section.className = 'routine-editor';
    const title = document.createElement('strong'); title.textContent = `${routine.name} · ${routine.items.filter(item => item.done).length}/${routine.items.length} · ${routine.repeat}`;
    const change = (url, method, body, controls, apply, rollback, acknowledge) => mutate('routines', controls, url, method, body, (data, current) => { if (current) apply(data); acknowledge?.(); msg('Routine updated ✓'); }, rollback);
    const rename = actionButton('Rename', `Rename ${routine.name}`, () => {
      const value = field('text', routine.name, 80);
      editRow(section, [['Routine name', value]], (controls, done) => {
        const submitted = value.value; if (!submitted.trim()) return msg('Name required');
        return change(`/api/routines/${routine.id}`, 'PATCH', { name: submitted }, controls,
          data => routines = routines.map(item => item.id === routine.id ? data : item), undefined,
          () => { if (value.value === submitted) done(); });
      }, renderRoutines);
    });
    const repeat = select([['daily','Daily'],['weekly','Weekly']], routine.repeat, `Repeat ${routine.name}`);
    repeat.onchange = () => change(`/api/routines/${routine.id}`, 'PATCH', { repeat: repeat.value }, [repeat], data => routines = routines.map(item => item.id === routine.id ? data : item), () => repeat.value = (routines.find(item => item.id === routine.id) || routine).repeat);
    const remove = actionButton('Delete', `Delete ${routine.name}`, () => {
      if (!confirm(`Delete routine "${routine.name}"?`)) return;
      return change(`/api/routines/${routine.id}`, 'DELETE', undefined, [remove], () => routines = routines.filter(item => item.id !== routine.id));
    }, 'danger');
    const head = document.createElement('div'); head.className = 'row'; head.append(title, rename, repeat, remove); section.append(head);
    const list = document.createElement('ul'); list.className = 'items';
    const replaceItem = data => routines = routines.map(value => value.id === routine.id ? { ...value, items: value.items.map(item => item.id === data.id ? data : item) } : value);
    routine.items.forEach(item => {
      const row = document.createElement('li'), check = field('checkbox'); check.checked = !!item.done; check.setAttribute('aria-label', `Complete ${item.text}`);
      const label = document.createElement('span'); label.className = 'grow'; label.textContent = item.text;
      check.onchange = () => { const done = check.checked; return change(`/api/routines/${routine.id}/items/${item.id}`, 'PATCH', { done }, [check], data => replaceItem({ ...data, done }), () => check.checked = !!routines.find(value => value.id === routine.id)?.items.find(value => value.id === item.id)?.done); };
      const edit = actionButton('Edit', `Edit ${item.text}`, () => {
        const input = field('text', item.text, 120);
        editRow(row, [['Step', input]], (controls, done) => {
          const submitted = input.value; if (!submitted.trim()) return msg('Step required');
          return change(`/api/routines/${routine.id}/items/${item.id}`, 'PATCH', { text: submitted }, controls,
            replaceItem, undefined, () => { if (input.value === submitted) done(); });
        }, renderRoutines);
      });
      const del = actionButton('×', `Delete ${item.text}`, () => change(`/api/routines/${routine.id}/items/${item.id}`, 'DELETE', undefined, [del], () => routines = routines.map(value => value.id === routine.id ? { ...value, items: value.items.filter(value => value.id !== item.id) } : value)), 'danger');
      row.append(check, label, edit, del); list.append(row);
    });
    section.append(list);
    const entry = field('text', routineDrafts.get(routine.id), 120); entry.placeholder = 'Add a step'; entry.setAttribute('aria-label', `New step for ${routine.name}`);
    entry.oninput = () => routineDrafts.set(routine.id, entry.value);
    const add = actionButton('Add step', `Add step to ${routine.name}`, () => {
      const draft = entry.value; if (!draft.trim()) return;
      return change(`/api/routines/${routine.id}/items`, 'POST', { text: draft }, [add], data => {
        routines = routines.map(value => value.id === routine.id ? { ...value, items: [...value.items, data] } : value);
      }, undefined, () => {
        if (entry.value === draft) { entry.value = ''; if (routineDrafts.get(routine.id) === draft) routineDrafts.delete(routine.id); }
      });
    });
    entry.onkeydown = event => { if (event.key === 'Enter') add.onclick(); };
    const foot = document.createElement('div'); foot.className = 'row'; foot.append(entry, add); section.append(foot); box.append(section);
  });
}
$('routine-add').onclick = () => {
  const name = $('routine-name').value; if (!name.trim()) return msg('Enter a routine name');
  return mutate('routines', [$('routine-add')], '/api/routines', 'POST', { name, repeat: $('routine-repeat').value }, (data, apply) => {
    if (apply) routines = [...routines, data]; if ($('routine-name').value === name) $('routine-name').value = ''; msg('Routine added ✓');
  });
};
$('routine-name').onkeydown = event => { if (event.key === 'Enter') $('routine-add').onclick(); };
$('alarm-test').onclick = async () => {
  const button = $('alarm-test'), stamp = sessionStamp(); if (button.disabled) return; button.disabled = true;
  let audio;
  try { audio = new Audio('/audio/alarm.mp3'); await audio.play(); if (currentSession(stamp)) msg('Playing alarm ✓'); setTimeout(() => { audio.pause(); audio.currentTime = 0; }, 2500); }
  catch {
    try { const Context = window.AudioContext || window.webkitAudioContext; const context = new Context(); await context.resume();
      if (!currentSession(stamp)) { await context.close(); return; }
      const tone = context.createOscillator(), gain = context.createGain(); tone.frequency.value = 880; gain.gain.value = 0.12; tone.connect(gain).connect(context.destination);
      tone.start(); tone.stop(context.currentTime + .4); tone.onended = () => context.close(); msg('Playing built-in chime ✓');
    } catch { if (currentSession(stamp)) msg('Sound unavailable — tap Test sound to retry'); }
  } finally { if (!currentSession(stamp)) audio?.pause(); button.disabled = false; }
};
function updateTimerMethods() {
  const days = $('tm-long-method').value === 'days', duration = $('tm-short-method').value === 'duration';
  $('long-days-row').hidden = !days; $('long-date-row').hidden = days; $('short-duration-row').hidden = !duration; $('short-time-row').hidden = duration;
  updateTimerPreview();
}
function updateTimerPreview() {
  const long = $('tm-long-method').value === 'days' ? Number($('tm-days').value) > 0 ? dateTimeText(DashboardTime.now() + Number($('tm-days').value) * 86400000) : '' : $('tm-date').value ? `${$('tm-date').value} 11:59:59 PM · ${DashboardTime.zone}` : '';
  const mins = Number($('tm-h').value) * 60 + Number($('tm-m').value);
  $('long-preview').textContent = long ? 'Ends ' + long : 'Choose a future end date.';
  $('short-preview').textContent = $('tm-short-method').value === 'duration' ? mins > 0 ? 'Ends ' + dateTimeText(DashboardTime.now() + mins * 60000) : 'Choose a duration.' : $('tm-at').value ? `Next ${$('tm-at').value} · ${DashboardTime.zone}` : 'Choose a clock time.';
}
$('tm-long-method').onchange = updateTimerMethods; $('tm-short-method').onchange = updateTimerMethods;
for (const id of ['tm-days','tm-date','tm-h','tm-m','tm-at']) $(id).addEventListener('input', updateTimerPreview);
for (const button of document.querySelectorAll('.preset')) button.onclick = () => { const mins = Number(button.dataset.minutes); $('tm-h').value = Math.floor(mins / 60); $('tm-m').value = mins % 60; updateTimerPreview(); };
updateTimerMethods();
$('export-btn').onclick = () => mutate('export', [$('export-btn')], '/api/export', 'GET', undefined, data => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'tablet-dashboard-export.json'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); msg('Export downloaded ✓');
});
$('import-btn').onclick = () => { if (!pending.has('import')) $('import-file').click(); };
$('import-file').onchange = async () => {
  const file = $('import-file').files[0], stamp = sessionStamp(); if (!file || !authenticated || pending.has('import')) return;
  try {
    if (file.size > 256 * 1024) throw new Error('Export file is too large');
    const data = JSON.parse(await file.text()); assertSession(stamp);
    if (taskListWriting || taskReservations.size || [...pending.keys()].some(group => contentResources.includes(resourceFor(group)))) throw new Error('Wait for current saves to finish, then import again');
    if (!confirm('Replace current tasks, timers, note, routines, and display settings with this export?')) return;
    const controls = [...document.querySelectorAll('#panel button,#panel input,#panel select,#panel textarea')], previous = controls.map(el => el.disabled);
    pending.set('import', { controls, previous }); controls.forEach(el => el.disabled = true);
    contentGeneration++; contentResources.forEach(advanceResource);
    try {
      await request('/api/import', { method: 'POST', body: JSON.stringify(data) }); assertSession(stamp);
      noteDirty = false; displayDirty = false; routineDrafts.clear();
      $('list').replaceChildren(); $('timer-list').replaceChildren(); $('routine-list').replaceChildren();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      contentResources.forEach(advanceResource); pending.delete('import'); await refresh(); msg('Data imported ✓');
    } finally {
      if (currentSession(stamp)) { pending.delete('import'); controls.forEach((el, i) => el.disabled = previous[i]); contentResources.forEach(advanceResource); }
    }
  } catch (error) { if (currentSession(stamp)) msg(error instanceof SyntaxError ? 'Invalid JSON export' : error.message); }
  finally { if (currentSession(stamp)) $('import-file').value = ''; }
};

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
