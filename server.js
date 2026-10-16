require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const ics = require('./lib/ics');

// ---- Config ----
const PORT = process.env.PORT || 1200;
// Optional legacy fallback login — ONLY active when both vars are explicitly set.
// (Removed from compose/.env.example so first-boot setup page is the normal path.)
const ENV_ADMIN_USER = process.env.ADMIN_USER || null;
const ENV_ADMIN_PASS = process.env.ADMIN_PASS || null;
// 6th of October City, Giza, Egypt
const WEATHER_LAT = process.env.WEATHER_LAT || '29.9668';
const WEATHER_LON = process.env.WEATHER_LON || '30.9333';

const app = express();
app.use(express.json({ limit: '256kb' }));

// ---- Tiny JSON file DB (no native deps, Docker + Windows friendly) ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_FILE = path.join(DATA_DIR, 'db.json.bak');
const DEFAULT_EMPTY_MSG = 'You have nothing to do now, sir';
const DEFAULT_DISPLAY = {
  mode: 'overview', textSize: 'normal', privacy: false,
  showPC: true, showTimers: true, showTodos: true, showCalendar: true,
  quietEnabled: false, quietStart: '23:00', quietEnd: '07:00',
  emptyMsg: DEFAULT_EMPTY_MSG
};

function defaultDb() {
  return {
    todos: [
      { id: '1', text: 'Test tablet in kiosk mode', done: false, createdAt: Date.now() },
      { id: '2', text: 'Set long-term timer from /admin', done: false, createdAt: Date.now() }
    ],
    timers: [
      // { id, name, type: 'long'|'short', targetAt, createdAt, done, pausedLeftSec }
      { id: 'long1', name: 'Long term', type: 'long', targetAt: Date.now() + 12 * 24 * 3600 * 1000, createdAt: Date.now(), done: false, pausedLeftSec: null }
    ],
    pc: {
      cpu: 0, ram: 0, gpu: 0, gpuTemp: null, cpuTemp: null,
      uptimeSec: 0, disks: [], updatedAt: 0
    },
    weather: { temp: null, code: null, label: '—', isDay: null, high: null, low: null, rainChance: null, updatedAt: 0 },
    time: { offsetSec: 0, updatedAt: 0 }, // dashboard clock = real time + offset (set from /admin)
    settings: { icsUrl: '' }, // Google Calendar private ICS URL (set from /admin)
    calendar: { next: null, upcoming: [], updatedAt: 0, error: null, configured: false },
    users: [], // { user, salt, hash, createdAt } — created via first-boot setup page
    agentToken: crypto.randomBytes(32).toString('hex'),
    display: { ...DEFAULT_DISPLAY },
    note: { text: '', updatedAt: 0 },
    routines: []
  };
}

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) {
      console.error('db load failed:', e.message);
      if (fs.existsSync(BACKUP_FILE)) {
        try {
          const restored = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
          fs.copyFileSync(BACKUP_FILE, DB_FILE);
          console.error('restored last backup');
          return restored;
        }
        catch (backupError) { console.error('backup load failed:', backupError.message); }
      }
      throw new Error('Database and backup could not be loaded; refusing to reset user data');
    }
  }
  if (fs.existsSync(BACKUP_FILE)) {
    const restored = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    fs.copyFileSync(BACKUP_FILE, DB_FILE);
    return restored;
  }
  const d = defaultDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
  return d;
}
let db = loadDb();
// migrate old db.json files that predate users[]
if (!Array.isArray(db.users)) { db.users = []; saveDb(); }
if (!db.time || typeof db.time.offsetSec !== 'number') { db.time = { offsetSec: 0, updatedAt: 0 }; saveDb(); }
if (!db.settings || typeof db.settings.icsUrl !== 'string') { db.settings = { icsUrl: '' }; saveDb(); }
if (!db.calendar || typeof db.calendar !== 'object') { db.calendar = { next: null, upcoming: [], updatedAt: 0, error: null, configured: false }; saveDb(); }
if (!Array.isArray(db.calendar.upcoming)) { db.calendar.upcoming = []; saveDb(); }
if (!db.agentToken) { db.agentToken = crypto.randomBytes(32).toString('hex'); saveDb(); }
if (!db.display) { db.display = { ...DEFAULT_DISPLAY }; saveDb(); }
if (!db.note || typeof db.note.text !== 'string') { db.note = { text: '', updatedAt: 0 }; saveDb(); }
if (!Array.isArray(db.routines)) { db.routines = []; saveDb(); }
// migrate old single long/short timer object -> named timers array
if (db.timers && !Array.isArray(db.timers)) {
  const arr = [];
  const old = db.timers;
  if (old.long && old.long.targetAt) arr.push({
    id: 'long' + Date.now().toString(36), name: String(old.long.label || 'Long term').slice(0, 60),
    type: 'long', targetAt: Number(old.long.targetAt), createdAt: Number(old.long.createdAt) || Date.now(),
    done: false, pausedLeftSec: null
  });
  if (old.short && (old.short.endsAt || old.short.pausedLeftSec != null)) {
    const left = old.short.endsAt ? Math.max(0, Math.round((old.short.endsAt - Date.now()) / 1000)) : old.short.pausedLeftSec;
    arr.push({
      id: 'short' + Date.now().toString(36), name: String(old.short.label || 'Focus').slice(0, 60),
      type: 'short', targetAt: old.short.endsAt ? Number(old.short.endsAt) : null,
      createdAt: Date.now(), done: false, pausedLeftSec: old.short.endsAt ? null : left
    });
  }
  db.timers = arr; saveDb();
}
function saveDb() {
  const temp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(db, null, 2));
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, BACKUP_FILE);
    fs.renameSync(temp, DB_FILE);
  } catch (e) {
    console.error('db save failed:', e);
    throw e;
  }
}
setInterval(() => { try { saveDb(); } catch {} }, 15 * 1000);

// ---- SSE clients ----
const sseClients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ---- Password hashing (scrypt, stdlib only) ----
function hashPass(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPass(pass, salt, hash) {
  try {
    const h = crypto.scryptSync(String(pass), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}
// Returns true if creds match a stored user OR the explicit env fallback.
function verifyUser(user, pass) {
  if (!user || pass == null) return false;
  const u = (db.users || []).find(x => x.user === String(user));
  if (u) return checkPass(pass, u.salt, u.hash);
  // env fallback only when explicitly configured (never the old hardcoded default)
  if (ENV_ADMIN_USER && ENV_ADMIN_PASS) return user === ENV_ADMIN_USER && pass === ENV_ADMIN_PASS;
  return false;
}
function needsSetup() { return (db.users || []).length === 0; }

// ---- Token auth for /admin APIs (custom login page, no browser popup) ----
const sessions = new Map(); // token -> expiresAt (ms)
const SESSION_TTL = 7 * 24 * 3600 * 1000;

function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}
function validToken(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}
// Accepts: Authorization: Bearer <token>  (login page)
// Fallback: Basic user:pass (scripts / curl). Never sends WWW-Authenticate
// so browsers won't show the native popup.
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const [scheme, cred] = h.split(' ');
  if (scheme === 'Bearer' && validToken(cred)) return next();
  if (scheme === 'Basic' && cred) {
    try {
      const decoded = Buffer.from(cred, 'base64').toString();
      const idx = decoded.indexOf(':');
      if (idx >= 0 && verifyUser(decoded.slice(0, idx), decoded.slice(idx + 1))) return next();
    } catch { /* bad base64 */ }
  }
  return res.status(401).json({ error: 'Login required' });
}

// ---- Static ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---- First-boot setup + login / logout / me ----
app.post('/api/setup', (req, res) => {
  if (!needsSetup()) return res.status(403).json({ error: 'Admin already exists' });
  const user = String(req.body.user || '').trim().slice(0, 32);
  const pass = String(req.body.pass || '');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(user)) return res.status(400).json({ error: 'Username: 3-32 chars, letters/numbers/._-' });
  if (pass.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const { salt, hash } = hashPass(pass);
  db.users.push({ user, salt, hash, createdAt: Date.now() });
  saveDb();
  const token = issueToken();
  res.json({ ok: true, token, expiresInSec: Math.round(SESSION_TTL / 1000) });
});
app.post('/api/login', (req, res) => {
  if (needsSetup()) return res.status(403).json({ error: 'No admin yet — create one first', needsSetup: true });
  const { user, pass } = req.body || {};
  if (verifyUser(user, pass)) {
    const token = issueToken();
    return res.json({ ok: true, token, expiresInSec: Math.round(SESSION_TTL / 1000) });
  }
  // tiny delay to slow brute force
  setTimeout(() => res.status(401).json({ error: 'Wrong username or password' }), 400);
});
app.post('/api/logout', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  res.json({ loggedIn: validToken(token), needsSetup: needsSetup() });
});

// ---- Health ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, now: Date.now(), sseClients: sseClients.size, pcAgeSec: (Date.now() - (db.pc.updatedAt || 0)) / 1000 });
});

// ---- SSE stream (tablet subscribes) ----
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
  sseClients.add(res);
  // push current snapshot immediately
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  const heartbeat = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`); }
    catch { clearInterval(heartbeat); sseClients.delete(res); }
  }, 15000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

function publicCalendar() {
  if (!db.display.privacy) return db.calendar;
  const redact = e => e ? { ...e, summary: 'Private event', location: '' } : null;
  return { ...db.calendar, next: redact(db.calendar.next), upcoming: db.calendar.upcoming.map(redact) };
}
function snapshot() {
  rolloverTodos();
  return { now: Date.now(), pc: db.pc, todos: todosForClient(), timers: sortTimers(db.timers),
    weather: db.weather, time: db.time, calendar: publicCalendar(), display: db.display,
    note: db.note, routines: routinesForClient() };
}
app.get('/api/snapshot', (req, res) => res.json(snapshot()));

// ---- PC stats: agent POSTs here every ~2s ----
app.post('/api/pc', (req, res) => {
  if (req.get('Authorization') !== `Bearer ${db.agentToken}`) return res.status(401).json({ error: 'Agent token required' });
  const b = req.body || {};
  db.pc = {
    cpu: num(b.cpu, 0),
    ram: num(b.ram, 0),
    gpu: b.gpu == null ? null : num(b.gpu, null),
    gpuTemp: b.gpuTemp ?? null,
    cpuTemp: b.cpuTemp ?? null,
    uptimeSec: num(b.uptimeSec, 0),
    disks: Array.isArray(b.disks) ? b.disks.slice(0, 8) : db.pc.disks,
    updatedAt: Date.now()
  };
  // lightweight: don't fsync every 2s, just broadcast
  broadcast('pc', db.pc);
  res.json({ ok: true });
});
app.get('/api/pc', (req, res) => res.json(db.pc));

// ---- Todos ----
const cairoDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const cairoClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function dayKey(now = Date.now()) {
  const parts = Object.fromEntries(cairoDate.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function weekKey(now = Date.now()) {
  const day = new Date(dayKey(now) + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}
function addDays(day, count) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function cairoTimestamp(day, time) {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wanted = Date.UTC(year, month - 1, date, hour, minute);
  let guess = wanted - 2 * 3600000;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(cairoClock.formatToParts(guess).map(x => [x.type, Number(x.value)]));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wanted - shown;
  }
  return guess;
}
function todoDueAt(t, now = Date.now()) {
  if (t.repeat === 'none' || !t.repeat) return Number.isFinite(t.dueAt) ? t.dueAt : null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.dueTime || '')) return null;
  if (t.repeat === 'daily') return cairoTimestamp(dayKey(now), t.dueTime);
  const monday = new Date(weekKey(now) + 'T00:00:00Z');
  monday.setUTCDate(monday.getUTCDate() + (Number.isInteger(t.dueWeekday) ? t.dueWeekday : 0));
  return cairoTimestamp(monday.toISOString().slice(0, 10), t.dueTime);
}
function validDueAt(value) {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 8640000000000000 ? n : undefined;
}
function validDueTime(value) { return value === '' || value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function todoDone(t) {
  if (t.repeat === 'daily') return t.doneOn === dayKey();
  if (t.repeat === 'weekly') return t.doneOn === weekKey();
  return !!t.done;
}
function todosForClient() {
  return [...db.todos].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(t => ({ ...t, done: todoDone(t), dueAt: todoDueAt(t) }));
}
function rolloverTodos() {
  const key = dayKey();
  if (rolloverTodos.last === key) return;
  rolloverTodos.last = key;
  if (db.todos.some(t => t.repeat && t.repeat !== 'none')) broadcast('todos', todosForClient());
  if (db.routines.length) broadcast('routines', routinesForClient());
}
function broadcastTodos() { broadcast('todos', todosForClient()); }
setInterval(rolloverTodos, 60000);
app.get('/api/todos', (req, res) => res.json(todosForClient()));
app.post('/api/todos', adminAuth, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'text required' });
  const repeat = ['none', 'daily', 'weekly'].includes(req.body.repeat) ? req.body.repeat : 'none';
  const dueAt = validDueAt(req.body.dueAt ?? null);
  if (dueAt === undefined || !validDueTime(req.body.dueTime ?? '')) return res.status(400).json({ error: 'Invalid due date or time' });
  const dueWeekday = Number(req.body.dueWeekday ?? 0);
  if (!Number.isInteger(dueWeekday) || dueWeekday < 0 || dueWeekday > 6) return res.status(400).json({ error: 'Invalid weekday' });
  const item = { id: crypto.randomUUID(), text, done: false, repeat, doneOn: null,
    dueAt: repeat === 'none' ? dueAt : null, dueTime: repeat === 'none' ? null : (req.body.dueTime || null), dueWeekday,
    priority: ['high', 'normal', 'low'].includes(req.body.priority) ? req.body.priority : 'normal',
    order: Math.min(0, ...db.todos.map(t => t.order ?? 0)) - 1, createdAt: Date.now() };
  db.todos.unshift(item);
  db.todos = db.todos.slice(0, 50);
  saveDb(); broadcastTodos();
  res.json(item);
});
app.patch('/api/todos/:id', adminAuth, (req, res) => {
  const t = db.todos.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (req.body.action === 'moveToday' || req.body.action === 'moveTomorrow') {
    if ((t.repeat && t.repeat !== 'none') || todoDone(t) || !Number.isFinite(t.dueAt) || t.dueAt >= Date.now()) {
      return res.status(409).json({ error: 'Only overdue one-time tasks can be rescheduled here' });
    }
    if (req.body.action === 'moveToday') {
      const endOfToday = cairoTimestamp(addDays(dayKey(), 1), '00:00');
      const target = Math.min(Date.now() + 3600000, endOfToday - 60000);
      if (target <= Date.now() + 60000) return res.status(409).json({ error: 'Too late today; choose tomorrow or Schedule' });
      t.dueAt = target;
    } else t.dueAt = cairoTimestamp(addDays(dayKey(), 1), '09:00');
    saveDb(); broadcastTodos();
    return res.json({ ...t, dueAt: todoDueAt(t) });
  }
  if (req.body.priority !== undefined && !['high', 'normal', 'low'].includes(req.body.priority)) return res.status(400).json({ error: 'Invalid priority' });
  if (req.body.dueAt !== undefined && validDueAt(req.body.dueAt) === undefined) return res.status(400).json({ error: 'Invalid due date' });
  if (req.body.dueTime !== undefined && !validDueTime(req.body.dueTime)) return res.status(400).json({ error: 'Invalid due time' });
  if (req.body.dueWeekday !== undefined && (!Number.isInteger(Number(req.body.dueWeekday)) || Number(req.body.dueWeekday) < 0 || Number(req.body.dueWeekday) > 6)) return res.status(400).json({ error: 'Invalid weekday' });
  if (typeof req.body.done === 'boolean') {
    if (t.repeat === 'daily') t.doneOn = req.body.done ? dayKey() : null;
    else if (t.repeat === 'weekly') t.doneOn = req.body.done ? weekKey() : null;
    else t.done = req.body.done;
  }
  if (typeof req.body.text === 'string' && req.body.text.trim()) t.text = req.body.text.trim().slice(0, 200);
  if (['none', 'daily', 'weekly'].includes(req.body.repeat)) {
    t.repeat = req.body.repeat; t.done = false; t.doneOn = null;
  }
  if (req.body.priority !== undefined) {
    if (!['high', 'normal', 'low'].includes(req.body.priority)) return res.status(400).json({ error: 'Invalid priority' });
    t.priority = req.body.priority;
  }
  if (req.body.dueAt !== undefined) {
    const dueAt = validDueAt(req.body.dueAt);
    if (dueAt === undefined) return res.status(400).json({ error: 'Invalid due date' });
    t.dueAt = dueAt;
  }
  if (req.body.dueTime !== undefined) {
    if (!validDueTime(req.body.dueTime)) return res.status(400).json({ error: 'Invalid due time' });
    t.dueTime = req.body.dueTime || null;
  }
  if (req.body.dueWeekday !== undefined) {
    const weekday = Number(req.body.dueWeekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: 'Invalid weekday' });
    t.dueWeekday = weekday;
  }
  if (req.body.action === 'up' || req.body.action === 'down') {
    const ordered = [...db.todos].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const index = ordered.indexOf(t), next = index + (req.body.action === 'up' ? -1 : 1);
    if (next >= 0 && next < ordered.length) {
      [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
      ordered.forEach((item, pos) => { item.order = pos; });
    }
  }
  saveDb(); broadcastTodos();
  res.json(t);
});
app.delete('/api/todos/:id', adminAuth, (req, res) => {
  db.todos = db.todos.filter(x => x.id !== req.params.id);
  saveDb(); broadcastTodos();
  res.json({ ok: true });
});

// ---- Pinned note and repeating checklists ----
function routinesForClient() {
  return db.routines.map(r => ({ ...r, items: r.items.map(item => ({
    ...item, done: item.doneOn === (r.repeat === 'weekly' ? weekKey() : dayKey())
  })) }));
}
function broadcastRoutines() { broadcast('routines', routinesForClient()); }
app.get('/api/note', (req, res) => res.json(db.note));
app.post('/api/note', adminAuth, (req, res) => {
  if (typeof req.body?.text !== 'string' || req.body.text.length > 1000) return res.status(400).json({ error: 'Note must be at most 1000 characters' });
  db.note = { text: req.body.text.trim(), updatedAt: Date.now() };
  saveDb(); broadcast('note', db.note); res.json(db.note);
});
app.get('/api/routines', (req, res) => res.json(routinesForClient()));
app.post('/api/routines', adminAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name || db.routines.length >= 10) return res.status(400).json({ error: 'Name required, maximum 10 routines' });
  const routine = { id: crypto.randomUUID(), name, repeat: req.body.repeat === 'weekly' ? 'weekly' : 'daily', items: [] };
  db.routines.push(routine); saveDb(); broadcastRoutines(); res.json(routine);
});
app.patch('/api/routines/:id', adminAuth, (req, res) => {
  const routine = db.routines.find(r => r.id === req.params.id);
  if (!routine) return res.status(404).json({ error: 'Routine not found' });
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Name required' });
    routine.name = name;
  }
  if (req.body.repeat !== undefined) {
    if (!['daily', 'weekly'].includes(req.body.repeat)) return res.status(400).json({ error: 'Invalid repeat' });
    if (routine.repeat !== req.body.repeat) routine.items.forEach(item => { item.doneOn = null; });
    routine.repeat = req.body.repeat;
  }
  saveDb(); broadcastRoutines(); res.json(routine);
});
app.delete('/api/routines/:id', adminAuth, (req, res) => {
  const before = db.routines.length;
  db.routines = db.routines.filter(r => r.id !== req.params.id);
  if (db.routines.length === before) return res.status(404).json({ error: 'Routine not found' });
  saveDb(); broadcastRoutines(); res.json({ ok: true });
});
app.post('/api/routines/:id/items', adminAuth, (req, res) => {
  const routine = db.routines.find(r => r.id === req.params.id);
  if (!routine) return res.status(404).json({ error: 'Routine not found' });
  const text = String(req.body?.text || '').trim().slice(0, 120);
  if (!text || routine.items.length >= 20) return res.status(400).json({ error: 'Text required, maximum 20 steps' });
  const item = { id: crypto.randomUUID(), text, doneOn: null };
  routine.items.push(item); saveDb(); broadcastRoutines(); res.json(item);
});
app.patch('/api/routines/:id/items/:itemId', adminAuth, (req, res) => {
  const routine = db.routines.find(r => r.id === req.params.id);
  const item = routine?.items.find(i => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Step not found' });
  if (typeof req.body.done === 'boolean') item.doneOn = req.body.done ? (routine.repeat === 'weekly' ? weekKey() : dayKey()) : null;
  if (req.body.text !== undefined) {
    const value = String(req.body.text).trim().slice(0, 120);
    if (!value) return res.status(400).json({ error: 'Text required' });
    item.text = value;
  }
  saveDb(); broadcastRoutines(); res.json(item);
});
app.delete('/api/routines/:id/items/:itemId', adminAuth, (req, res) => {
  const routine = db.routines.find(r => r.id === req.params.id);
  if (!routine) return res.status(404).json({ error: 'Routine not found' });
  routine.items = routine.items.filter(i => i.id !== req.params.itemId);
  saveDb(); broadcastRoutines(); res.json({ ok: true });
});

// ---- Display preferences and portable user data ----
function cleanDisplay(input) {
  const next = { ...DEFAULT_DISPLAY, ...db.display };
  if (['overview', 'focus'].includes(input.mode)) next.mode = input.mode;
  if (['normal', 'large'].includes(input.textSize)) next.textSize = input.textSize;
  for (const key of ['privacy', 'showPC', 'showTimers', 'showTodos', 'showCalendar', 'quietEnabled']) {
    if (typeof input[key] === 'boolean') next[key] = input[key];
  }
  for (const key of ['quietStart', 'quietEnd']) {
    if (typeof input[key] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input[key])) next[key] = input[key];
  }
  if (typeof input.emptyMsg === 'string') {
    const t = input.emptyMsg.trim().slice(0, 120);
    next.emptyMsg = t || DEFAULT_EMPTY_MSG;
  }
  if (!next.showPC && !next.showTimers && !next.showTodos && !next.showCalendar) next.showTodos = true;
  return next;
}
app.get('/api/display', (req, res) => res.json(db.display));
app.post('/api/display', adminAuth, (req, res) => {
  db.display = cleanDisplay(req.body || {});
  saveDb(); broadcast('display', db.display); broadcast('calendar', publicCalendar());
  res.json(db.display);
});
app.get('/api/agent-token', adminAuth, (req, res) => res.json({ token: db.agentToken }));
app.get('/api/export', adminAuth, (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="tablet-dashboard-export.json"');
  res.json({ format: 'tablet-dashboard-v2', exportedAt: new Date().toISOString(),
    todos: db.todos, timers: db.timers, display: db.display, note: db.note, routines: db.routines });
});
app.post('/api/import', adminAuth, (req, res) => {
  const data = req.body || {};
  if (!['tablet-dashboard-v1', 'tablet-dashboard-v2'].includes(data.format) || !Array.isArray(data.todos) || !Array.isArray(data.timers)
      || data.todos.length > 50 || data.timers.length > 20
      || (data.routines !== undefined && (!Array.isArray(data.routines) || data.routines.length > 10
        || data.routines.some(r => !Array.isArray(r.items) || r.items.length > 20)))) {
    return res.status(400).json({ error: 'Invalid dashboard export' });
  }
  const todos = data.todos.map((t, i) => ({
    id: crypto.randomUUID(), text: String(t.text || '').trim().slice(0, 200),
    done: !!t.done, repeat: ['daily', 'weekly'].includes(t.repeat) ? t.repeat : 'none',
    doneOn: typeof t.doneOn === 'string' ? t.doneOn.slice(0, 10) : null,
    order: i, createdAt: Number(t.createdAt) || Date.now(),
    dueAt: validDueAt(t.dueAt) ?? null,
    dueTime: validDueTime(t.dueTime ?? '') ? (t.dueTime || null) : null,
    dueWeekday: Number.isInteger(t.dueWeekday) && t.dueWeekday >= 0 && t.dueWeekday <= 6 ? t.dueWeekday : 0,
    priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal'
  }));
  const timers = data.timers.map(t => ({
    id: makeTimerId(), name: String(t.name || '').trim().slice(0, 60),
    type: t.type === 'short' ? 'short' : 'long',
    targetAt: Number.isFinite(Number(t.targetAt)) && t.targetAt != null ? Number(t.targetAt) : null,
    createdAt: Number(t.createdAt) || Date.now(), done: !!t.done,
    pausedLeftSec: Number.isFinite(Number(t.pausedLeftSec)) && t.pausedLeftSec != null ? Number(t.pausedLeftSec) : null,
    durationSec: Number.isFinite(Number(t.durationSec)) && t.durationSec != null ? Number(t.durationSec) : null,
    color: cleanColor(t.color)
  }));
  if (todos.some(t => !t.text) || timers.some(t => !t.name)) return res.status(400).json({ error: 'Export contains empty items' });
  const routines = (data.routines || []).map(r => ({
    id: crypto.randomUUID(), name: String(r.name || '').trim().slice(0, 80),
    repeat: r.repeat === 'weekly' ? 'weekly' : 'daily',
    items: r.items.map(item => ({ id: crypto.randomUUID(), text: String(item.text || '').trim().slice(0, 120),
      doneOn: typeof item.doneOn === 'string' ? item.doneOn.slice(0, 10) : null }))
  }));
  if (routines.some(r => !r.name || r.items.some(i => !i.text))) return res.status(400).json({ error: 'Export contains empty routine items' });
  db.todos = todos; db.timers = timers; db.display = cleanDisplay(data.display || {});
  if (data.format === 'tablet-dashboard-v2') {
    db.note = { text: String(data.note?.text || '').slice(0, 1000), updatedAt: Date.now() };
    db.routines = routines;
  }
  saveDb(); broadcastTodos(); broadcast('timers', sortTimers(db.timers));
  broadcast('note', db.note); broadcastRoutines();
  broadcast('display', db.display); broadcast('calendar', publicCalendar());
  res.json({ ok: true, todos: todos.length, timers: timers.length });
});

// ---- Timers (multiple, each with a name) ----
// Timer: { id, name, type: 'long'|'short', targetAt|null, createdAt, done, pausedLeftSec|null }
// long  = target date (set days-from-now or a date) -> kiosk counts days left
// short = same-day countdown (set duration H/M or a clock time like 18:30)
function sortTimers(list) {
  return [...list].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    const at = a.targetAt || Infinity, bt = b.targetAt || Infinity;
    return at - bt;
  });
}
function makeTimerId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function cleanColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c) : null;
}
app.get('/api/timers', (req, res) => res.json(sortTimers(db.timers || [])));
app.post('/api/timers', adminAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  const type = b.type === 'short' ? 'short' : 'long';
  let targetAt = null;
  const extra = {};
  if (type === 'long') {
    if (b.targetAt) targetAt = Number(b.targetAt);
    else if (b.date) { const t = new Date(b.date).getTime(); if (Number.isFinite(t)) targetAt = t; }
    else if (b.days) targetAt = Date.now() + Number(b.days) * 24 * 3600 * 1000;
    if (!targetAt || !Number.isFinite(targetAt)) return res.status(400).json({ error: 'days, date or targetAt required' });
  } else {
    if (b.targetAt != null) {
      targetAt = Number(b.targetAt);
      if (!Number.isFinite(targetAt) || targetAt <= Date.now()) return res.status(400).json({ error: 'Choose a future end time' });
      extra.durationSec = Math.round((targetAt - Date.now()) / 1000);
    } else if (b.atTime && /^\d{1,2}:\d{2}$/.test(String(b.atTime))) {
      // clock time today (Africa/Cairo wall clock approximated via server local time)
      const [hh, mm] = String(b.atTime).split(':').map(Number);
      const d = new Date(); d.setHours(hh, mm, 0, 0);
      targetAt = d.getTime();
      if (targetAt <= Date.now()) targetAt += 24 * 3600 * 1000; // passed -> tomorrow
    } else {
      const h = Number(b.hours || 0), m = Number(b.mins || 0);
      const dur = Math.max(60, h * 3600 + m * 60);
      if (!Number.isFinite(dur)) return res.status(400).json({ error: 'hours/mins or atTime required' });
      targetAt = Date.now() + dur * 1000;
      extra.durationSec = Math.round(dur);
    }
  }
  const t = { id: makeTimerId(), name, type, targetAt, createdAt: Date.now(), done: false, pausedLeftSec: null, color: cleanColor(b.color), ...extra };
  db.timers = [...(db.timers || []), t].slice(-20);
  saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(t);
});
app.patch('/api/timers/:id', adminAuth, (req, res) => {
  const t = (db.timers || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 60);
  if (typeof b.targetAt !== 'undefined') {
    const target = Number(b.targetAt);
    if (!Number.isFinite(target) || target <= Date.now()) return res.status(400).json({ error: 'Choose a future end time' });
    t.targetAt = target; t.pausedLeftSec = null; t.createdAt = Date.now(); t.done = false;
    if (t.type === 'short') t.durationSec = Math.round((target - t.createdAt) / 1000);
  }
  if (typeof b.done === 'boolean') t.done = b.done;
  if (typeof b.color !== 'undefined') t.color = cleanColor(b.color);
  if (b.action === 'pause' && t.targetAt) {
    t.pausedLeftSec = Math.max(0, Math.round((t.targetAt - Date.now()) / 1000));
    t.targetAt = null;
  } else if (b.action === 'resume' && t.pausedLeftSec != null) {
    t.targetAt = Date.now() + t.pausedLeftSec * 1000; t.pausedLeftSec = null;
  } else if (b.action === 'reset') {
    t.targetAt = null; t.pausedLeftSec = null; t.done = false;
  } else if (b.action === 'restart' && t.targetAt == null && t.pausedLeftSec == null) {
    // re-arm a finished short with its original duration when known
    if (typeof b.hours !== 'undefined' || typeof b.mins !== 'undefined') {
      const dur = Math.max(60, Number(b.hours || 0) * 3600 + Number(b.mins || 0) * 60);
      t.targetAt = Date.now() + dur * 1000; t.done = false;
    }
  }
  saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(t);
});
app.delete('/api/timers/:id', adminAuth, (req, res) => {
  db.timers = (db.timers || []).filter(x => x.id !== req.params.id);
  saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json({ ok: true });
});
// Legacy compat: old clients posting single long/short map onto named timers.
app.post('/api/timers/long', adminAuth, (req, res) => {
  let targetAt = req.body.targetAt;
  if (!targetAt && req.body.days) targetAt = Date.now() + Number(req.body.days) * 24 * 3600 * 1000;
  if (!targetAt) return res.status(400).json({ error: 'days or targetAt required' });
  const name = String(req.body.label || 'Long term').slice(0, 60);
  let t = (db.timers || []).find(x => x.type === 'long' && x.name === name && !x.done);
  if (t) { t.targetAt = Number(targetAt); }
  else { t = { id: makeTimerId(), name, type: 'long', targetAt: Number(targetAt), createdAt: Date.now(), done: false, pausedLeftSec: null }; db.timers.push(t); }
  saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(t);
});
app.post('/api/timers/short', adminAuth, (req, res) => {
  const { action } = req.body;
  const name = String(req.body.label || 'Focus').slice(0, 60);
  const shorts = (db.timers || []).filter(x => x.type === 'short');
  let s = shorts.find(x => x.name === name && !x.done) || shorts.filter(x => !x.done).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (action === 'start') {
    const h = Number(req.body.hours || 0), m = Number(req.body.mins || 25);
    const dur = Math.max(60, h * 3600 + m * 60);
    if (s && s.name === name) { s.targetAt = Date.now() + dur * 1000; s.pausedLeftSec = null; s.done = false; s.durationSec = Math.round(dur); }
    else { s = { id: makeTimerId(), name, type: 'short', targetAt: Date.now() + dur * 1000, createdAt: Date.now(), done: false, pausedLeftSec: null, durationSec: Math.round(dur) }; db.timers.push(s); }
  } else if (!s) return res.status(404).json({ error: 'no short timer' });
  else if (action === 'pause' && s.targetAt) {
    s.pausedLeftSec = Math.max(0, Math.round((s.targetAt - Date.now()) / 1000));
    s.targetAt = null;
  } else if (action === 'resume' && s.pausedLeftSec != null) {
    s.targetAt = Date.now() + s.pausedLeftSec * 1000; s.pausedLeftSec = null;
  } else if (action === 'reset') {
    s.targetAt = null; s.pausedLeftSec = null;
  } else return res.status(400).json({ error: 'bad action' });
  saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(s);
});

// ---- Weather (Open-Meteo, cached 30 min). 6th October city coords ----
const WEATHER_META = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Storm', 96: 'Storm + hail', 99: 'Storm + hail'
};
async function refreshWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=Africa%2FCairo`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const j = await r.json();
    const temp = Number(j.current?.temperature_2m);
    const code = Number(j.current?.weather_code);
    if (j.current?.temperature_2m == null || j.current?.weather_code == null || !Number.isFinite(temp) || !Number.isInteger(code)) {
      throw new Error('Invalid Open-Meteo response');
    }
    const dailyNumber = (values, minimum, maximum) => {
      const value = values?.[0];
      return value != null && Number.isFinite(Number(value)) && Number(value) >= minimum && Number(value) <= maximum
        ? Math.round(Number(value)) : null;
    };
    db.weather = {
      temp: Math.round(temp),
      code,
      label: WEATHER_META[code] || 'Weather',
      isDay: j.current.is_day == null ? null : Number(j.current.is_day) === 1,
      high: dailyNumber(j.daily?.temperature_2m_max, -100, 70),
      low: dailyNumber(j.daily?.temperature_2m_min, -100, 70),
      rainChance: dailyNumber(j.daily?.precipitation_probability_max, 0, 100),
      updatedAt: Date.now()
    };
    broadcast('weather', db.weather);
  } catch (e) { console.error('weather failed', e.message); }
}
app.get('/api/weather', async (req, res) => {
  if (Date.now() - (db.weather.updatedAt || 0) > 30 * 60 * 1000) await refreshWeather();
  res.json(db.weather);
});
refreshWeather();
setInterval(refreshWeather, 30 * 60 * 1000);

// ---- Dashboard clock override (set from /admin) ----
// Kiosk clock shows real time + offsetSec. Timers/countdowns always use real time.
app.get('/api/time', (req, res) => {
  res.json({ offsetSec: db.time.offsetSec || 0, dashboardNow: Date.now() + (db.time.offsetSec || 0) * 1000 });
});
app.post('/api/time', adminAuth, (req, res) => {
  const b = req.body || {};
  if (b.action === 'reset') {
    db.time = { offsetSec: 0, updatedAt: Date.now() };
  } else if (typeof b.offsetSec !== 'undefined') {
    const off = Math.max(-86400 * 365, Math.min(86400 * 365, Number(b.offsetSec) || 0));
    db.time = { offsetSec: Math.round(off), updatedAt: Date.now() };
  } else if (b.datetime) {
    // datetime-local string from admin, e.g. "2026-01-12T14:30"
    const t = new Date(b.datetime).getTime();
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'bad datetime' });
    db.time = { offsetSec: Math.round((t - Date.now()) / 1000), updatedAt: Date.now() };
  } else return res.status(400).json({ error: 'datetime, offsetSec or action=reset required' });
  saveDb(); broadcast('time', db.time);
  res.json({ offsetSec: db.time.offsetSec, dashboardNow: Date.now() + db.time.offsetSec * 1000 });
});
// ---- Google Calendar via private ICS URL (poll every 10 min) ----
async function refreshCalendar() {
  const url = (db.settings.icsUrl || '').trim();
  if (!url) {
    if (db.calendar.configured) { db.calendar = { next: null, upcoming: [], updatedAt: 0, error: null, configured: false }; broadcast('calendar', db.calendar); }
    return;
  }
  try {
    const text = await ics.fetchIcs(url);
    const events = ics.parseIcs(text);
    const now = Date.now();
    db.calendar = {
      next: ics.findNext(events, now),
      upcoming: ics.upcoming(events, now, 14, 100),
      updatedAt: now, error: null, configured: true
    };
    broadcast('calendar', publicCalendar());
  } catch (e) {
    console.error('calendar refresh failed:', e.message);
    db.calendar.error = String(e.message || e).slice(0, 160);
    db.calendar.configured = true;
    broadcast('calendar', publicCalendar());
  }
}
app.get('/api/calendar', (req, res) => res.json(publicCalendar()));
// ICS URL is secret (full read access) -> admin only, never sent to kiosk.
app.get('/api/settings', adminAuth, (req, res) => res.json({ icsUrl: db.settings.icsUrl || '' }));
app.post('/api/settings', adminAuth, async (req, res) => {
  const icsUrl = String(req.body.icsUrl || '').trim().slice(0, 2000);
  if (icsUrl && !/^https?:\/\/.+[./]/.test(icsUrl)) return res.status(400).json({ error: 'Must be an http(s) URL' });
  db.settings.icsUrl = icsUrl;
  saveDb();
  await refreshCalendar();
  res.json({ ok: true, calendar: db.calendar });
});
refreshCalendar();
setInterval(refreshCalendar, 10 * 60 * 1000);

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

app.listen(PORT, '0.0.0.0', () => {
  console.log(`tablet-dashboard v0.1 on http://0.0.0.0:${PORT}  (LAN + Tailscale OK)`);
  console.log(`kiosk: /   admin: /admin  ${needsSetup() ? 'NO ADMIN YET — open /admin to create one' : 'admin exists'}${ENV_ADMIN_USER ? ' (env fallback login enabled)' : ''}`);
});
