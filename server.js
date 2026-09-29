require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// ---- Config ----
const PORT = process.env.PORT || 1200;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123';
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
    timers: {
      // long: target timestamp (ms). short: duration + state managed client-side but persisted here
      long: { label: 'Long term', targetAt: Date.now() + 12 * 24 * 3600 * 1000, createdAt: Date.now() },
      short: { label: 'Focus', durationSec: 25 * 60, endsAt: null, pausedLeftSec: null }
    },
    pc: {
      cpu: 0, ram: 0, gpu: 0, gpuTemp: null, cpuTemp: null,
      uptimeSec: 0, disks: [], updatedAt: 0
    },
    weather: { temp: null, code: null, label: '—', updatedAt: 0 }
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

// ---- Basic auth for /admin + mutating APIs ----
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const [scheme, encoded] = h.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
    if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="tablet-admin"');
  return res.status(401).send('Auth required');
}

// ---- Static ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
  return { now: Date.now(), pc: db.pc, todos: db.todos, timers: db.timers, weather: db.weather };
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

// ---- Timers ----
app.get('/api/timers', (req, res) => res.json(db.timers));
app.post('/api/timers/long', adminAuth, (req, res) => {
  // body: { days: number } or { targetAt: ms }
  let targetAt = req.body.targetAt;
  if (!targetAt && req.body.days) targetAt = Date.now() + Number(req.body.days) * 24 * 3600 * 1000;
  if (!targetAt) return res.status(400).json({ error: 'days or targetAt required' });
  db.timers.long = { label: String(req.body.label || 'Long term').slice(0, 60), targetAt: Number(targetAt), createdAt: Date.now() };
  saveDb(); broadcast('timers', db.timers);
  res.json(db.timers.long);
});
app.post('/api/timers/short', adminAuth, (req, res) => {
  // body: { action: 'start'|'pause'|'resume'|'reset', hours, mins }
  const { action } = req.body;
  const s = db.timers.short;
  if (action === 'start') {
    const h = Number(req.body.hours || 0), m = Number(req.body.mins || 25);
    const dur = Math.max(60, h * 3600 + m * 60);
    s.durationSec = dur; s.endsAt = Date.now() + dur * 1000; s.pausedLeftSec = null;
    s.label = String(req.body.label || 'Focus').slice(0, 60);
  } else if (action === 'pause' && s.endsAt) {
    s.pausedLeftSec = Math.max(0, Math.round((s.endsAt - Date.now()) / 1000));
    s.endsAt = null;
  } else if (action === 'resume' && s.pausedLeftSec != null) {
    s.endsAt = Date.now() + s.pausedLeftSec * 1000; s.pausedLeftSec = null;
  } else if (action === 'reset') {
    s.endsAt = null; s.pausedLeftSec = null;
  } else return res.status(400).json({ error: 'bad action' });
  saveDb(); broadcast('timers', db.timers);
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

// ---- Calendar placeholder (Google Calendar OAuth comes in v0.2) ----
app.get('/api/calendar', (req, res) => {
  res.json({ next: null, note: 'Connect Google Calendar in v0.2 (OAuth/ICS).' });
});

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

app.listen(PORT, '0.0.0.0', () => {
  console.log(`tablet-dashboard v0.1 on http://0.0.0.0:${PORT}  (LAN + Tailscale OK)`);
  console.log(`kiosk: /   admin: /admin  user=${ADMIN_USER}`);
});
