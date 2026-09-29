// Admin with custom login page (token in localStorage, no browser Basic popup).
const msg = t => document.getElementById('msg').textContent = t || '';
const loginErr = t => document.getElementById('login-err').textContent = t || '';
const setupErr = t => document.getElementById('setup-err').textContent = t || '';
const getToken = () => localStorage.getItem('admin_token');

async function authFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) { showLogin('Session expired — sign in again'); }
  return r;
}

function showSetup() {
  document.getElementById('setup-card').style.display = 'block';
  document.getElementById('login-card').style.display = 'none';
  document.getElementById('panel').style.display = 'none';
}
function showLogin(err) {
  document.getElementById('setup-card').style.display = 'none';
  document.getElementById('login-card').style.display = 'block';
  document.getElementById('panel').style.display = 'none';
  if (err) loginErr(err);
}
function showPanel() {
  document.getElementById('setup-card').style.display = 'none';
  document.getElementById('login-card').style.display = 'none';
  document.getElementById('panel').style.display = 'block';
  refresh();
}

async function doSetup() {
  setupErr('');
  const user = document.getElementById('setup-user').value.trim();
  const pass = document.getElementById('setup-pass').value;
  const pass2 = document.getElementById('setup-pass2').value;
  if (pass !== pass2) { setupErr('Passwords do not match'); return; }
  const btn = document.getElementById('setup-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await fetch('/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass })
    });
    const j = await r.json();
    if (!r.ok) { setupErr(j.error || 'Setup failed'); return; }
    localStorage.setItem('admin_token', j.token);
    showPanel();
  } catch { setupErr('Cannot reach server'); }
  finally { btn.disabled = false; btn.textContent = 'Create account'; }
}
document.getElementById('setup-btn').onclick = doSetup;

async function doLogin() {
  loginErr('');
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  if (!user || !pass) { loginErr('Enter username and password'); return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass })
    });
    const j = await r.json();
    if (j.needsSetup) { showSetup(); return; }
    if (!r.ok) { loginErr(j.error || 'Login failed'); return; }
    localStorage.setItem('admin_token', j.token);
    document.getElementById('login-pass').value = '';
    showPanel();
  } catch { loginErr('Cannot reach server'); }
  finally { btn.disabled = false; btn.textContent = 'Sign in'; }
}

async function refresh() {
  const r = await authFetch('/api/todos');
  if (!r.ok) return;
  const todos = await r.json();
  const ul = document.getElementById('list'); ul.innerHTML = '';
  todos.forEach(t => {
    const li = document.createElement('li');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
    cb.onchange = async () => {
      await authFetch('/api/todos/' + t.id, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) });
      refresh();
    };
    const sp = document.createElement('span'); sp.textContent = t.text; sp.style.flex = '1';
    const del = document.createElement('button'); del.textContent = '✕'; del.className = 'ghost';
    del.onclick = async () => { await authFetch('/api/todos/' + t.id, { method: 'DELETE' }); refresh(); };
    li.append(cb, sp, del); ul.appendChild(li);
  });
}

document.getElementById('login-btn').onclick = doLogin;
document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('logout-btn').onclick = async () => {
  try { await authFetch('/api/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('admin_token');
  showLogin();
};

document.getElementById('todo-add').onclick = async () => {
  const el = document.getElementById('todo-text');
  if (!el.value.trim()) return;
  const r = await authFetch('/api/todos', { method: 'POST', body: JSON.stringify({ text: el.value }) });
  if (!r.ok) { msg('Failed — are you logged in?'); return; }
  el.value = ''; msg('Added ✓'); refresh();
};
document.getElementById('long-set').onclick = async () => {
  const days = Number(document.getElementById('long-days').value || 0);
  await authFetch('/api/timers/long', { method: 'POST', body: JSON.stringify({ days }) });
  msg('Long timer set ✓');
};
document.getElementById('sh-start').onclick = async () => {
  await authFetch('/api/timers/short', { method: 'POST',
    body: JSON.stringify({ action: 'start', hours: Number(document.getElementById('sh-h').value || 0), mins: Number(document.getElementById('sh-m').value || 0) }) });
  msg('Short timer started ✓');
};
for (const [id, action] of [['sh-pause', 'pause'], ['sh-resume', 'resume'], ['sh-reset', 'reset']]) {
  document.getElementById(id).onclick = async () => {
    await authFetch('/api/timers/short', { method: 'POST', body: JSON.stringify({ action }) });
    msg('Short timer: ' + action + ' ✓');
  };
}

// Boot: setup -> login -> panel.
(async () => {
  let me = { loggedIn: false, needsSetup: false };
  try {
    const token = getToken();
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    me = await (await fetch('/api/me', { headers })).json();
  } catch { return showLogin('Cannot reach server'); }
  if (me.needsSetup) return showSetup();
  if (me.loggedIn) return showPanel();
  // No valid session. If login says setup is needed (fresh DB), show setup.
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: '', pass: '' })
    });
    const j = await r.json();
    if (j.needsSetup) return showSetup();
  } catch {}
  showLogin();
})();
