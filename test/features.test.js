const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDashboard } = require('../server');
async function fixture(t, { initial, pcAllowIp = '127.0.0.1' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-features-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (initial) await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify(initial));
  const dashboard = createDashboard({ dataDir: dir, pcAllowIp, fetchImpl: async () => { throw Error('offline fixture'); } });
  await dashboard.ready;
  const server = dashboard.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { dashboard.stopBackground(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let token;
  async function request(route, method = 'GET', body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  token = (await request('/api/setup', 'POST', { user: 'owner', pass: 'test-password' })).body.token;
  return { dir, request, url: `http://127.0.0.1:${server.address().port}` };
}
test('strict schedule inputs reject poison before state changes and local dates use configured time', async t => {
  const f = await fixture(t);
  for (const dueTime of [['09:00'], true, {}, 900]) {
    assert.equal((await f.request('/api/todos', 'POST', { text: 'poison', repeat: 'daily', dueTime })).status, 400);
  }
  const task = (await f.request('/api/todos', 'POST', { text: 'local', dueAt: '2026-10-28T09:30' })).body;
  assert.equal(task.dueAt, Date.parse('2026-10-28T06:30Z'));
  assert.equal((await f.request('/api/snapshot')).status, 200);
  const exported = (await f.request('/api/export')).body;
  for (const bad of [null, {}, { text: 'bad', dueTime: ['09:00'] }]) {
    assert.equal((await f.request('/api/import', 'POST', { ...exported, todos: [bad] })).status, 400);
  }
  assert.deepEqual((await f.request('/api/export')).body.todos, exported.todos);
});
test('portable data preserves explicit task order and v1 keeps note and routines', async t => {
  const f = await fixture(t);
  const a = (await f.request('/api/todos', 'POST', { text: 'A' })).body;
  await f.request('/api/todos', 'POST', { text: 'B' });
  await f.request(`/api/todos/${a.id}`, 'PATCH', { action: 'up' });
  await f.request('/api/note', 'POST', { text: 'saved note' });
  const r = (await f.request('/api/routines', 'POST', { name: 'Routine', repeat: 'weekly' })).body;
  await f.request(`/api/routines/${r.id}/items`, 'POST', { text: 'Step' });
  const before = (await f.request('/api/todos')).body.map(x => x.text);
  const exported = (await f.request('/api/export')).body;
  assert.equal((await f.request('/api/import', 'POST', exported)).status, 200);
  assert.deepEqual((await f.request('/api/todos')).body.map(x => x.text), before);
  assert.equal((await f.request('/api/import', 'POST', { ...exported, format: 'tablet-dashboard-v1', note: undefined, routines: undefined })).status, 200);
  const snapshot = (await f.request('/api/snapshot')).body;
  assert.equal(snapshot.note.text, 'saved note'); assert.equal(snapshot.routines[0].items[0].text, 'Step');
});
test('new resource writes roll back and cannot persist rejected edits on later saves', async t => {
  const f = await fixture(t);
  const r = (await f.request('/api/routines', 'POST', { name: 'Routine' })).body;
  const before = (await f.request('/api/snapshot')).body;
  await fs.rename(f.dir, f.dir + '.saved');
  t.after(() => fs.rm(f.dir + '.saved', { recursive: true, force: true }));
  await fs.writeFile(f.dir, 'blocked');
  for (const [route, body] of [['/api/note', { text: 'rejected' }], ['/api/display', { privacy: true }], [`/api/routines/${r.id}/items`, { text: 'rejected' }]]) {
    assert.equal((await f.request(route, 'POST', body)).status, 500);
  }
  await fs.unlink(f.dir); await fs.rename(f.dir + '.saved', f.dir);
  await f.request('/api/note', 'POST', { text: 'accepted' });
  const saved = JSON.parse(await fs.readFile(path.join(f.dir, 'db.json')));
  assert.equal(saved.display.privacy, before.display.privacy);
  assert.deepEqual(saved.routines, before.routines.map(({ items, ...r }) => ({ ...r, items: [] })));
});
test('both telemetry routes enforce actual peer allowlist and media expires after 30 seconds', async t => {
  const denied = await fixture(t, { pcAllowIp: '192.168.50.2' });
  for (const route of ['/api/pc', '/api/now-playing']) assert.equal((await denied.request(route, 'POST', {}, { 'x-forwarded-for': '192.168.50.2' })).status, 403);
  const f = await fixture(t);
  assert.equal((await f.request('/api/now-playing', 'POST', { playing: true, title: 'song', thumb: 'data:image/jpeg;base64,xx' })).status, 200);
  await f.request('/api/now-playing', 'POST', { playing: true, title: 'song' });
  assert.equal((await f.request('/api/now-playing')).body.thumb, 'data:image/jpeg;base64,xx');
  const realNow = Date.now;
  const future = realNow() + 31000;
  Date.now = () => future;
  try { const media = (await f.request('/api/snapshot')).body.media; assert.equal(media.stale, true); assert.equal(media.playing, false); assert.equal(media.ttlMs, 30000); }
  finally { Date.now = realNow; }
});
test('legacy malformed feature fields are normalized without losing authored text or source provenance', async t => {
  const f = await fixture(t, { initial: { users: [], todos: [{ id: 'a', text: 'Keep task', repeat: 'daily', dueTime: ['09:00'], doneOn: '2026-10-28' }], timers: [], note: { text: 'Keep note' }, routines: [{ id: 'r', name: 'Keep routine', items: [{ id: 'i', text: 'Keep step' }, null] }], display: null } });
  const s = (await f.request('/api/snapshot')).body;
  assert.equal(s.todos[0].text, 'Keep task'); assert.equal(s.todos[0].dueTime, null);
  assert.equal(s.note.text, 'Keep note'); assert.equal(s.routines[0].items[0].text, 'Keep step');
});
test('invalid routine edits and oversized resources reject before changing saved content', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/routines', 'POST', { name: 'bad repeat', repeat: 'monthly' })).status, 400);
  const r = (await f.request('/api/routines', 'POST', { name: 'before', repeat: 'daily' })).body;
  assert.equal((await f.request(`/api/routines/${r.id}`, 'PATCH', { name: 'after', repeat: 'bad' })).status, 400);
  const item = (await f.request(`/api/routines/${r.id}/items`, 'POST', { text: 'step' })).body;
  assert.equal((await f.request(`/api/routines/${r.id}/items/${item.id}`, 'PATCH', { done: true, text: [] })).status, 400);
  assert.equal((await f.request('/api/routines')).body[0].name, 'before');
  assert.equal((await f.request('/api/routines')).body[0].items[0].done, false);
  for (let i = 0; i < 9; i++) await f.request('/api/routines', 'POST', { name: 'routine ' + i });
  assert.equal((await f.request('/api/routines', 'POST', { name: 'overflow' })).status, 409);
  for (let i = 0; i < 19; i++) await f.request(`/api/routines/${r.id}/items`, 'POST', { text: 'step ' + i });
  assert.equal((await f.request(`/api/routines/${r.id}/items`, 'POST', { text: 'overflow' })).status, 409);
});
test('malformed imported feature shapes are 400 and cannot clear saved content', async t => {
  const f = await fixture(t);
  const exported = (await f.request('/api/export')).body;
  for (const mutation of [{ display: [] }, { display: false }, { display: null }, { note: [] }, { routines: [null] }, { timers: [null] }, { todos: [{ text: 'x', doneOn: '2026-99-99' }] }]) {
    assert.equal((await f.request('/api/import', 'POST', { ...exported, ...mutation })).status, 400, JSON.stringify(mutation));
  }
  assert.deepEqual((await f.request('/api/export')).body.todos, exported.todos);
});
test('recurrence follows configured day and Monday week boundaries across Cairo DST', () => {
  const schedule = require('../lib/features').createSchedule('Africa/Cairo');
  assert.equal(schedule.todoDueAt({ repeat: 'daily', dueTime: '09:00' }, Date.parse('2026-10-28T10:00Z')), Date.parse('2026-10-28T06:00Z'));
  assert.equal(schedule.todoDueAt({ repeat: 'daily', dueTime: '09:00' }, Date.parse('2026-10-30T10:00Z')), Date.parse('2026-10-30T07:00Z'));
  assert.equal(schedule.todoDueAt({ repeat: 'weekly', dueTime: '09:00', dueWeekday: 0 }, Date.parse('2026-10-28T10:00Z')), Date.parse('2026-10-26T06:00Z'));
  assert.equal(schedule.weekKey(Date.parse('2026-11-01T22:30Z')), '2026-11-02');
  assert.equal(require('../lib/features').createSchedule('UTC').dayKey(Date.parse('2026-10-28T23:30Z')), '2026-10-28');
});
test('SSE synchronizes new durable resources and redacts private calendar cache on every public path', async t => {
  const source = 'http://private.fixture/secret-calendar';
  const calendarSource = require('node:crypto').createHash('sha256').update(source).digest('hex');
  const event = { summary: 'Secret meeting', location: 'Private room', startMs: Date.now() + 60000, endMs: Date.now() + 120000 };
  const f = await fixture(t, { initial: { users: [], todos: [], timers: [], settings: { icsUrl: source }, calendarSource,
    calendar: { next: event, upcoming: [event], configured: true, updatedAt: Date.now() }, display: { privacy: true } } });
  const response = await fetch(f.url + '/api/stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  async function nextEvent(wanted) {
    let timeout;
    try {
      return await Promise.race([(async () => {
        for (;;) {
          const end = pending.indexOf('\n\n');
          if (end >= 0) {
            const block = pending.slice(0, end); pending = pending.slice(end + 2);
            if (block.startsWith(`event: ${wanted}\n`)) return JSON.parse(block.split('\ndata: ')[1]);
          } else { const chunk = await reader.read(); if (chunk.done) throw Error('Stream ended'); pending += decoder.decode(chunk.value); }
        }
      })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('SSE event missing: ' + wanted)), 2000); })]);
    } finally { clearTimeout(timeout); }
  }
  try {
    const initial = await nextEvent('snapshot');
    assert.equal(initial.calendar.next.summary, 'Private event');
    assert.equal(initial.timeZone, 'Africa/Cairo'); assert.equal(typeof initial.now, 'number');
    assert.ok(initial.note && initial.routines && initial.media && initial.display);
    assert.equal((await f.request('/api/calendar')).body.upcoming[0].location, '');
    await f.request('/api/note', 'POST', { text: 'Live note' });
    assert.equal((await nextEvent('note')).text, 'Live note');
    await f.request('/api/routines', 'POST', { name: 'Live routine' });
    assert.equal((await nextEvent('routines'))[0].name, 'Live routine');
    await f.request('/api/display', 'POST', { mode: 'focus' });
    assert.equal((await nextEvent('display')).mode, 'focus');
    assert.equal((await nextEvent('calendar')).next.summary, 'Private event');
    const exported = (await f.request('/api/export')).body;
    for (const secret of [source, calendarSource, 'Secret meeting', 'Private room']) assert.ok(!JSON.stringify(exported).includes(secret));
  } finally { await reader.cancel(); }
});
test('failed import restores all old resources before a later successful save', async t => {
  const f = await fixture(t);
  const before = (await f.request('/api/export')).body;
  const replacement = { ...before, todos: [{ text: 'rejected import' }], timers: [], note: { text: 'rejected note' }, routines: [{ name: 'rejected routine', repeat: 'daily', items: [] }], display: { privacy: true } };
  await fs.rename(f.dir, f.dir + '.saved');
  t.after(() => fs.rm(f.dir + '.saved', { recursive: true, force: true }));
  await fs.writeFile(f.dir, 'blocked');
  assert.equal((await f.request('/api/import', 'POST', replacement)).status, 500);
  const after = (await f.request('/api/export')).body;
  for (const key of ['todos', 'timers', 'note', 'routines', 'display']) assert.deepEqual(after[key], before[key]);
  await fs.unlink(f.dir); await fs.rename(f.dir + '.saved', f.dir);
  await f.request('/api/note', 'POST', { text: 'accepted note' });
  const stored = JSON.parse(await fs.readFile(path.join(f.dir, 'db.json')));
  assert.deepEqual(stored.todos, before.todos); assert.deepEqual(stored.display, before.display);
});
test('recurring schedules skip Cairo spring gaps and fold completion remains once per local period', () => {
  const schedule = require('../lib/features').createSchedule('Africa/Cairo');
  const gapDay = Date.parse('2026-04-24T09:00Z');
  for (const repeat of ['daily', 'weekly']) {
    assert.equal(schedule.todoDueAt({ repeat, dueTime: '00:30', dueWeekday: 4 }, gapDay), null);
  }
  assert.equal(schedule.todoDueAt({ repeat: 'daily', dueTime: '00:30' }, Date.parse('2026-04-25T09:00Z')), Date.parse('2026-04-24T21:30Z'));
  const realNow = Date.now;
  try {
    const first = Date.parse('2026-10-29T20:30Z');
    const second = Date.parse('2026-10-29T21:30Z');
    for (const now of [first, second]) {
      Date.now = () => now;
      assert.equal(schedule.todoDueAt({ repeat: 'daily', dueTime: '23:30' }, now), first);
      assert.equal(schedule.done({ repeat: 'daily', doneOn: '2026-10-29' }), true);
      assert.equal(schedule.done({ repeat: 'weekly', doneOn: '2026-10-26' }), true);
    }
  } finally { Date.now = realNow; }
});
test('unrepresentable imported paused and restart durations reject without replacing resources', async t => {
  const f = await fixture(t);
  const before = (await f.request('/api/export')).body;
  for (const field of ['pausedLeftSec', 'durationSec']) {
    const payload = { ...before, todos: [{ text: 'must not replace' }], timers: [{ name: 'oversized', type: 'short', targetAt: null, [field]: Number.MAX_SAFE_INTEGER }] };
    assert.equal((await f.request('/api/import', 'POST', payload)).status, 400, field);
    const after = (await f.request('/api/export')).body;
    for (const key of ['todos', 'timers', 'note', 'display', 'routines']) assert.deepEqual(after[key], before[key]);
  }
});
test('current and legacy resume reject unsupported stored durations and retain zero-second semantics', async t => {
  for (const legacy of [false, true]) {
    const f = await fixture(t, { initial: { users: [], todos: [], timers: [{ id: 'paused', name: 'Paused', type: 'short', targetAt: null, pausedLeftSec: Number.MAX_SAFE_INTEGER }] } });
    const route = legacy ? '/api/timers/short' : '/api/timers/paused';
    const method = legacy ? 'POST' : 'PATCH';
    const before = (await f.request('/api/timers')).body;
    assert.equal((await f.request(route, method, { action: 'resume', name: 'must not change' })).status, 400);
    assert.deepEqual((await f.request('/api/timers')).body, before);
    const imported = { format: 'tablet-dashboard-v2', todos: [], timers: [{ name: 'Expired paused', type: 'short', targetAt: null, pausedLeftSec: 0, durationSec: 0 }] };
    assert.equal((await f.request('/api/import', 'POST', imported)).status, 200);
    const timer = (await f.request('/api/timers')).body[0];
    const now = Date.now();
    const resumed = await f.request(legacy ? '/api/timers/short' : `/api/timers/${timer.id}`, method, { action: 'resume' });
    assert.equal(resumed.status, 200); assert.equal(resumed.body.pausedLeftSec, null);
    assert.ok(resumed.body.targetAt >= now && resumed.body.targetAt <= Date.now());
    assert.ok(Number.isFinite(new Date(resumed.body.targetAt).getTime()));
  }
});
test('durations valid at import must be rechecked at resume after time advances', async t => {
  const f = await fixture(t);
  const realNow = Date.now;
  const now = realNow();
  const seconds = Math.floor((8640000000000000 - now) / 1000);
  try {
    Date.now = () => now;
    assert.equal((await f.request('/api/import', 'POST', { format: 'tablet-dashboard-v2', todos: [], timers: [{ name: 'At supported edge', type: 'short', targetAt: null, pausedLeftSec: seconds, durationSec: seconds }] })).status, 200);
    const timer = (await f.request('/api/timers')).body[0];
    Date.now = () => now + 1001;
    for (const [route, method] of [[`/api/timers/${timer.id}`, 'PATCH'], ['/api/timers/short', 'POST']]) {
      assert.equal((await f.request(route, method, { action: 'resume' })).status, 400);
      assert.equal((await f.request('/api/timers')).body[0].targetAt, null);
    }
  } finally { Date.now = realNow; }
});
test('same-repeat task edits preserve completion and combined repeat plus done uses the resulting period', async t => {
  const f = await fixture(t);
  for (const repeat of ['none', 'daily', 'weekly']) {
    const task = (await f.request('/api/todos', 'POST', { text: 'completed ' + repeat, repeat })).body;
    const done = (await f.request(`/api/todos/${task.id}`, 'PATCH', { done: true })).body;
    const edited = (await f.request(`/api/todos/${task.id}`, 'PATCH', { repeat, text: 'renamed' })).body;
    assert.equal(edited.done, true, repeat); assert.equal(edited.doneOn, done.doneOn);
    const nextRepeat = repeat === 'weekly' ? 'daily' : 'weekly';
    const switched = (await f.request(`/api/todos/${task.id}`, 'PATCH', { repeat: nextRepeat, done: true })).body;
    assert.equal(switched.done, true); assert.equal(typeof switched.doneOn, 'string');
    const reset = (await f.request(`/api/todos/${task.id}`, 'PATCH', { repeat: 'none' })).body;
    assert.equal(reset.done, false); assert.equal(reset.doneOn, null);
  }
});

test('timer editor local ISO uses configured zone and invalid local edits leave all fields intact', async t => {
  const f = await fixture(t);
  const timer = (await f.request('/api/timers', 'POST', { name: 'Zone editor', type: 'short', mins: 5 })).body;
  const local = await f.request(`/api/timers/${timer.id}`, 'PATCH', { targetAt: '2027-01-12T09:30', name: 'Local edit' });
  assert.equal(local.status, 200);
  assert.equal(local.body.targetAt, Date.parse('2027-01-12T07:30:00Z'));
  for (const targetAt of ['2027-02-30T09:30', '2027-04-30T00:30', {}, null]) {
    const rejected = await f.request(`/api/timers/${timer.id}`, 'PATCH', { targetAt, name: 'must not leak', color: '#abcdef' });
    assert.equal(rejected.status, 400, JSON.stringify(targetAt));
    assert.deepEqual((await f.request('/api/timers')).body.find(item => item.id === timer.id), local.body);
  }
  for (const targetAt of [Date.parse('2027-02-01T07:00Z'), String(Date.parse('2027-02-01T08:00Z'))]) {
    const updated = await f.request(`/api/timers/${timer.id}`, 'PATCH', { targetAt });
    assert.equal(updated.status, 200); assert.equal(updated.body.targetAt, Number(targetAt));
  }
});
