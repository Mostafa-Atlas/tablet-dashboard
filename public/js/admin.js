const msg = t => document.getElementById('msg').textContent = t;
async function refresh() {
  const todos = await (await fetch('/api/todos')).json();
  const ul = document.getElementById('list'); ul.innerHTML = '';
  todos.forEach(t => {
    const li = document.createElement('li');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
    cb.onchange = async () => {
      await fetch('/api/todos/' + t.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: cb.checked }) });
      refresh();
    };
    const sp = document.createElement('span'); sp.textContent = t.text; sp.style.flex = '1';
    const del = document.createElement('button'); del.textContent = '✕';
    del.onclick = async () => { await fetch('/api/todos/' + t.id, { method: 'DELETE' }); refresh(); };
    li.append(cb, sp, del); ul.appendChild(li);
  });
}
document.getElementById('todo-add').onclick = async () => {
  const el = document.getElementById('todo-text');
  if (!el.value.trim()) return;
  const r = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: el.value }) });
  if (!r.ok) { msg('Auth failed? Reload and login as admin.'); return; }
  el.value = ''; msg('Added ✓'); refresh();
};
document.getElementById('long-set').onclick = async () => {
  const days = Number(document.getElementById('long-days').value || 0);
  await fetch('/api/timers/long', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) });
  msg('Long timer set ✓');
};
document.getElementById('sh-start').onclick = async () => {
  await fetch('/api/timers/short', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start', hours: Number(document.getElementById('sh-h').value || 0), mins: Number(document.getElementById('sh-m').value || 0) }) });
  msg('Short timer started ✓');
};
for (const [id, action] of [['sh-pause', 'pause'], ['sh-resume', 'resume'], ['sh-reset', 'reset']]) {
  document.getElementById(id).onclick = async () => {
    await fetch('/api/timers/short', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    msg('Short timer: ' + action + ' ✓');
  };
}
refresh();
