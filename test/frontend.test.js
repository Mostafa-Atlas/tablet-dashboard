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
  w.setInterval = (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; };
  w.EventSource = class { constructor() { this.listeners = {}; streams.push(this); } addEventListener(name, fn) { this.listeners[name] = fn; } close() {} };
  const snapshot = { timeZone: 'Africa/Cairo', pc: { cpu: null, gpu: null, ram: 0, cpuTemp: null, gpuTemp: null, disks: [], updatedAt: NOW }, time: { offsetSec: 0 }, timers: [{ id: 'a', name: 'Tea', type: 'short', targetAt: NOW + 65000, durationSec: 65, color: '#123456', done: false }], todos: [{ id: 'b', text: 'Read', done: false }], weather: { temp: 25, label: 'Clear', updatedAt: NOW }, calendar: { configured: true, updatedAt: NOW, upcoming: [], next: null } };
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
  return { w, dom, state, poll: () => intervals.find(interval => interval.delay === 30000).fn(), $: id => w.document.getElementById(id), advance: async ms => { now += ms; for (const { fn } of [...intervals]) await fn(); await flush(); }, emit: async (name, data) => { for (const stream of streams) stream.listeners[name]?.({ data: JSON.stringify(data) }); await flush(); } };
}

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
  await p.$('list').querySelector('button').onclick();
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
  const second = p.$('list').querySelectorAll('button')[1].onclick();
  failure.resolve(reply({ error: 'Delete failed' }, 500)); await second;
  success.resolve(reply({ ...initial[0], done: true })); await first;
  assert.equal(p.$('list').querySelector('input').checked, true); assert.match(p.$('list').textContent, /Write/);
});
