require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const ics = require('./lib/ics');
const { createStore } = require('./lib/storage');
const time = require('./lib/time');

function createDashboard({ dataDir, fetchImpl = fetch, background = false } = {}) {

// ---- Config ----
const TIME_ZONE = process.env.APP_TIMEZONE || 'Africa/Cairo';
new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE });
const intervals = [];
function every(fn, delay) { intervals.push(setInterval(fn, delay)); }
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
const DATA_DIR = dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

function emptyCalendar(url) { return {next:null,upcoming:[],updatedAt:0,error:null,configured:!!url}; }
// Internal provenance belongs outside the public calendar object. Never publish
// the private source URL (or its fingerprint) in calendar/snapshot/SSE metadata.
function calendarSource(url) { return crypto.createHash('sha256').update(url).digest('hex'); }
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
      cpu: null, ram: null, gpu: null, gpuTemp: null, cpuTemp: null,
      uptimeSec: null, disks: [], updatedAt: 0
    },
    weather: { temp: null, code: null, label: '—', updatedAt: 0 },
    time: { offsetSec: 0, updatedAt: 0 }, // dashboard clock = real time + offset (set from /admin)
    settings: { icsUrl: '' }, // Google Calendar private ICS URL (set from /admin)
    calendar: emptyCalendar(''),
    calendarSource: calendarSource(''),
    users: [] // { user, salt, hash, createdAt } — created via first-boot setup page
  };
}

const store = createStore(DB_FILE, defaultDb);
let db = store.value;
let migrated = false;
for (const key of ['todos', 'timers', 'pc', 'weather']) {
  if (!(key in db)) { db[key] = defaultDb()[key]; migrated = true; }
}
// migrate old db.json files that predate users[]
if (!Array.isArray(db.users)) { db.users = []; migrated = true; }
if (!db.time || typeof db.time.offsetSec !== 'number') { db.time = { offsetSec: 0, updatedAt: 0 }; migrated = true; }
if (!db.settings || typeof db.settings.icsUrl !== 'string') { db.settings = { icsUrl: '' }; migrated = true; }
if (!db.calendar || typeof db.calendar !== 'object') { db.calendar = { next: null, upcoming: [], updatedAt: 0, error: null, configured: false }; migrated = true; }
if (!Array.isArray(db.calendar.upcoming)) { db.calendar.upcoming = []; migrated = true; }
// Older snapshots have no trustworthy association between their URL and cache.
// Discard only transient calendar data; retain settings, accounts and user data.
if (db.calendarSource !== calendarSource(db.settings.icsUrl)) {
  db.calendar = emptyCalendar(db.settings.icsUrl);
  db.calendarSource = calendarSource(db.settings.icsUrl);
  migrated = true;
}
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
  db.timers = arr; migrated = true;
}
function saveDb() { return store.save(db); }
let mutationQueue = Promise.resolve();
function transaction(fn) {
  const result = mutationQueue.then(async () => {
    const previous = JSON.parse(JSON.stringify(db));
    try { return await fn(); }
    catch (e) {
      // Preserve external updates during writes only if they still belong to
      // the restored source; a failed source change must restore its old cache.
      const {pc,weather} = db;
      const sourceChanged = db.calendarSource !== previous.calendarSource;
      const calendar = sourceChanged ? previous.calendar : db.calendar;
      if (sourceChanged) ++calendarGeneration;
      db = { ...previous, pc, weather, calendar };
      throw e;
    }
  });
  mutationQueue = result.catch(() => {});
  return result;
}
function mutation(handler) {
  return (req,res,next) => transaction(() => handler(req,res,next)).catch(next);
}
const ready = migrated ? saveDb() : Promise.resolve();
app.use((req,res,next) => ready.then(() => next(), next));

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
  if (!(db.users || []).length && ENV_ADMIN_USER && ENV_ADMIN_PASS) return user === ENV_ADMIN_USER && pass === ENV_ADMIN_PASS;
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
app.post('/api/setup', mutation(async (req, res) => {
  if (!needsSetup()) return res.status(403).json({ error: 'Admin already exists' });
  const user = String(req.body.user || '').trim().slice(0, 32);
  const pass = String(req.body.pass || '');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(user)) return res.status(400).json({ error: 'Username: 3-32 chars, letters/numbers/._-' });
  if (pass.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const { salt, hash } = hashPass(pass);
  db.users.push({ user, salt, hash, createdAt: Date.now() });
  await saveDb();
  const token = issueToken();
  res.json({ ok: true, token, expiresInSec: Math.round(SESSION_TTL / 1000) });
}));
app.post('/api/login', (req, res) => {
  if (needsSetup() && !(ENV_ADMIN_USER && ENV_ADMIN_PASS)) return res.status(403).json({ error: 'No admin yet — create one first', needsSetup: true });
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
  return { now: Date.now(), timeZone: TIME_ZONE, pc: db.pc, todos: db.todos, timers: db.timers, weather: weatherState(), time: db.time, calendar: calendarState() };
}
app.get('/api/snapshot', (req, res) => res.json(snapshot()));

// ---- PC stats: agent POSTs here every ~2s ----
app.post('/api/pc', (req, res) => {
  const b = req.body || {};
  const nullable = (value,min,max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
  const disks = (Array.isArray(b.disks) ? b.disks : []).filter(d => d && typeof d === 'object' && typeof d.mount === 'string' && d.mount.trim() && nullable(d.pct,0,100) !== null).slice(0,8).map(d => ({
    mount:d.mount.slice(0,200),pct:d.pct,freeGb:nullable(d.freeGb,0,Number.MAX_VALUE),totalGb:nullable(d.totalGb,0,Number.MAX_VALUE)
  }));
  const capabilities = {};
  if (b.capabilities && typeof b.capabilities === 'object') for (const [key,value] of Object.entries(b.capabilities).slice(0,32)) {
    if (/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key) && typeof value === 'boolean') capabilities[key] = value;
  }
  db.pc = {
    cpu:nullable(b.cpu,0,100),ram:nullable(b.ram,0,100),gpu:nullable(b.gpu,0,100),
    gpuTemp:nullable(b.gpuTemp,-100,250),cpuTemp:nullable(b.cpuTemp,-100,250),
    uptimeSec:nullable(b.uptimeSec,0,Number.MAX_SAFE_INTEGER),disks,capabilities,updatedAt:Date.now()
  };
  // lightweight: don't fsync every 2s, just broadcast
  broadcast('pc', db.pc);
  res.json({ ok: true });
});
app.get('/api/pc', (req, res) => res.json(db.pc));

// ---- Todos ----
app.get('/api/todos', (req, res) => res.json(db.todos));
app.post('/api/todos', adminAuth, mutation(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'text required' });
  const item = { id: crypto.randomUUID(), text, done: false, createdAt: Date.now() };
  if (db.todos.length >= 50) return res.status(409).json({ error: 'Task limit reached (50); delete an item first' });
  db.todos.unshift(item);
  await saveDb(); broadcast('todos', db.todos);
  res.json(item);
}));
app.patch('/api/todos/:id', adminAuth, mutation(async (req, res) => {
  const t = db.todos.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.done === 'boolean') t.done = req.body.done;
  if (typeof req.body.text === 'string') t.text = req.body.text.slice(0, 200);
  await saveDb(); broadcast('todos', db.todos);
  res.json(t);
}));
app.delete('/api/todos/:id', adminAuth, mutation(async (req, res) => {
  db.todos = db.todos.filter(x => x.id !== req.params.id);
  await saveDb(); broadcast('todos', db.todos);
  res.json({ ok: true });
}));

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
app.post('/api/timers', adminAuth, mutation(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  if (b.type !== undefined && !['short','long'].includes(b.type)) return res.status(400).json({ error: 'Invalid timer type' });
  const type = b.type === 'short' ? 'short' : 'long';
  let targetAt = null;
  const extra = {};
  try {
    if (type === 'long') targetAt = longTarget(b);
    else if (b.atTime !== undefined) targetAt = time.nextClock(b.atTime, TIME_ZONE);
    else { extra.durationSec = time.duration(b); targetAt = time.durationTarget(extra.durationSec); }
  } catch (e) { return res.status(400).json({ error: e.message }); }
  const t = { id: makeTimerId(), name, type, targetAt, createdAt: Date.now(), done: false, pausedLeftSec: null, color: cleanColor(b.color), ...extra };
  if (db.timers.length >= 20) return res.status(409).json({ error: 'Timer limit reached (20); delete an item first' });
  db.timers.push(t);
  await saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(t);
}));
app.patch('/api/timers/:id', adminAuth, mutation(async (req, res) => {
  const timerIndex = (db.timers || []).findIndex(x => x.id === req.params.id);
  if (timerIndex < 0) return res.status(404).json({ error: 'not found' });
  // Stage edits so a rejected action cannot leak partial changes into memory
  // or an unrelated later save.
  const t = { ...db.timers[timerIndex] };
  const b = req.body || {};
  if (b.action === 'restart' && (b.hours !== undefined || b.mins !== undefined)) {
    try { time.duration(b); } catch(e) { return res.status(400).json({ error: e.message }); }
  }
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
    try {
      const dur = b.hours !== undefined || b.mins !== undefined ? time.duration(b) : t.durationSec;
      if (!Number.isFinite(dur) || dur <= 0) throw new Error('Original duration unavailable; provide hours/mins');
      t.targetAt = time.durationTarget(dur); t.durationSec = dur; t.done = false;
    } catch(e) { return res.status(400).json({ error: e.message }); }
  }

  db.timers[timerIndex] = t;
  await saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(t);
}));
app.delete('/api/timers/:id', adminAuth, mutation(async (req, res) => {
  db.timers = (db.timers || []).filter(x => x.id !== req.params.id);
  await saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json({ ok: true });
}));
// Legacy compat: old clients posting single long/short map onto named timers.
app.post('/api/timers/long', adminAuth, mutation(async (req, res) => {
  let targetAt;
  try { targetAt = longTarget(req.body); } catch(e) { return res.status(400).json({ error: e.message }); }
  const name = String(req.body.label || 'Long term').slice(0, 60);
  let t = (db.timers || []).find(x => x.type === 'long' && x.name === name && !x.done);
  if (t) { t.targetAt = Number(targetAt); }
  else { if (db.timers.length >= 20) return res.status(409).json({ error: 'Timer limit reached (20)' }); t = { id: makeTimerId(), name, type: 'long', targetAt: Number(targetAt), createdAt: Date.now(), done: false, pausedLeftSec: null }; db.timers.push(t); }
  await saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(t);
}));
app.post('/api/timers/short', adminAuth, mutation(async (req, res) => {
  const { action } = req.body;
  const name = String(req.body.label || 'Focus').slice(0, 60);
  const shorts = (db.timers || []).filter(x => x.type === 'short');
  let s = shorts.find(x => x.name === name && !x.done) || shorts.filter(x => !x.done).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (action === 'start') {
    let dur, targetAt;
    try { dur = time.duration(req.body, 25); targetAt = time.durationTarget(dur); } catch(e) { return res.status(400).json({ error: e.message }); }
    if (s && s.name === name) { s.targetAt = targetAt; s.pausedLeftSec = null; s.done = false; s.durationSec = Math.round(dur); }
    else { if (db.timers.length >= 20) return res.status(409).json({ error: 'Timer limit reached (20)' }); s = { id: makeTimerId(), name, type: 'short', targetAt, createdAt: Date.now(), done: false, pausedLeftSec: null, durationSec: Math.round(dur) }; db.timers.push(s); }
  } else if (!s) return res.status(404).json({ error: 'no short timer' });
  else if (action === 'pause' && s.targetAt) {
    s.pausedLeftSec = Math.max(0, Math.round((s.targetAt - Date.now()) / 1000));
    s.targetAt = null;
  } else if (action === 'resume' && s.pausedLeftSec != null) {
    s.targetAt = Date.now() + s.pausedLeftSec * 1000; s.pausedLeftSec = null;
  } else if (action === 'reset') {
    s.targetAt = null; s.pausedLeftSec = null;
  } else return res.status(400).json({ error: 'bad action' });
  await saveDb(); broadcast('timers', sortTimers(db.timers));
  res.json(s);
}));

// ---- Weather (Open-Meteo, cached 30 min). 6th October city coords ----
const WEATHER_META = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
  51: ['Drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Drizzle', '🌦️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '🌨️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌦️'], 82: ['Heavy showers', '🌧️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
  95: ['Storm', '⛈️'], 96: ['Storm + hail', '⛈️'], 99: ['Storm + hail', '⛈️']
};
let weatherRequest;
function weatherState() { return { ...db.weather, stale: !db.weather.updatedAt || Date.now()-db.weather.updatedAt > 30*60000 }; }
function refreshWeather() {
  if (weatherRequest) return weatherRequest;
  weatherRequest = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,weather_code&timezone=${encodeURIComponent(TIME_ZONE)}`;
      const r = await fetchImpl(url, { signal: controller.signal });
      if (!r.ok) throw new Error('HTTP '+r.status);
      const j = await r.json();
      if (!j.current || typeof j.current.temperature_2m !== 'number' || !Number.isFinite(j.current.temperature_2m) || typeof j.current.weather_code !== 'number' || !Number.isFinite(j.current.weather_code)) throw new Error('Invalid weather sample');
      const [label, icon] = WEATHER_META[j.current.weather_code] || ['—', '🌡️'];
      db.weather = {temp:Math.round(j.current.temperature_2m),code:j.current.weather_code,label,icon,updatedAt:Date.now(),attemptedAt:Date.now(),error:null};
    } catch(e) {
      db.weather = { ...db.weather, attemptedAt:Date.now(), error:'Weather refresh failed; retrying automatically' };
    } finally { clearTimeout(timeout); }
    broadcast('weather',weatherState());
  })().finally(() => { weatherRequest = null; });
  return weatherRequest;
}
app.get('/api/weather', async (req, res) => {
  if (Date.now() - (db.weather.updatedAt || 0) > 30 * 60 * 1000) await refreshWeather();
  res.json(weatherState());
});

// ---- Dashboard clock override (set from /admin) ----
// Kiosk clock shows real time + offsetSec. Timers/countdowns always use real time.
app.get('/api/time', (req, res) => {
  res.json({ timeZone: TIME_ZONE, offsetSec: db.time.offsetSec || 0, dashboardNow: Date.now() + (db.time.offsetSec || 0) * 1000 });
});
app.post('/api/time', adminAuth, mutation(async (req, res) => {
  const b = req.body || {};
  if (b.action === 'reset') {
    db.time = { offsetSec: 0, updatedAt: Date.now() };
  } else if (typeof b.offsetSec !== 'undefined') {
    let numericOffset;
    try { numericOffset = time.numeric(b.offsetSec); } catch(e) { return res.status(400).json({ error: e.message }); }
    const off = Math.max(-86400 * 365, Math.min(86400 * 365, numericOffset));
    db.time = { offsetSec: Math.round(off), updatedAt: Date.now() };
  } else if (b.datetime) {
    // datetime-local string from admin, e.g. "2026-01-12T14:30"
    let t;
    try { t = time.dateTime(b.datetime, TIME_ZONE); } catch(e) { return res.status(400).json({ error: e.message }); }
    db.time = { offsetSec: Math.round((t - Date.now()) / 1000), updatedAt: Date.now() };
  } else return res.status(400).json({ error: 'datetime, offsetSec or action=reset required' });
  await saveDb(); broadcast('time', db.time);
  res.json({ timeZone: TIME_ZONE, offsetSec: db.time.offsetSec, dashboardNow: Date.now() + db.time.offsetSec * 1000 });
}));
// ---- Google Calendar via private ICS URL (poll every 10 min) ----
let calendarGeneration = 0;
function calendarState() { return { ...db.calendar, stale: !!db.calendar.configured && (!db.calendar.updatedAt || Date.now()-db.calendar.updatedAt > 20*60000) }; }
async function refreshCalendar() {
  const generation = ++calendarGeneration;
  const url = (db.settings.icsUrl || '').trim();
  if (!url) {
    db.calendar = emptyCalendar('');
    broadcast('calendar',calendarState());
    return {ok:true};
  }
  try {
    const text = await ics.fetchIcs(url,fetchImpl);
    const events = ics.parseIcs(text,TIME_ZONE);
    if (generation !== calendarGeneration || url !== db.settings.icsUrl) return {ok:false,superseded:true};
    const now = Date.now();
    db.calendar = {next:ics.findNext(events,now),upcoming:ics.upcoming(events,now,14,100),updatedAt:now,attemptedAt:now,error:null,configured:true};
    broadcast('calendar',calendarState());
    return {ok:true};
  } catch(e) {
    if (generation !== calendarGeneration || url !== db.settings.icsUrl) return {ok:false,superseded:true};
    // A private URL may appear in fetch error messages. Never publish it.
    db.calendar = {...db.calendar,attemptedAt:Date.now(),error:'Calendar refresh failed; check the private URL and try again',configured:true};
    broadcast('calendar',calendarState());
    return {ok:false};
  }
}
app.get('/api/calendar', (req,res) => res.json(calendarState()));
app.get('/api/settings', adminAuth, (req,res) => res.json({icsUrl:db.settings.icsUrl || ''}));
app.post('/api/settings', adminAuth, async (req,res,next) => {
  const icsUrl = String(req.body.icsUrl || '').trim();
  try {
    if (icsUrl.length > 2000) return res.status(400).json({error:'URL too long'});
    if (icsUrl) { const url = new URL(icsUrl); if (!['http:','https:'].includes(url.protocol)) throw new Error('protocol'); }
  } catch { return res.status(400).json({error:'Must be an http(s) URL'}); }
  try {
    await transaction(async () => {
      const changed = db.settings.icsUrl !== icsUrl;
      db.settings.icsUrl = icsUrl;
      ++calendarGeneration;
      if (changed) {
        db.calendar = emptyCalendar(icsUrl);
        db.calendarSource = calendarSource(icsUrl);
      }
      await saveDb();
    });
    // Fetch outside the mutation queue: disconnect/new URLs must supersede it.
    const result = await refreshCalendar();
    if (result.superseded) return res.status(409).json({ok:false,error:'Calendar settings changed during refresh',calendar:calendarState()});
    res.status(result.ok ? 200 : 502).json({ok:result.ok,...(!result.ok ? {error:db.calendar.error} : {}),calendar:calendarState()});
  } catch(e) { next(e); }
});

function longTarget(body) {
  let target;
  if (body.targetAt !== undefined) target = time.numeric(body.targetAt);
  else if (body.date !== undefined) target = time.dateTime(body.date, TIME_ZONE);
  else if (body.days !== undefined && time.numeric(body.days) > 0) target = Date.now() + time.numeric(body.days) * 86400000;
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(new Date(target).getTime())) throw new Error('Valid days, date or targetAt required');
  return target;
}
app.use((error,req,res,next) => {
  console.error('request failed:', error.message);
  if (!res.headersSent) res.status(error.status || 500).json({ error: error.status === 400 ? 'Invalid request body' : 'Unable to save changes; please retry' });
});
function startBackground() {
  if (intervals.length) return;
  ready.then(() => { refreshWeather(); refreshCalendar(); }).catch(e => console.error('startup persistence failed:', e.message));
  every(() => transaction(saveDb).catch(e => console.error('database save failed:', e.message)), 15000);
  every(refreshWeather, 30 * 60000);
  every(refreshCalendar, 10 * 60000);
  every(() => { for (const res of sseClients) res.write(': heartbeat\n\n'); }, 25000);
}
function stopBackground() { for (const timer of intervals.splice(0)) clearInterval(timer); for (const res of sseClients) res.end(); sseClients.clear(); }
if (background) startBackground();
return { app, ready, startBackground, stopBackground };
}
module.exports = { createDashboard };
if (require.main === module) {
  const dashboard = createDashboard({ background: true });
  dashboard.ready.then(() => dashboard.app.listen(process.env.PORT || 1200, '0.0.0.0', () => console.log('tablet-dashboard listening on port ' + (process.env.PORT || 1200)))).catch(e => { console.error(e.message); process.exitCode = 1; dashboard.stopBackground(); });
}
