require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// ---- Tiny JSON file DB (no native deps, Docker + Windows friendly) ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

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
    weather: { temp: null, code: null, label: '—', updatedAt: 0 },
    time: { offsetSec: 0, updatedAt: 0 }, // dashboard clock = real time + offset (set from /admin)
    settings: { icsUrl: '' }, // Google Calendar private ICS URL (set from /admin)
    calendar: { next: null, upcoming: [], updatedAt: 0, error: null, configured: false },
    users: [] // { user, salt, hash, createdAt } — created via first-boot setup page
  };
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.error('db load failed, resetting', e.message); }
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
  fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {});
}
setInterval(saveDb, 15 * 1000);

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
  req.on('close', () => sseClients.delete(res));
});

function snapshot() {
  return { now: Date.now(), pc: db.pc, todos: db.todos, timers: db.timers, weather: db.weather, time: db.time, calendar: db.calendar };
}
app.get('/api/snapshot', (req, res) => res.json(snapshot()));

// ---- PC stats: agent POSTs here every ~2s ----
app.post('/api/pc', (req, res) => {
  const b = req.body || {};
  db.pc = {
    cpu: num(b.cpu, 0),
    ram: num(b.ram, 0),
    gpu: num(b.gpu, 0),
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
app.get('/api/todos', (req, res) => res.json(db.todos));
app.post('/api/todos', adminAuth, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'text required' });
  const item = { id: String(Date.now()), text, done: false, createdAt: Date.now() };
  db.todos.unshift(item);
  db.todos = db.todos.slice(0, 50);
  saveDb(); broadcast('todos', db.todos);
  res.json(item);
});
app.patch('/api/todos/:id', adminAuth, (req, res) => {
  const t = db.todos.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.done === 'boolean') t.done = req.body.done;
  if (typeof req.body.text === 'string') t.text = req.body.text.slice(0, 200);
  saveDb(); broadcast('todos', db.todos);
  res.json(t);
});
app.delete('/api/todos/:id', adminAuth, (req, res) => {
  db.todos = db.todos.filter(x => x.id !== req.params.id);
  saveDb(); broadcast('todos', db.todos);
  res.json({ ok: true });
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
    if (b.atTime && /^\d{1,2}:\d{2}$/.test(String(b.atTime))) {
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
const WEATHER_CODE = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 61: 'Rain', 71: 'Snow', 80: 'Showers', 95: 'Storm' };
async function refreshWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,weather_code&timezone=Africa%2FCairo`;
    const r = await fetch(url);
    const j = await r.json();
    db.weather = {
      temp: Math.round(j.current.temperature_2m),
      code: j.current.weather_code,
      label: WEATHER_CODE[j.current.weather_code] || '—',
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
    broadcast('calendar', db.calendar);
  } catch (e) {
    console.error('calendar refresh failed:', e.message);
    db.calendar.error = String(e.message || e).slice(0, 160);
    db.calendar.configured = true;
    broadcast('calendar', db.calendar);
  }
}
app.get('/api/calendar', (req, res) => res.json(db.calendar));
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
