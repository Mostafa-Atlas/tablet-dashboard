const crypto = require('node:crypto');
const time = require('./time');
const DEFAULT_DISPLAY = {
  mode: 'overview', textSize: 'normal', privacy: false,
  showPC: true, showTimers: true, showTodos: true, showCalendar: true,
  quietEnabled: false, quietStart: '23:00', quietEnd: '07:00',
  emptyMsg: 'You have nothing to do now, sir'
};
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clock = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const validDueTime = v => v === null || v === '' || clock(v);
const repeats = ['none', 'daily', 'weekly'];
const priorities = ['high', 'normal', 'low'];
function dueAt(v, zone) {
  if (v === null || v === '') return null;
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    if (/^\d+(?:\.\d+)?$/.test(v)) n = Number(v);
    else { try { n = time.dateTime(v, zone); } catch { return undefined; } }
  }
  return Number.isFinite(n) && n > 0 && n < 8640000000000000 ? n : undefined;
}
function cleanDisplay(input, current = DEFAULT_DISPLAY, strict = false) {
  if (!object(input)) { if (strict) throw Error('Invalid display'); input = {}; }
  const next = { ...DEFAULT_DISPLAY, ...current };
  for (const [key, choices] of [['mode', ['overview', 'focus']], ['textSize', ['normal', 'large']]]) {
    if (input[key] !== undefined) { if (!choices.includes(input[key])) { if (strict) throw Error('Invalid ' + key); } else next[key] = input[key]; }
  }
  for (const key of ['privacy', 'showPC', 'showTimers', 'showTodos', 'showCalendar', 'quietEnabled']) {
    if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') { if (strict) throw Error('Invalid ' + key); } else next[key] = input[key]; }
  }
  for (const key of ['quietStart', 'quietEnd']) {
    if (input[key] !== undefined) { if (!clock(input[key])) { if (strict) throw Error('Invalid ' + key); } else next[key] = input[key]; }
  }
  if (input.emptyMsg !== undefined) {
    if (typeof input.emptyMsg !== 'string' || (strict && input.emptyMsg.length > 120)) { if (strict) throw Error('Invalid empty message'); }
    else next.emptyMsg = input.emptyMsg.trim() || DEFAULT_DISPLAY.emptyMsg;
  }
  if (!next.showPC && !next.showTimers && !next.showTodos && !next.showCalendar) next.showTodos = true;
  return next;
}
function createSchedule(zone) {
  const dayKey = (now = Date.now()) => { const p = time.partsAt(now, zone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
  const addDays = (day, count) => { const d = new Date(day + 'T12:00Z'); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); };
  const weekKey = (now = Date.now()) => { const day = dayKey(now); return addDays(day, -(new Date(day + 'T12:00Z').getUTCDay() + 6) % 7); };
  const timestamp = (day, clockValue) => time.dateTime(`${day}T${clockValue}`, zone);
  const done = t => t.repeat === 'daily' ? t.doneOn === dayKey() : t.repeat === 'weekly' ? t.doneOn === weekKey() : !!t.done;
  function todoDueAt(t, now = Date.now()) {
    if (!t.repeat || t.repeat === 'none') return Number.isFinite(t.dueAt) ? t.dueAt : null;
    if (!clock(t.dueTime)) return null;
    const day = t.repeat === 'daily' ? dayKey(now) : addDays(weekKey(now), Number.isInteger(t.dueWeekday) ? t.dueWeekday : 0);
    // A recurring wall time in a DST gap has no occurrence that day.
    try { return timestamp(day, t.dueTime); } catch { return null; }
  }
  return { dayKey, weekKey, addDays, timestamp, done, todoDueAt };
}
function normalizeFeatures(db, zone) {
  const before = JSON.stringify([db.todos, db.display, db.note, db.routines]);
  db.display = cleanDisplay(db.display);
  db.note = object(db.note) ? { ...db.note, text: typeof db.note.text === 'string' ? db.note.text : '', updatedAt: Number.isFinite(db.note.updatedAt) ? db.note.updatedAt : 0 } : { text: typeof db.note === 'string' ? db.note : '', updatedAt: 0 };
  db.todos = db.todos.map((t, i) => {
    if (!object(t)) return { id: crypto.randomUUID(), text: typeof t === 'string' ? t : '', done: false, order: i, repeat: 'none', dueTime: null, dueAt: null, dueWeekday: 0, priority: 'normal' };
    return { ...t, repeat: repeats.includes(t.repeat) ? t.repeat : 'none', dueTime: validDueTime(t.dueTime) ? t.dueTime || null : null,
      dueAt: dueAt(t.dueAt, zone) ?? null, dueWeekday: Number.isInteger(t.dueWeekday) && t.dueWeekday >= 0 && t.dueWeekday <= 6 ? t.dueWeekday : 0,
      priority: priorities.includes(t.priority) ? t.priority : 'normal', order: Number.isFinite(t.order) ? t.order : i };
  });
  db.routines = (Array.isArray(db.routines) ? db.routines : []).filter(object).map(r => ({ ...r,
    repeat: r.repeat === 'weekly' ? 'weekly' : 'daily', items: (Array.isArray(r.items) ? r.items : []).filter(object).map(i => ({ ...i, doneOn: typeof i.doneOn === 'string' ? i.doneOn : null })) }));
  return before !== JSON.stringify([db.todos, db.display, db.note, db.routines]);
}
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { time.calendarDay(value, 'UTC'); return true; } catch { return false; }
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Invalid ' + label);
  return value.trim();
}
function validateTodo(b, zone) {
  if (!object(b)) throw Error('Invalid task');
  if (b.repeat !== undefined && !repeats.includes(b.repeat)) throw Error('Invalid repeat');
  if (b.priority !== undefined && !priorities.includes(b.priority)) throw Error('Invalid priority');
  if (b.dueTime !== undefined && !validDueTime(b.dueTime)) throw Error('Invalid due time');
  if (b.dueAt !== undefined && dueAt(b.dueAt, zone) === undefined) throw Error('Invalid due date');
  if (b.dueWeekday !== undefined && (!Number.isInteger(b.dueWeekday) || b.dueWeekday < 0 || b.dueWeekday > 6)) throw Error('Invalid weekday');
  if (b.done !== undefined && typeof b.done !== 'boolean') throw Error('Invalid completion');
  if (b.text !== undefined) text(b.text, 200, 'task text');
}
function importData(data, db, zone) {
  if (!object(data) || !['tablet-dashboard-v1', 'tablet-dashboard-v2'].includes(data.format) || !Array.isArray(data.todos) || data.todos.length > 50 || !Array.isArray(data.timers) || data.timers.length > 20) throw Error('Invalid dashboard export');
  const todos = data.todos.map((t, i) => {
    validateTodo(t, zone);
    if (t.order !== undefined && (typeof t.order !== 'number' || !Number.isFinite(t.order))) throw Error('Invalid task order');
    if (t.doneOn != null && (typeof t.doneOn !== 'string' || !validDay(t.doneOn))) throw Error('Invalid completion date');
    return { id: crypto.randomUUID(), text: text(t.text, 200, 'task text'), done: t.done || false, repeat: t.repeat || 'none', doneOn: t.doneOn || null,
      order: t.order ?? i, createdAt: finite(t.createdAt, Date.now()), dueAt: dueAt(t.dueAt ?? null, zone), dueTime: t.dueTime || null, dueWeekday: t.dueWeekday ?? 0, priority: t.priority || 'normal' };
  }).sort((a, b) => a.order - b.order);
  const timers = data.timers.map(t => {
    if (!object(t) || !['long', 'short'].includes(t.type)) throw Error('Invalid timer');
    const targetAt = t.targetAt == null ? null : dueAt(t.targetAt, zone);
    if (targetAt === undefined || (t.done !== undefined && typeof t.done !== 'boolean')) throw Error('Invalid timer target');
    return { id: crypto.randomUUID(), name: text(t.name, 60, 'timer name'), type: t.type, targetAt, createdAt: finite(t.createdAt, Date.now()), done: t.done || false,
      pausedLeftSec: durationValue(t.pausedLeftSec), durationSec: durationValue(t.durationSec), color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : null };
  });
  const result = { todos, timers, display: cleanDisplay(data.display === undefined ? {} : data.display, db.display, true) };
  if (data.format === 'tablet-dashboard-v2') {
    if (data.note !== undefined && (!object(data.note) || typeof data.note.text !== 'string' || data.note.text.length > 1000)) throw Error('Invalid note');
    result.note = { text: data.note?.text || '', updatedAt: Date.now() };
    if (data.routines !== undefined && (!Array.isArray(data.routines) || data.routines.length > 10)) throw Error('Invalid routines');
    result.routines = (data.routines || []).map(r => {
      if (!object(r) || !['daily', 'weekly'].includes(r.repeat) || !Array.isArray(r.items) || r.items.length > 20) throw Error('Invalid routine');
      return { id: crypto.randomUUID(), name: text(r.name, 80, 'routine name'), repeat: r.repeat, items: r.items.map(i => {
        if (!object(i) || (i.doneOn != null && (typeof i.doneOn !== 'string' || !validDay(i.doneOn)))) throw Error('Invalid routine step');
        return { id: crypto.randomUUID(), text: text(i.text, 120, 'step text'), doneOn: i.doneOn || null };
      }) };
    });
  }
  return result;
}
// Zero seconds represents an expired paused timer and resumes at the current
// instant. Positive durations share the same supported-date bound as creation.
function remainingTarget(seconds, now = Date.now()) {
  if (seconds === 0) return now;
  return time.durationTarget(seconds, now);
}
function durationValue(value) {
  const seconds = finite(value, null);
  if (seconds !== null) remainingTarget(seconds);
  return seconds;
}
function finite(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw Error('Invalid finite value');
  return v;
}
module.exports = { DEFAULT_DISPLAY, cleanDisplay, createSchedule, normalizeFeatures, validDueTime, dueAt, validateTodo, importData, remainingTarget };
