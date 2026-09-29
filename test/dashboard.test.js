const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startDashboard(dataDir, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 50; tries++) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { if ((await fetch(base + '/api/health')).ok) return { child, base }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('server did not start');
}

async function stopDashboard(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

function utcIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

test('dashboard data, agent access, privacy, and backup recovery', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-dashboard-test-'));
  const port = await freePort();
  let dashboard;
  const eventStart = new Date(Date.now() + 3600000);
  const eventEnd = new Date(Date.now() + 7200000);
  const calendarServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/calendar');
    res.end(`BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:sample\nDTSTART:${utcIcsDate(eventStart)}\nDTEND:${utcIcsDate(eventEnd)}\nSUMMARY:Private meeting\nLOCATION:Home\nEND:VEVENT\nEND:VCALENDAR\n`);
  });
  await new Promise(resolve => calendarServer.listen(0, '127.0.0.1', resolve));
  const calendarUrl = `http://127.0.0.1:${calendarServer.address().port}/calendar.ics`;
  try {
    dashboard = await startDashboard(dataDir, port);
    const { base } = dashboard;
    const request = async (route, method = 'GET', body, token) => {
      const response = await fetch(base + route, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: response.status, data: await response.json() };
    };

    assert.equal((await request('/api/pc', 'POST', { cpu: 20 })).status, 401);
    const setup = await request('/api/setup', 'POST', { user: 'tester', pass: 'a-long-test-password' });
    assert.equal(setup.status, 200);
    const token = setup.data.token;
    const agentToken = (await request('/api/agent-token', 'GET', null, token)).data.token;
    assert.equal(agentToken.length, 64);
    assert.equal((await request('/api/pc', 'POST', { cpu: 21, gpu: null }, agentToken)).status, 200);
    assert.equal((await request('/api/snapshot')).data.pc.gpu, null);

    const task = (await request('/api/todos', 'POST', { text: 'Daily task', repeat: 'daily' }, token)).data;
    assert.equal((await request(`/api/todos/${task.id}`, 'PATCH', { done: true }, token)).status, 200);
    assert.equal((await request('/api/todos')).data.find(t => t.id === task.id).done, true);
    const second = (await request('/api/todos', 'POST', { text: 'Second task' }, token)).data;
    await request(`/api/todos/${task.id}`, 'PATCH', { action: 'up' }, token);
    const ordered = (await request('/api/todos')).data;
    assert.ok(ordered.findIndex(t => t.id === task.id) < ordered.findIndex(t => t.id === second.id));
    const due = Date.now() + 120000;
    const planned = (await request('/api/todos', 'POST', { text: 'Due soon', dueAt: due, priority: 'high' }, token)).data;
    assert.equal((await request('/api/todos')).data.find(t => t.id === planned.id).dueAt, due);
    assert.equal((await request(`/api/todos/${planned.id}`, 'PATCH', { priority: 'low', dueAt: null }, token)).data.priority, 'low');
    assert.equal((await request('/api/todos')).data.find(t => t.id === planned.id).dueAt, null);
    const repeating = (await request('/api/todos', 'POST', { text: 'Weekly reminder', repeat: 'weekly', dueTime: '18:30', dueWeekday: 2 }, token)).data;
    assert.ok(Number.isFinite((await request('/api/todos')).data.find(t => t.id === repeating.id).dueAt));
    assert.equal((await request('/api/todos', 'POST', { text: 'Bad time', repeat: 'daily', dueTime: '28:99' }, token)).status, 400);

    assert.equal((await request('/api/note', 'POST', { text: 'Buy milk' })).status, 401);
    assert.equal((await request('/api/note', 'POST', { text: 'Buy milk' }, token)).status, 200);
    assert.equal((await request('/api/snapshot')).data.note.text, 'Buy milk');
    const routine = (await request('/api/routines', 'POST', { name: 'Morning', repeat: 'daily' }, token)).data;
    const step = (await request(`/api/routines/${routine.id}/items`, 'POST', { text: 'Drink water' }, token)).data;
    assert.equal((await request(`/api/routines/${routine.id}/items/${step.id}`, 'PATCH', { done: true }, token)).status, 200);
    assert.equal((await request('/api/snapshot')).data.routines[0].items[0].done, true);

    const timer = (await request('/api/timers', 'POST', {
      name: 'Focus', type: 'short', hours: 0, mins: 25
    }, token)).data;
    assert.equal((await request(`/api/timers/${timer.id}`, 'PATCH', { action: 'pause' }, token)).data.targetAt, null);
    assert.ok((await request(`/api/timers/${timer.id}`, 'PATCH', { action: 'resume' }, token)).data.targetAt);
    assert.equal((await request(`/api/timers/${timer.id}`, 'PATCH', {
      name: 'Deep focus', targetAt: Date.now() + 1800000
    }, token)).data.name, 'Deep focus');

    assert.equal((await request('/api/settings', 'POST', { icsUrl: calendarUrl }, token)).status, 200);
    assert.equal((await request('/api/calendar')).data.next.summary, 'Private meeting');
    assert.equal((await request('/api/display', 'POST', {
      privacy: true, mode: 'focus', textSize: 'large', showPC: false
    }, token)).status, 200);
    assert.equal((await request('/api/calendar')).data.next.summary, 'Private event');
    assert.equal((await request('/api/snapshot')).data.calendar.next.location, '');

    const exported = await request('/api/export', 'GET', null, token);
    assert.equal(exported.data.format, 'tablet-dashboard-v2');
    assert.equal(exported.data.note.text, 'Buy milk');
    assert.equal(exported.data.routines[0].items[0].text, 'Drink water');
    assert.ok(!JSON.stringify(exported.data).includes(calendarUrl));
    await request(`/api/todos/${task.id}`, 'DELETE', null, token);
    assert.equal((await request('/api/import', 'POST', exported.data, token)).status, 200);
    assert.ok((await request('/api/todos')).data.some(t => t.text === 'Daily task'));
    assert.equal((await request('/api/snapshot')).data.note.text, 'Buy milk');
    assert.equal((await request('/api/snapshot')).data.routines[0].items[0].done, true);
    const oldExport = { ...exported.data, format: 'tablet-dashboard-v1' };
    delete oldExport.note; delete oldExport.routines;
    assert.equal((await request('/api/import', 'POST', oldExport, token)).status, 200);
    assert.equal((await request('/api/snapshot')).data.note.text, 'Buy milk');

    await stopDashboard(dashboard.child);
    fs.writeFileSync(path.join(dataDir, 'db.json'), '{broken');
    dashboard = await startDashboard(dataDir, port);
    const login = await fetch(dashboard.base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'tester', pass: 'a-long-test-password' })
    });
    assert.equal(login.status, 200);
  } finally {
    if (dashboard) await stopDashboard(dashboard.child);
    await new Promise(resolve => calendarServer.close(resolve));
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
