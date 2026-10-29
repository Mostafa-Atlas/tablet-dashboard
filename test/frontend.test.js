const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const NOW = Date.parse('2026-10-27T10:00:00Z');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function reply(data, status = 200) { return { ok: status < 400, status, json: async () => data }; }
async function page(kind, overrides = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public', kind === 'admin' ? 'admin.html' : 'index.html'), 'utf8'), { url: 'http://dashboard.test', runScripts: 'outside-only' });
  const w = dom.window; const intervals = []; const streams = []; let now = NOW;
  w.Date.now = () => now;
  w.matchMedia = () => ({ matches: true, addEventListener() {} });
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.play = async function () {};
  w.confirm = () => true;
  w.setInterval = (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; };
  w.EventSource = class { constructor() { this.listeners = {}; streams.push(this); } addEventListener(name, fn) { this.listeners[name] = fn; } close() {} };
  const snapshot = { now: NOW, display: { mode: 'overview', showPC: true, showTodos: true, showCalendar: true, showTimers: true }, note: { text: 'Saved note' }, routines: [], media: null, timeZone: 'Africa/Cairo', pc: { cpu: null, gpu: null, ram: 0, cpuTemp: null, gpuTemp: null, disks: [], updatedAt: NOW }, time: { offsetSec: 0 }, timers: [{ id: 'a', name: 'Tea', type: 'short', targetAt: NOW + 65000, durationSec: 65, color: '#123456', done: false }], todos: [{ id: 'b', text: 'Read', done: false }], weather: { temp: 25, label: 'Clear', updatedAt: NOW }, calendar: { configured: true, updatedAt: NOW, upcoming: [], next: null } };
  const state = { snapshot, handlers: overrides, requests: [] };
  w.fetch = async (url, opts = {}) => {
    state.requests.push({ url, ...opts });
    if (state.handlers[url]) return state.handlers[url](opts);
    if (url === '/api/me') return reply({ loggedIn: true, needsSetup: false });
    if (url === '/api/snapshot') return reply(snapshot);
    if (url === '/api/time') return reply({ ...snapshot.time, timeZone: snapshot.timeZone, dashboardNow: now + snapshot.time.offsetSec * 1000 });
    if (url === '/api/settings') return reply({ icsUrl: 'https://calendar.invalid/test.ics' });
    const key = url.replace('/api/', '');
    if (Object.hasOwn(snapshot, key)) return reply(snapshot[key]);
    throw new Error('Unexpected request: ' + url);
  };
  w.localStorage.setItem('admin_token', 'test-token');
  w.eval([...w.document.querySelectorAll('script[src]')].map(script => fs.readFileSync(path.join(__dirname, '../public', script.getAttribute('src')), 'utf8')).join('\n')); 
  await flush();
  const emit = async (name, data) => { for (const stream of streams) stream.listeners[name]?.({ data: JSON.stringify(data) }); await flush(); };
  // SSE comments keep the HTTP stream open but EventSource never dispatches them.
  const receiveSSE = async wire => {
    for (const frame of wire.split('\n\n')) {
      const lines = frame.split('\n'), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
      if (!data.length) continue;
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
      for (const stream of streams) stream.listeners[event]?.({ data: data.join('\n') });
    }
    await flush();
  };
  return { w, dom, state, receiveSSE, poll: () => intervals.find(interval => interval.delay === 30000).fn(), $: id => w.document.getElementById(id), advance: async ms => { now += ms; for (const { fn } of [...intervals]) await fn(); await flush(); }, emit };
}

test('quiet SSE comment heartbeats stay connected beyond 45 seconds and errors reconnect', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('open');
  await p.advance(25000); await p.receiveSSE(': heartbeat\n\n');
  await p.advance(25000); await p.receiveSSE(': heartbeat\n\n');
  assert.equal(p.$('server-state').textContent, 'DASHBOARD LIVE', 'a quiet open stream is healthy without dispatched heartbeat events');
  await p.receiveSSE('event: pc\ndata: ' + JSON.stringify({ ...p.state.snapshot.pc, updatedAt: NOW + 50000 }) + '\n\n');
  await p.advance(5000);
  assert.equal(p.$('server-state').textContent, 'DASHBOARD LIVE');
  assert.equal(p.$('pc-state').textContent, 'PC ONLINE');
  await p.emit('error'); assert.equal(p.$('server-state').textContent, 'RECONNECTING');
  await p.advance(50000); assert.equal(p.$('server-state').textContent, 'RECONNECTING');
  await p.emit('open'); assert.equal(p.$('server-state').textContent, 'DASHBOARD LIVE');
});

test('routine save disables every shared action and restores a rejected second checkbox', async t => {
  const initial = { id: 'r', name: 'Morning', repeat: 'daily', items: [{ id: 'one', text: 'First', done: false }, { id: 'two', text: 'Second', done: false }] };
  const p = await page('admin', { '/api/routines': () => reply([initial]) }); t.after(() => p.dom.window.close());
  const response = deferred(); p.state.handlers['/api/routines/r/items/one'] = () => response.promise;
  const first = p.$('routine-list').querySelector('input[aria-label="Complete First"]');
  const second = p.$('routine-list').querySelector('input[aria-label="Complete Second"]');
  const remove = p.$('routine-list').querySelector('button[aria-label="Delete Morning"]');
  first.checked = true; const saving = first.onchange();
  assert.equal(second.disabled, true); assert.equal(remove.disabled, true); assert.equal(p.$('routine-add').disabled, true);
  second.click(); assert.equal(second.checked, false, 'disabled rapid click cannot look accepted');
  second.focus(); second.checked = true; await second.onchange();
  assert.equal(second.checked, false, 'even a stale queued change callback must restore the confirmed value');
  remove.click();
  assert.equal(p.state.requests.filter(request => request.method === 'PATCH' || request.method === 'DELETE').length, 1);
  await p.emit('routines', [{ ...initial, items: [{ ...initial.items[0], done: true }, initial.items[1]] }]);
  response.resolve(reply({ ...initial.items[0], done: true })); await saving;
  p.w.document.activeElement.blur(); await flush();
  const confirmed = p.$('routine-list').querySelectorAll('input[type=checkbox]');
  assert.equal(confirmed[0].checked, true); assert.equal(confirmed[1].checked, false); assert.equal(confirmed[1].disabled, false);
  p.state.handlers['/api/routines/r/items/two'] = () => reply({ ...initial.items[1], done: true });
  confirmed[1].checked = true; await confirmed[1].onchange();
  assert.equal(p.state.requests.filter(request => request.url === '/api/routines/r/items/two' && request.method === 'PATCH').length, 1);
});

test('created tasks reconcile persisted order and move boundaries without SSE', async t => {
  const initial = [{ id: 'a', text: 'Alpha', order: 0 }, { id: 'b', text: 'Bravo', order: 1 }];
  const created = { id: 'c', text: 'Charlie', order: -1 };
  const p = await page('admin', { '/api/todos': opts => reply(opts.method === 'POST' ? created : initial) }); t.after(() => p.dom.window.close());
  const names = () => [...p.$('list').querySelectorAll('li > .grow')].map(el => el.firstChild.textContent);
  p.$('todo-text').value = 'Charlie'; await p.$('todo-add').onclick();
  assert.deepEqual(names(), ['Charlie', 'Alpha', 'Bravo']);
  assert.equal(p.$('list').querySelector('button[aria-label="Move Charlie up"]').disabled, true);
  assert.equal(p.$('list').querySelector('button[aria-label="Move Charlie down"]').disabled, false);
  assert.equal(p.$('list').querySelector('button[aria-label="Move Bravo down"]').disabled, true);
  p.state.handlers['/api/todos/b'] = () => reply({ ...initial[1], order: 1 });
  await p.$('list').querySelector('button[aria-label="Move Bravo up"]').onclick();
  assert.deepEqual(names(), ['Charlie', 'Bravo', 'Alpha']);
  assert.equal(p.$('list').querySelector('button[aria-label="Move Alpha down"]').disabled, true);
});

for (const editing of ['checkbox', 'text']) test(`task ${editing} response after a move preserves ordering through another create`, async t => {
  const initial = [{ id: 'a', text: 'Alpha', order: 0 }, { id: 'b', text: 'Bravo', order: 1 }, { id: 'c', text: 'Charlie', order: 2 }];
  const created = { id: 'd', text: 'Delta', order: -1 };
  const p = await page('admin', { '/api/todos': opts => reply(opts.method === 'POST' ? created : initial) }); t.after(() => p.dom.window.close());
  const edit = deferred(), move = deferred(); p.state.handlers['/api/todos/a'] = () => edit.promise; p.state.handlers['/api/todos/b'] = () => move.promise;
  p.state.handlers['/api/todos/c'] = () => reply({ ...initial[2], order: 1 });
  const moving = p.$('list').querySelector('button[aria-label="Move Bravo up"]').onclick();
  const queued = p.$('list').querySelector('button[aria-label="Move Charlie up"]').onclick();
  let editingTask;
  if (editing === 'checkbox') {
    const check = p.$('list').querySelector('input[type=checkbox]'); check.checked = true; editingTask = check.onchange();
  } else {
    p.$('list').querySelector('button[aria-label="Edit Alpha"]').onclick();
    const editor = p.$('list').querySelector('[data-editing]'); editor.querySelector('label input').value = 'Alpha edited';
    editingTask = editor.querySelector('button[aria-label="Save changes"]').onclick();
  }
  move.resolve(reply({ ...initial[1], order: 0 })); await Promise.all([moving, queued]);
  edit.resolve(reply({ ...initial[0], ...(editing === 'checkbox' ? { done: true } : { text: 'Alpha edited' }) })); await editingTask;
  p.w.document.activeElement.blur(); await flush();
  p.$('todo-text').value = 'Delta'; await p.$('todo-add').onclick();
  assert.deepEqual([...p.$('list').querySelectorAll('li > .grow')].map(el => el.firstChild.textContent), ['Delta', 'Bravo', 'Charlie', editing === 'checkbox' ? 'Alpha' : 'Alpha edited']);
  if (editing === 'checkbox') assert.equal(p.$('list').querySelectorAll('input[type=checkbox]')[3].checked, true);
  assert.equal(p.$('list').querySelector('button[aria-label="Move Delta up"]').disabled, true);
});

test('PC samples age without SSE and null readings stay unavailable while zero stays zero', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  assert.match(p.$('cpu-v').textContent, /unavailable|—/i);
  assert.equal(p.$('ram-v').textContent, '0%');
  await p.advance(12000);
  assert.match(p.$('pc-state').textContent, /stale/i);
  assert.match(p.$('pc-age').textContent, /12s/);
  await p.emit('error', {});
  assert.match(p.$('server-state').textContent, /reconnecting/i);
});

test('cached weather and calendar disclose refresh errors even with retained data', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('weather', { temp: 25, label: 'Clear', updatedAt: NOW - 3600000, stale: true, error: 'Fetch failed' });
  assert.match(p.$('weather').textContent, /25.*stale|25.*failed/i);
  await p.emit('calendar', { configured: true, stale: true, error: 'Fetch failed', updatedAt: NOW - 3600000, upcoming: [{ startMs: NOW, endMs: NOW + 3600000, summary: 'Retained meeting' }] });
  assert.match(p.$('event').textContent, /stale|failed/i);
  assert.match(p.$('event').textContent, /Retained meeting/);
});

test('configured timezone formats clock while override never shifts calendar event instants', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('snapshot', { ...p.state.snapshot, time: { offsetSec: 90000 }, calendar: { configured: true, updatedAt: NOW, upcoming: [{ startMs: NOW, endMs: NOW + 3600000, summary: 'Real event' }] } });
  assert.match(p.$('clock').textContent, /2:00:00 PM/);
  assert.match(p.$('date').textContent, /28-10-2026/);
  assert.match(p.$('event').textContent, /Real event/);
  assert.match(p.$('event').textContent, /1:00 PM/);
});

test('failed task submission keeps its draft and reports a network failure', async t => {
  const p = await page('admin', { '/api/todos': opts => opts.method ? Promise.reject(new Error('offline')) : reply([{ id: 'b', text: 'Read', done: false }]) }); t.after(() => p.dom.window.close());
  p.$('todo-text').value = 'Keep this draft';
  await assert.doesNotReject(() => p.$('todo-add').onclick());
  assert.equal(p.$('todo-text').value, 'Keep this draft');
  assert.match(p.$('msg').textContent, /reach|network|offline/i);
});

test('pending task submission cannot duplicate and failure restores its button', async t => {
  let finish;
  const p = await page('admin', { '/api/todos': opts => opts.method ? new Promise(resolve => finish = resolve) : reply([]) }); t.after(() => p.dom.window.close());
  p.$('todo-text').value = 'Once'; const pending = p.$('todo-add').onclick();
  assert.equal(p.$('todo-add').disabled, true);
  finish(reply({ error: 'Storage unavailable' }, 500)); await pending;
  assert.equal(p.$('todo-add').disabled, false);
  assert.equal(p.$('todo-text').value, 'Once');
  assert.match(p.$('msg').textContent, /Storage unavailable/);
});

test('rejected task checkbox restores confirmed value and reports the failure', async t => {
  const p = await page('admin', { '/api/todos/b': () => reply({ error: 'Write failed' }, 500) }); t.after(() => p.dom.window.close());
  const cb = p.$('list').querySelector('input'); cb.checked = true; await cb.onchange();
  assert.equal(cb.checked, false);
  assert.match(p.$('msg').textContent, /Write failed/);
});

test('rejected timer color restores confirmed value without success message', async t => {
  const p = await page('admin', { '/api/timers/a': () => reply({ error: 'Write failed' }, 500) }); t.after(() => p.dom.window.close());
  const color = p.$('timer-list').querySelector('input[type=color]'); color.value = '#abcdef'; await color.onchange();
  assert.equal(color.value, '#123456');
  assert.doesNotMatch(p.$('msg').textContent, /updated/);
  assert.match(p.$('msg').textContent, /Write failed/);
});

test('expired session stops protected actions and clears the stale token', async t => {
  const p = await page('admin', { '/api/time': opts => opts.method ? reply({ error: 'Unauthorized' }, 401) : reply({ dashboardNow: NOW, offsetSec: 0, timeZone: 'Africa/Cairo' }) }); t.after(() => p.dom.window.close());
  await p.$('time-reset').onclick();
  assert.equal(p.w.localStorage.getItem('admin_token'), null);
  assert.equal(p.$('panel').style.display, 'none');
  assert.doesNotMatch(p.$('msg').textContent, /Back to real/);
});

test('admin clock and countdown advance live using configured timezone', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  assert.match(p.$('dash-now').textContent, /1:00:00 PM/);
  assert.match(p.$('timer-list').textContent, /1:05 left/);
  await p.advance(10000);
  assert.match(p.$('dash-now').textContent, /1:00:10 PM/);
  assert.match(p.$('timer-list').textContent, /0:55 left/);
});

test('admin SSE synchronizes remote tasks while focused calendar draft survives', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  p.$('cal-ics').focus(); p.$('cal-ics').value = 'https://calendar.invalid/draft.ics';
  await p.emit('todos', [{ id: 'c', text: 'Remote task', done: false }]);
  assert.match(p.$('list').textContent, /Remote task/);
  assert.equal(p.$('cal-ics').value, 'https://calendar.invalid/draft.ics');
});

test('calendar fetch failure after settings save retains URL draft and shows stale cache status', async t => {
  const p = await page('admin', { '/api/settings': opts => opts.method ? reply({ ok: false, error: 'Calendar fetch failed', calendar: { configured: true, error: 'Fetch failed', stale: true, next: { summary: 'Cached meeting', startMs: NOW } } }, 502) : reply({ icsUrl: 'https://calendar.invalid/test.ics' }) }); t.after(() => p.dom.window.close());
  p.$('cal-ics').value = 'https://calendar.invalid/new.ics'; await p.$('cal-save').onclick();
  assert.equal(p.$('cal-ics').value, 'https://calendar.invalid/new.ics');
  assert.match(p.$('cal-status').textContent, /stale|failed/i);
  assert.doesNotMatch(p.$('msg').textContent, /connected ✓/);
});

test('server snapshot epoch corrects device clock skew for sample freshness and timers', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('snapshot', { ...p.state.snapshot, now: NOW + 3600000, pc: { ...p.state.snapshot.pc, updatedAt: NOW + 3600000 }, timers: [{ id: 'skew', name: 'Server timer', type: 'short', targetAt: NOW + 3665000 }] });
  assert.match(p.$('pc-state').textContent, /online/i);
  assert.equal(p.$('timer-skew').querySelector('.timer-left').textContent, '1:05');
  await p.advance(12000);
  assert.match(p.$('pc-state').textContent, /stale/i);
});

test('focused timer color control survives remote timer updates and later reconciles', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const input = p.$('timer-list').querySelector('input[type=color]'); input.focus(); input.value = '#abcdef';
  await p.emit('timers', [{ ...p.state.snapshot.timers[0], name: 'Remote name', color: '#654321' }]);
  assert.equal(p.$('timer-list').querySelector('input[type=color]'), input);
  assert.equal(input.value, '#abcdef');
  input.blur(); await new Promise(resolve => setTimeout(resolve, 5)); await flush();
  assert.match(p.$('timer-list').textContent, /Remote name/);
  assert.equal(p.$('timer-list').querySelector('input[type=color]').value, '#654321');
});

test('failed timer creation retains all entered fields and does not add a timer', async t => {
  const p = await page('admin', { '/api/timers': opts => opts.method ? reply({ error: 'Timer limit reached' }, 409) : reply([]) }); t.after(() => p.dom.window.close());
  p.$('tm-name').value = 'Keep timer'; p.$('tm-days').value = '3';
  await p.$('tm-long-set').onclick();
  assert.equal(p.$('tm-name').value, 'Keep timer'); assert.equal(p.$('tm-days').value, '3');
  assert.match(p.$('msg').textContent, /Timer limit reached/); assert.match(p.$('timer-list').textContent, /No timers/);
});

test('failed calendar disconnect retains the URL and never announces success', async t => {
  const p = await page('admin', { '/api/settings': opts => opts.method ? reply({ error: 'Write failed' }, 500) : reply({ icsUrl: 'https://calendar.invalid/test.ics' }) }); t.after(() => p.dom.window.close());
  await p.$('cal-clear').onclick();
  assert.equal(p.$('cal-ics').value, 'https://calendar.invalid/test.ics');
  assert.match(p.$('msg').textContent, /Write failed/); assert.doesNotMatch(p.$('msg').textContent, /disconnected/);
});

test('failed delete retains task and a second pending add cannot send another mutation', async t => {
  let finish;
  const p = await page('admin', { '/api/todos/b': () => reply({ error: 'Delete failed' }, 500), '/api/todos': opts => opts.method ? new Promise(resolve => finish = resolve) : reply([{ id: 'b', text: 'Read', done: false }]) }); t.after(() => p.dom.window.close());
  await p.$('list').querySelector('button[aria-label^="Delete task"]').onclick();
  assert.match(p.$('list').textContent, /Read/); assert.match(p.$('msg').textContent, /Delete failed/);
  p.$('todo-text').value = 'Once'; const first = p.$('todo-add').onclick(); await p.$('todo-add').onclick();
  assert.equal(p.state.requests.filter(request => request.url === '/api/todos' && request.method === 'POST').length, 1);
  finish(reply({ error: 'Failed' }, 500)); await first;
});

test('color rollback uses the latest successful color across repeated focused changes', async t => {
  let saved = '#123456', rejected = false;
  const p = await page('admin', {
    '/api/timers': () => reply([{ id: 'a', name: 'Tea', type: 'short', targetAt: NOW + 65000, color: saved, done: false }]),
    '/api/timers/a': opts => {
      if (rejected) return reply({ error: 'Write failed' }, 500);
      saved = JSON.parse(opts.body).color; return reply({ id: 'a', name: 'Tea', type: 'short', targetAt: NOW + 65000, color: saved, done: false });
    }
  }); t.after(() => p.dom.window.close());
  const input = p.$('timer-list').querySelector('input[type=color]'); input.focus();
  input.value = '#abcdef'; await input.onchange();
  rejected = true; input.value = '#fedcba'; await input.onchange();
  assert.equal(input.value, '#abcdef');
});

test('confirmed task creation uses its response even if subsequent reads are offline', async t => {
  let created = false;
  const p = await page('admin', { '/api/todos': opts => {
    if (opts.method) { created = true; return reply({ id: 'new', text: 'Saved task', done: false }); }
    if (created) throw new Error('offline');
    return reply([]);
  } }); t.after(() => p.dom.window.close());
  p.$('todo-text').value = 'Saved task'; await p.$('todo-add').onclick();
  assert.match(p.$('list').textContent, /Saved task/);
  assert.match(p.$('msg').textContent, /Added/);
});

function deferred() { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; }
async function expireAndLogin(p) {
  p.state.handlers['/api/time'] = opts => opts.method ? reply({ error: 'Expired' }, 401) : reply({ dashboardNow: NOW, offsetSec: 0, timeZone: 'Africa/Cairo' });
  await p.$('time-reset').onclick();
  p.state.handlers['/api/login'] = () => reply({ ok: true, token: 'fresh-token' });
  p.$('login-user').value = 'admin'; p.$('login-pass').value = 'password'; await p.$('login-btn').onclick();
  assert.equal(p.w.localStorage.getItem('admin_token'), 'fresh-token');
}

test('an older read cannot replace newer SSE tasks even with focused list reconciliation', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = deferred(); p.state.handlers['/api/todos'] = () => old.promise;
  const poll = p.poll();
  p.$('list').querySelector('input').focus();
  await p.emit('todos', [{ id: 'remote', text: 'New authoritative task', done: false }]);
  old.resolve(reply([{ id: 'b', text: 'Old task', done: false }])); await poll;
  p.$('list').querySelector('input').blur(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(p.$('list').textContent, /New authoritative task/); assert.doesNotMatch(p.$('list').textContent, /Old task/);
});

test('an older timer read cannot undo a committed color or its pending rollback baseline', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = deferred(); p.state.handlers['/api/timers'] = () => old.promise;
  const poll = p.poll(); const input = p.$('timer-list').querySelector('input[type=color]'); input.focus();
  p.state.handlers['/api/timers/a'] = opts => reply({ ...p.state.snapshot.timers[0], color: JSON.parse(opts.body).color });
  input.value = '#abcdef'; await input.onchange();
  const failed = deferred(); p.state.handlers['/api/timers/a'] = () => failed.promise;
  input.value = '#fedcba'; const mutation = input.onchange();
  old.resolve(reply(p.state.snapshot.timers)); await poll;
  failed.resolve(reply({ error: 'Write failed' }, 500)); await mutation;
  assert.equal(input.value, '#abcdef');
});

test('a delayed PATCH response cannot overwrite a newer SSE timer update', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = deferred(); p.state.handlers['/api/timers/a'] = () => old.promise;
  const input = p.$('timer-list').querySelector('input[type=color]'); input.focus(); input.value = '#abcdef'; const mutation = input.onchange();
  await p.emit('timers', [{ ...p.state.snapshot.timers[0], name: 'Newer remote timer', color: '#654321' }]);
  old.resolve(reply({ ...p.state.snapshot.timers[0], color: '#abcdef' })); await mutation;
  input.blur(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(p.$('timer-list').textContent, /Newer remote timer/);
  assert.equal(p.$('timer-list').querySelector('input[type=color]').value, '#654321');
});

test('overlapping reads resolve in request order rather than response order', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const first = deferred(), second = deferred(); let count = 0;
  p.state.handlers['/api/todos'] = () => (++count === 1 ? first : second).promise;
  const a = p.poll(), b = p.poll();
  second.resolve(reply([{ id: 'new', text: 'Latest poll task', done: false }])); await b;
  first.resolve(reply([{ id: 'old', text: 'Obsolete poll task', done: false }])); await a;
  assert.match(p.$('list').textContent, /Latest poll task/); assert.doesNotMatch(p.$('list').textContent, /Obsolete poll/);
});

test('a late previous-session 401 cannot remove the replacement login', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = deferred(); p.state.handlers['/api/todos/b'] = () => old.promise;
  const input = p.$('list').querySelector('input'); input.checked = true; const mutation = input.onchange();
  await expireAndLogin(p);
  const status = p.$('msg').textContent;
  old.resolve(reply({ error: 'Expired old token' }, 401)); await mutation;
  assert.equal(p.w.localStorage.getItem('admin_token'), 'fresh-token'); assert.equal(p.$('panel').style.display, 'block');
  assert.equal(p.$('msg').textContent, status);
});

test('old-session success cannot change the new draft cache status or pending controls', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = deferred(), current = deferred(); let posts = 0;
  p.state.handlers['/api/todos'] = opts => opts.method ? (++posts === 1 ? old : current).promise : reply([{ id: 'fresh', text: 'Replacement session task', done: false }]);
  p.$('todo-text').value = 'Old draft'; const previous = p.$('todo-add').onclick();
  await expireAndLogin(p);
  assert.equal(p.$('todo-add').disabled, false);
  p.$('todo-text').value = 'New session draft'; const next = p.$('todo-add').onclick();
  old.resolve(reply({ id: 'old', text: 'Old session result', done: false })); await previous;
  assert.equal(p.$('todo-add').disabled, true); assert.equal(p.$('todo-text').value, 'New session draft');
  assert.doesNotMatch(p.$('list').textContent, /Old session result/); assert.equal(p.$('msg').textContent, 'Saving…');
  current.resolve(reply({ id: 'new', text: 'New session draft', done: false })); await next;
  assert.match(p.$('list').textContent, /New session draft/); assert.equal(p.$('todo-add').disabled, false);
});

test('overlapping task PATCH and create both reconcile successfully without SSE', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const patch = deferred(), create = deferred();
  p.state.handlers['/api/todos/b'] = () => patch.promise;
  p.state.handlers['/api/todos'] = opts => opts.method ? create.promise : reply(p.state.snapshot.todos);
  const cb = p.$('list').querySelector('input'); cb.checked = true; const completion = cb.onchange();
  p.$('todo-text').value = 'Created while completing'; const addition = p.$('todo-add').onclick();
  patch.resolve(reply({ id: 'b', text: 'Read', done: true })); await completion;
  create.resolve(reply({ id: 'new', text: 'Created while completing', done: false })); await addition;
  assert.match(p.$('list').textContent, /Created while completing/);
  assert.equal(p.$('list').querySelector('input').checked, true);
  assert.equal(p.$('todo-text').value, '');
});

test('different-item task PATCH responses reconcile independently without SSE', async t => {
  const initial = [{ id: 'b', text: 'Read', done: false }, { id: 'c', text: 'Write', done: false }];
  const p = await page('admin', { '/api/todos': () => reply(initial) }); t.after(() => p.dom.window.close());
  const a = deferred(), b = deferred(); p.state.handlers['/api/todos/b'] = () => a.promise; p.state.handlers['/api/todos/c'] = () => b.promise;
  const inputs = [...p.$('list').querySelectorAll('input')]; inputs.forEach(input => input.checked = true);
  const first = inputs[0].onchange(), second = inputs[1].onchange();
  b.resolve(reply({ ...initial[1], done: true })); await second;
  a.resolve(reply({ ...initial[0], done: true })); await first;
  assert.deepEqual([...p.$('list').querySelectorAll('input')].map(input => input.checked), [true, true]);
});

test('an unrelated failed mutation cannot suppress a successful task PATCH', async t => {
  const initial = [{ id: 'b', text: 'Read', done: false }, { id: 'c', text: 'Write', done: false }];
  const p = await page('admin', { '/api/todos': () => reply(initial) }); t.after(() => p.dom.window.close());
  const success = deferred(), failure = deferred(); p.state.handlers['/api/todos/b'] = () => success.promise; p.state.handlers['/api/todos/c'] = () => failure.promise;
  const cb = p.$('list').querySelector('input'); cb.checked = true; const first = cb.onchange();
  const second = p.$('list').querySelectorAll('button[aria-label^="Delete task"]')[1].onclick();
  failure.resolve(reply({ error: 'Delete failed' }, 500)); await second;
  success.resolve(reply({ ...initial[0], done: true })); await first;
  assert.equal(p.$('list').querySelector('input').checked, true); assert.match(p.$('list').textContent, /Write/);
});


test('integrated feature controls and stacked kiosk columns survive', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  for (const id of ['todo-repeat', 'todo-priority', 'note-save', 'routine-add', 'display-save', 'import-btn', 'export-btn', 'alarm-test', 'tm-long-set', 'tm-short-start']) assert.ok(p.$(id), id);
  assert.ok(p.$('list').querySelector('button[aria-label="Edit Read"]'));
  assert.ok(p.$('timer-list').querySelector('button[aria-label="Pause Tea"]'));
});

test('dirty note and display drafts survive reads SSE and failed saves', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  p.$('note-text').value = 'Unsaved note'; p.$('note-text').dispatchEvent(new p.w.Event('input'));
  p.$('empty-msg').value = 'Unsaved message'; p.$('empty-msg').dispatchEvent(new p.w.Event('input'));
  await p.emit('note', { text: 'Remote note' }); await p.emit('display', { emptyMsg: 'Remote message' }); await p.poll();
  assert.equal(p.$('note-text').value, 'Unsaved note'); assert.equal(p.$('empty-msg').value, 'Unsaved message');
  p.state.handlers['/api/note'] = () => reply({ error: 'Note failed' }, 500);
  await p.$('note-save').onclick(); assert.equal(p.$('note-text').value, 'Unsaved note'); assert.match(p.$('msg').textContent, /Note failed/);
});

test('hidden tasks leave Today and Up Next and changed empty message renders immediately', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('todos', [{ id: 'due', text: 'Hidden task', dueAt: NOW + 60000 }]);
  assert.match(p.$('event').textContent, /Hidden task/);
  await p.emit('display', { showTodos: false, showCalendar: true, emptyMsg: 'Rest now' });
  assert.doesNotMatch(p.$('event').textContent, /Hidden task/); assert.equal(p.$('next-card').hidden, true);
  await p.emit('todos', []); await p.emit('display', { showTodos: true, emptyMsg: 'Custom empty' });
  assert.match(p.$('todos').textContent, /Custom empty/);
});

test('overdue weekly tasks remain visible beyond one day and alarms use server time', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('snapshot', { ...p.state.snapshot, now: NOW + 3600000, timers: [], time: { offsetSec: 86400 }, todos: [{ id: 'weekly', text: 'Weekly overdue', repeat: 'weekly', dueAt: NOW - 2 * 86400000 }, { id: 'due', text: 'Server alarm', dueAt: NOW + 3500000 }] });
  assert.match(p.$('event').textContent + p.$('todos').textContent, /Weekly overdue/);
  assert.equal(p.$('alarm-banner').hidden, false);
  await p.$('alarm-dismiss').onclick();
  await p.emit('todos', [{ id: 'next', text: 'New occurrence', dueAt: NOW + 3500000 }]);
  assert.match(p.$('alarm-title').textContent, /New occurrence/);
  await p.w.document.querySelector('.alarm-snooze').onclick(); assert.equal(p.$('alarm-banner').hidden, true);
  await p.advance(300001); assert.equal(p.$('alarm-banner').hidden, false);
});

test('configured-zone quiet hours and visibility stop alarm audio', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('display', { quietEnabled: true, quietStart: '12:00', quietEnd: '14:00' });
  assert.equal(p.w.document.body.classList.contains('quiet'), true);
  await p.emit('todos', [{ id: 'quiet', text: 'Quiet alarm', dueAt: NOW - 1000 }]);
  assert.equal(p.$('alarm-banner').hidden, false);
  assert.equal(p.$('alarm-enable').hidden, true);
});

test('media expires without SSE and same-track metadata keeps artwork', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  const track = { playing: true, title: 'Song', artist: 'Artist', updatedAt: NOW, ttlMs: 30000, thumb: 'data:image/png;base64,YQ==' };
  await p.emit('media', track); assert.equal(p.$('media-card').hidden, false);
  await p.emit('media', { ...track, thumb: null }); assert.equal(p.$('media-art').hidden, false);
  await p.advance(31000); assert.equal(p.$('media-card').hidden, true);
});

test('older feature reads cannot replace newer SSE note display or routines', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = { note: deferred(), display: deferred(), routines: deferred() };
  for (const [key,value] of Object.entries(old)) p.state.handlers['/api/' + key] = () => value.promise;
  const poll = p.poll();
  await p.emit('note', { text: 'New authoritative note' });
  await p.emit('display', { mode: 'focus', emptyMsg: 'New authoritative empty' });
  await p.emit('routines', [{ id: 'new', name: 'New authoritative routine', repeat: 'daily', items: [] }]);
  old.note.resolve(reply({ text: 'Old note' })); old.display.resolve(reply({ mode: 'overview', emptyMsg: 'Old empty' })); old.routines.resolve(reply([])); await poll;
  assert.equal(p.$('note-text').value, 'New authoritative note');
  assert.equal(p.$('empty-msg').value, 'New authoritative empty');
  assert.match(p.$('routine-list').textContent, /New authoritative routine/);
});

test('pending note cannot duplicate and late save uses a newer SSE baseline while retaining edits', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const save = deferred(); p.state.handlers['/api/note'] = () => save.promise;
  p.$('note-text').value = 'Submitted'; p.$('note-text').dispatchEvent(new p.w.Event('input'));
  const writing = p.$('note-save').onclick(); await p.$('note-save').onclick();
  assert.equal(p.state.requests.filter(r => r.url === '/api/note' && r.method === 'POST').length, 1);
  await p.emit('note', { text: 'Newer note' });
  p.$('note-text').value = 'Edited during save'; p.$('note-text').dispatchEvent(new p.w.Event('input'));
  save.resolve(reply({ text: 'Submitted' })); await writing;
  assert.equal(p.$('note-text').value, 'Edited during save'); assert.equal(p.$('note-save').disabled, false);
});

test('previous-session feature success cannot alter replacement drafts or controls', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = deferred(); p.state.handlers['/api/note'] = opts => opts.method ? old.promise : reply({ text: 'Current saved note' });
  p.$('note-text').value = 'Old draft'; const saving = p.$('note-save').onclick();
  await expireAndLogin(p); p.$('note-text').value = 'New draft'; p.$('note-text').dispatchEvent(new p.w.Event('input'));
  old.resolve(reply({ text: 'Old success' })); await saving;
  assert.equal(p.$('note-text').value, 'New draft'); assert.equal(p.$('note-save').disabled, false);
});

test('blurred task editor drafts survive unrelated SSE until explicit cancel', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  p.$('list').querySelector('button[aria-label="Edit Read"]').onclick();
  const edit = p.$('list').querySelector('input[type=text]'); edit.value = 'Unsaved edited task'; edit.blur();
  p.state.snapshot.todos = [{ id: 'b', text: 'Remote changed task', done: false }];
  await p.emit('todos', p.state.snapshot.todos); await p.advance(2000);
  assert.equal(p.$('list').querySelector('input[type=text]'), edit); assert.equal(edit.value, 'Unsaved edited task');
  p.$('list').querySelector('button[aria-label="Cancel editing"]').onclick();
  assert.match(p.$('list').textContent, /Remote changed task/);
});

test('schedule editor sends configured-zone local ISO unchanged and formats existing schedule in app zone', async t => {
  const task = { id: 'scheduled', text: 'Zone task', repeat: 'none', dueAt: NOW, priority: 'normal' };
  const p = await page('admin', { '/api/todos': () => reply([task]), '/api/todos/scheduled': opts => reply({ ...task, ...JSON.parse(opts.body) }) }); t.after(() => p.dom.window.close());
  p.$('list').querySelector('button[aria-label^="Edit priority"]').onclick();
  const input = p.$('list').querySelector('input[type=datetime-local]'); assert.equal(input.value, '2026-10-27T13:00');
  input.value = '2026-10-29T09:30'; await p.$('list').querySelector('button[aria-label="Save changes"]').onclick();
  assert.equal(JSON.parse(p.state.requests.find(r => r.url === '/api/todos/scheduled').body).dueAt, '2026-10-29T09:30');
});

test('successful import replaces dirty content and invalidates older resource reads without changing calendar draft', async t => {
  const p = await page('admin'); t.after(() => p.dom.window.close());
  const old = deferred(); let imported = false;
  p.state.handlers['/api/note'] = () => imported ? reply({ text: 'Imported note' }) : old.promise;
  p.state.handlers['/api/import'] = () => { imported = true; return reply({ ok: true }); };
  const poll = p.poll();
  p.$('note-text').value = 'Dirty old note'; p.$('note-text').dispatchEvent(new p.w.Event('input'));
  p.$('cal-ics').value = 'https://calendar.invalid/unsaved.ics'; p.$('cal-ics').dispatchEvent(new p.w.Event('input'));
  Object.defineProperty(p.$('import-file'), 'files', { value: [{ size: 42, text: async () => JSON.stringify({ format: 'tablet-dashboard-v2' }) }] });
  await p.$('import-file').onchange();
  old.resolve(reply({ text: 'Obsolete pre-import note' })); await poll;
  assert.equal(p.$('note-text').value, 'Imported note'); assert.equal(p.$('cal-ics').value, 'https://calendar.invalid/unsaved.ics');
  assert.equal(p.$('import-btn').disabled, false); assert.match(p.$('msg').textContent, /imported/i);
});

test('failed import retains all dirty drafts and restores controls', async t => {
  const p = await page('admin', { '/api/import': () => reply({ error: 'Import storage failed' }, 500) }); t.after(() => p.dom.window.close());
  p.$('note-text').value = 'Keep note'; p.$('note-text').dispatchEvent(new p.w.Event('input'));
  p.$('empty-msg').value = 'Keep display'; p.$('empty-msg').dispatchEvent(new p.w.Event('input'));
  Object.defineProperty(p.$('import-file'), 'files', { value: [{ size: 42, text: async () => '{}' }] });
  await p.$('import-file').onchange(); await p.poll();
  assert.equal(p.$('note-text').value, 'Keep note'); assert.equal(p.$('empty-msg').value, 'Keep display');
  assert.equal(p.$('todo-add').disabled, false); assert.match(p.$('msg').textContent, /Import storage failed/);
});

test('empty kiosk columns collapse independently including note and routine-only content', async t => {
  const p = await page('kiosk'); t.after(() => p.dom.window.close());
  await p.emit('display', { showCalendar: false, showTodos: false, showTimers: false, showPC: false });
  await p.emit('note', { text: '' });
  assert.equal(p.$('life-column').hidden, true); assert.equal(p.$('mid-column').hidden, true); assert.equal(p.$('pc-column').hidden, true);
  await p.emit('routines', [{ name: 'Only routine', items: [] }]);
  assert.equal(p.$('pc-column').hidden, false); assert.equal(p.w.document.body.classList.contains('solo-grid'), true);
  await p.emit('note', { text: 'Visible note' }); assert.equal(p.$('life-column').hidden, false);
});

test('audio attempts cannot revive dismissed occurrence and quiet/hidden state stops sound', async t => {
  const p = await page('kiosk', { '/audio/alarm.mp3': () => reply({}) }); t.after(() => p.dom.window.close());
  let hidden = false, pauses = 0, plays = 0;
  Object.defineProperty(p.w.document, 'hidden', { get: () => hidden });
  const first = deferred(); p.$('alarm-audio').play = () => { plays++; return first.promise; }; p.$('alarm-audio').pause = () => pauses++;
  await p.emit('todos', [{ id: 'audio', text: 'Audio alarm', dueAt: NOW - 1000 }]);
  assert.equal(plays, 1); await p.$('alarm-dismiss').onclick(); const before = pauses;
  first.resolve(); await flush(); assert.equal(p.$('alarm-banner').hidden, true); assert.ok(pauses > before);
  p.$('alarm-audio').play = async () => plays++;
  await p.emit('todos', [{ id: 'second', text: 'Second audio', dueAt: NOW - 1000 }]);
  assert.equal(plays, 2); const started = pauses;
  hidden = true; p.w.document.dispatchEvent(new p.w.Event('visibilitychange')); assert.ok(pauses > started);
  hidden = false; await p.emit('display', { quietEnabled: true, quietStart: '12:00', quietEnd: '14:00' });
  p.w.document.dispatchEvent(new p.w.Event('visibilitychange')); await flush(); assert.equal(plays, 2);
});

test('export session expiry restores its control for replacement login', async t => {
  const p = await page('admin', { '/api/export': () => reply({ error: 'Expired' }, 401) }); t.after(() => p.dom.window.close());
  await p.$('export-btn').onclick();
  assert.equal(p.$('export-btn').disabled, false);
  assert.equal(p.w.localStorage.getItem('admin_token'), null);
  assert.match(p.$('login-err').textContent, /Session expired/);
});

test('long date uses configured-zone end of day and task/timer deletion confirmations can cancel', async t => {
  const p = await page('admin', { '/api/timers': opts => opts.method ? reply({ id: 'new-timer', name: 'Date timer', type: 'long' }) : reply([{ id: 'a', name: 'Tea', type: 'short', targetAt: NOW + 65000 }]) }); t.after(() => p.dom.window.close());
  p.$('tm-name').value = 'Date timer'; p.$('tm-long-method').value = 'date'; p.$('tm-date').value = '2027-01-12';
  await p.$('tm-long-set').onclick();
  assert.equal(JSON.parse(p.state.requests.find(r => r.url === '/api/timers' && r.method === 'POST').body).date, '2027-01-12T23:59:59');
  p.w.confirm = () => false;
  await p.$('list').querySelector('button[aria-label^="Delete task"]').onclick();
  await p.$('timer-list').querySelector('button[aria-label^="Delete timer"]').onclick();
  assert.equal(p.state.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('SSE-first routine rename acknowledges its editor without replacing newer cache', async t => {
  const initial = { id: 'r', name: 'Morning', repeat: 'daily', items: [] };
  const p = await page('admin', { '/api/routines': () => reply([initial]) }); t.after(() => p.dom.window.close());
  const response = deferred(); p.state.handlers['/api/routines/r'] = () => response.promise;
  p.$('routine-list').querySelector('button[aria-label="Rename Morning"]').onclick();
  const editor = p.$('routine-list').querySelector('[data-editing]'), input = editor.querySelector('label input'); input.value = 'Renamed';
  const saving = editor.querySelector('button[aria-label="Save changes"]').onclick();
  await p.emit('routines', [{ ...initial, name: 'Newest server name' }]);
  response.resolve(reply({ ...initial, name: 'Renamed' })); await saving;
  assert.equal(p.$('routine-list').querySelector('[data-editing]'), null);
  assert.match(p.$('routine-list').textContent, /Newest server name/); assert.doesNotMatch(p.$('routine-list').textContent, /Morning/);
});

test('SSE-first routine step edit closes acknowledged editor and retains latest step', async t => {
  const initial = { id: 'r', name: 'Morning', repeat: 'daily', items: [{ id: 'i', text: 'Drink', done: false }] };
  const p = await page('admin', { '/api/routines': () => reply([initial]) }); t.after(() => p.dom.window.close());
  const response = deferred(); p.state.handlers['/api/routines/r/items/i'] = () => response.promise;
  p.$('routine-list').querySelector('button[aria-label="Edit Drink"]').onclick();
  const editor = p.$('routine-list').querySelector('[data-editing]'), input = editor.querySelector('label input'); input.value = 'Drink water';
  const saving = editor.querySelector('button[aria-label="Save changes"]').onclick();
  await p.emit('routines', [{ ...initial, items: [{ id: 'i', text: 'Newest step', done: true }] }]);
  response.resolve(reply({ id: 'i', text: 'Drink water', doneOn: null })); await saving;
  assert.equal(p.$('routine-list').querySelector('[data-editing]'), null);
  assert.match(p.$('routine-list').textContent, /Newest step/); assert.equal(p.$('routine-list').querySelector('input[type=checkbox]').checked, true);
});

test('SSE-first step add clears only the acknowledged draft and cannot duplicate it on Enter', async t => {
  const initial = { id: 'r', name: 'Morning', repeat: 'daily', items: [] };
  const p = await page('admin', { '/api/routines': () => reply([initial]) }); t.after(() => p.dom.window.close());
  const response = deferred(); p.state.handlers['/api/routines/r/items'] = () => response.promise;
  const entry = p.$('routine-list').querySelector('input[aria-label="New step for Morning"]'); entry.value = 'Drink water'; entry.dispatchEvent(new p.w.Event('input'));
  const saving = p.$('routine-list').querySelector('button[aria-label="Add step to Morning"]').onclick();
  const created = { id: 'i', text: 'Drink water', done: false };
  await p.emit('routines', [{ ...initial, items: [created] }]); response.resolve(reply(created)); await saving;
  const currentEntry = p.$('routine-list').querySelector('input[aria-label="New step for Morning"]');
  assert.equal(currentEntry.value, ''); currentEntry.onkeydown({ key: 'Enter' }); await flush();
  assert.equal(p.state.requests.filter(request => request.url === '/api/routines/r/items' && request.method === 'POST').length, 1);
  assert.equal(p.$('routine-list').querySelectorAll('li').length, 1);
});

test('routine acknowledgements preserve rename and step drafts changed after submission', async t => {
  const initial = { id: 'r', name: 'Morning', repeat: 'daily', items: [] };
  const p = await page('admin', { '/api/routines': () => reply([initial]) }); t.after(() => p.dom.window.close());
  const rename = deferred(); p.state.handlers['/api/routines/r'] = () => rename.promise;
  p.$('routine-list').querySelector('button[aria-label="Rename Morning"]').onclick();
  const editor = p.$('routine-list').querySelector('[data-editing]'), input = editor.querySelector('label input'); input.value = 'Submitted name';
  const saving = editor.querySelector('button[aria-label="Save changes"]').onclick();
  input.value = 'New unsaved name'; await p.emit('routines', [{ ...initial, name: 'Submitted name' }]); rename.resolve(reply({ ...initial, name: 'Submitted name' })); await saving;
  assert.equal(input.value, 'New unsaved name'); assert.ok(p.$('routine-list').querySelector('[data-editing]'));
  editor.querySelector('button[aria-label="Cancel editing"]').onclick();
  const add = deferred(); p.state.handlers['/api/routines/r/items'] = () => add.promise;
  const entry = p.$('routine-list').querySelector('input[aria-label="New step for Submitted name"]'); entry.value = 'Submitted step'; entry.dispatchEvent(new p.w.Event('input'));
  const adding = p.$('routine-list').querySelector('button[aria-label="Add step to Submitted name"]').onclick();
  entry.value = 'New unsaved step'; entry.dispatchEvent(new p.w.Event('input'));
  const created = { id: 'i', text: 'Submitted step', done: false };
  await p.emit('routines', [{ ...initial, name: 'Submitted name', items: [created] }]); add.resolve(reply(created)); await adding;
  assert.equal(p.$('routine-list').querySelector('input[aria-label="New step for Submitted name"]').value, 'New unsaved step');
});

test('different-task ordering requests serialize despite reversed ready responses without SSE', async t => {
  const initial = [{ id: 'a', text: 'Alpha', order: 0 }, { id: 'b', text: 'Bravo', order: 1 }, { id: 'c', text: 'Charlie', order: 2 }];
  const p = await page('admin', { '/api/todos': () => reply(initial) }); t.after(() => p.dom.window.close());
  const first = deferred(), second = deferred();
  p.state.handlers['/api/todos/b'] = () => first.promise; p.state.handlers['/api/todos/c'] = () => second.promise;
  const movingBravo = p.$('list').querySelector('button[aria-label="Move Bravo up"]').onclick();
  const movingCharlie = p.$('list').querySelector('button[aria-label="Move Charlie up"]').onclick();
  await flush();
  assert.equal(p.state.requests.filter(request => request.method === 'PATCH').length, 1, 'only one order mutation may reach server at a time');
  second.resolve(reply({ ...initial[2], order: 1 })); first.resolve(reply({ ...initial[1], order: 0 }));
  await Promise.all([movingBravo, movingCharlie]);
  assert.deepEqual([...p.$('list').querySelectorAll('li > .grow')].map(el => el.firstChild.textContent), ['Bravo', 'Charlie', 'Alpha']);
});

test('step edit acknowledgement preserves text changed after submission', async t => {
  const initial = { id: 'r', name: 'Morning', repeat: 'daily', items: [{ id: 'i', text: 'Drink', done: false }] };
  const p = await page('admin', { '/api/routines': () => reply([initial]) }); t.after(() => p.dom.window.close());
  const response = deferred(); p.state.handlers['/api/routines/r/items/i'] = () => response.promise;
  p.$('routine-list').querySelector('button[aria-label="Edit Drink"]').onclick();
  const editor = p.$('routine-list').querySelector('[data-editing]'), input = editor.querySelector('label input'); input.value = 'Submitted step edit';
  const saving = editor.querySelector('button[aria-label="Save changes"]').onclick(); input.value = 'New unsaved edit';
  await p.emit('routines', [{ ...initial, items: [{ id: 'i', text: 'Submitted step edit', done: false }] }]);
  response.resolve(reply({ id: 'i', text: 'Submitted step edit' })); await saving;
  assert.equal(input.value, 'New unsaved edit'); assert.ok(p.$('routine-list').querySelector('[data-editing]')); assert.equal(input.disabled, false);
});

test('task order lane retains concurrent independent item edits and newer SSE ordering', async t => {
  const initial = [{ id: 'a', text: 'Alpha', order: 0 }, { id: 'b', text: 'Bravo', order: 1 }, { id: 'c', text: 'Charlie', order: 2 }];
  const p = await page('admin', { '/api/todos': () => reply(initial) }); t.after(() => p.dom.window.close());
  const order = deferred(), edit = deferred(); p.state.handlers['/api/todos/b'] = () => order.promise; p.state.handlers['/api/todos/a'] = () => edit.promise;
  const moving = p.$('list').querySelector('button[aria-label="Move Bravo up"]').onclick();
  const check = p.$('list').querySelector('input[type=checkbox]'); check.checked = true; const completing = check.onchange();
  assert.equal(p.state.requests.filter(request => request.method === 'PATCH').length, 2, 'non-order item edits remain independent');
  edit.resolve(reply({ ...initial[0], done: true })); await completing;
  order.resolve(reply({ ...initial[1], order: 0 })); await moving;
  assert.deepEqual([...p.$('list').querySelectorAll('li > .grow')].map(el => el.firstChild.textContent), ['Bravo', 'Alpha', 'Charlie']);
  assert.equal(p.$('list').querySelectorAll('input[type=checkbox]')[1].checked, true);
  const late = deferred(); p.state.handlers['/api/todos/a'] = () => late.promise;
  const nextMove = p.$('list').querySelector('button[aria-label="Move Alpha up"]').onclick();
  await p.emit('todos', [{ ...initial[2], order: 0 }, { ...initial[1], order: 1 }, { ...initial[0], order: 2, done: true }]);
  late.resolve(reply({ ...initial[0], order: 0, done: true })); await nextMove;
  assert.deepEqual([...p.$('list').querySelectorAll('li > .grow')].map(el => el.firstChild.textContent), ['Charlie', 'Bravo', 'Alpha']);
});

test('queued structural task writes cannot cross into a replacement session', async t => {
  const initial = [{ id: 'a', text: 'Alpha', order: 0 }, { id: 'b', text: 'Bravo', order: 1 }, { id: 'c', text: 'Charlie', order: 2 }];
  const p = await page('admin', { '/api/todos': () => reply(initial) }); t.after(() => p.dom.window.close());
  const response = deferred(); p.state.handlers['/api/todos/b'] = () => response.promise;
  const moving = p.$('list').querySelector('button[aria-label="Move Bravo up"]').onclick();
  const queued = p.$('list').querySelector('button[aria-label="Move Charlie up"]').onclick();
  await expireAndLogin(p);
  response.resolve(reply({ ...initial[1], order: 0 })); await Promise.all([moving, queued]);
  assert.equal(p.state.requests.filter(request => request.url === '/api/todos/c' && request.method === 'PATCH').length, 0);
  assert.equal(p.w.localStorage.getItem('admin_token'), 'fresh-token');
  assert.deepEqual([...p.$('list').querySelectorAll('li > .grow')].map(el => el.firstChild.textContent), ['Alpha', 'Bravo', 'Charlie']);
});

for (const queuedAction of ['move', 'delete']) test(`queued task ${queuedAction} reserves its row against a same-item checkbox edit`, async t => {
  const initial = [{ id: 'a', text: 'Alpha', order: 0 }, { id: 'b', text: 'Bravo', order: 1 }, { id: 'c', text: 'Charlie', order: 2 }];
  const p = await page('admin', { '/api/todos': () => reply(initial) }); t.after(() => p.dom.window.close());
  const active = deferred(), queuedResponse = deferred(), checkboxResponse = deferred();
  p.state.handlers['/api/todos/b'] = () => active.promise;
  p.state.handlers['/api/todos/c'] = opts => opts.method === 'DELETE' || JSON.parse(opts.body).action ? queuedResponse.promise : checkboxResponse.promise;
  const moving = p.$('list').querySelector('button[aria-label="Move Bravo up"]').onclick();
  const charlie = [...p.$('list').children].find(li => li.textContent.includes('Charlie'));
  const checkbox = charlie.querySelector('input[type=checkbox]'), controls = [...charlie.querySelectorAll('input,button,select')];
  const queued = charlie.querySelector(queuedAction === 'move' ? 'button[aria-label="Move Charlie up"]' : 'button[aria-label="Delete task Charlie"]').onclick();
  const lockedBeforeClick = controls.every(control => control.disabled);
  checkbox.click();
  checkbox.checked = true; const blockedEdit = checkbox.onchange();
  active.resolve(reply({ ...initial[1], order: 0 })); await flush();
  const sent = p.state.requests.filter(request => request.url === '/api/todos/c' && (request.method === 'DELETE' || JSON.parse(request.body || '{}').action));
  queuedResponse.resolve(reply(queuedAction === 'move' ? { ...initial[2], order: 1 } : { ok: true })); checkboxResponse.resolve(reply({ ...initial[2], done: true }));
  await Promise.all([moving, queued, blockedEdit]); await flush();
  assert.equal(lockedBeforeClick, true, 'queued controls reserve the row before the lane becomes available');
  assert.equal(sent.length, 1, 'the accepted queued structural write must reach the server');
  assert.equal(p.state.requests.filter(request => request.url === '/api/todos/c' && JSON.parse(request.body || '{}').done === true).length, 0, 'disabled checkbox cannot start a conflicting same-item write');
  assert.deepEqual([...p.$('list').querySelectorAll('li > .grow')].map(el => el.firstChild.textContent), queuedAction === 'move' ? ['Bravo', 'Charlie', 'Alpha'] : ['Bravo', 'Alpha']);
});

test('queued task reservations restore original controls on session invalidation and cannot affect replacement writes', async t => {
  const initial = [{ id: 'a', text: 'Alpha', order: 0 }, { id: 'b', text: 'Bravo', order: 1 }, { id: 'c', text: 'Charlie', order: 2 }];
  const p = await page('admin', { '/api/todos': () => reply(initial) }); t.after(() => p.dom.window.close());
  const old = deferred(); p.state.handlers['/api/todos/b'] = () => old.promise;
  const moving = p.$('list').querySelector('button[aria-label="Move Bravo up"]').onclick();
  const checkbox = p.$('list').querySelector('input[aria-label="Mark Charlie done"]');
  const down = p.$('list').querySelector('button[aria-label="Move Charlie down"]');
  const queued = p.$('list').querySelector('button[aria-label="Delete task Charlie"]').onclick();
  assert.equal(checkbox.disabled, true); assert.equal(down.disabled, true);
  await expireAndLogin(p);
  assert.equal(checkbox.disabled, false, 'queued reservation restores a previously enabled control');
  assert.equal(down.disabled, true, 'original boundary-disabled control remains disabled');
  const fresh = deferred(); p.state.handlers['/api/todos/c'] = () => fresh.promise;
  const currentCheckbox = p.$('list').querySelector('input[aria-label="Mark Charlie done"]'); currentCheckbox.checked = true; const current = currentCheckbox.onchange();
  old.resolve(reply({ ...initial[1], order: 0 })); await Promise.all([moving, queued]);
  assert.equal(currentCheckbox.disabled, true, 'old lane completion cannot release a replacement pending control');
  fresh.resolve(reply({ ...initial[2], done: true })); await current;
  assert.equal(p.state.requests.filter(request => request.url === '/api/todos/c' && request.method === 'DELETE').length, 0);
  assert.equal(p.$('list').querySelector('input[aria-label="Mark Charlie done"]').checked, true);
});
