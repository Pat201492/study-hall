// Settings: the raw config in force (read-only here; the provider toggle and
// probes write through their own endpoints). Editing other knobs lands with the
// engine port, whose config schema owns them.

export async function renderSettings(el, { api, fmt }) {
  const cfg = await api.get('/api/settings');
  const status = await api.get('/api/status');
  el.innerHTML = `
    <div class="grid">
      <div class="card"><h3>Provider policy</h3>
        <div class="kv"><span>global default</span><span class="mono">${cfg.provider.default}</span></div>
        <div class="kv"><span>failover order</span><span class="mono">${cfg.provider.failoverOrder.join(' → ')}</span></div>
        <div class="kv"><span>Claude handover threshold</span><span class="mono">${Math.round(cfg.provider.handoverAt * 100)}%</span></div>
        ${Object.entries(cfg.provider.concurrency).map(([p, n]) => `<div class="kv"><span>${p} concurrency</span><span class="mono">${n}</span></div>`).join('')}
        <div class="muted" style="margin-top:6px">Per-surface overrides are set with the toggle in the header of each screen.</div></div>
      <div class="card"><h3>Harness capabilities</h3>
        ${status.harnesses.map((h) => `<div style="margin-bottom:8px"><b>${h.id}</b> <span class="pill ${h.provider}">${h.provider}</span><div class="mono muted" style="font-size:11px">${Object.entries(h.capabilities).filter(([, v]) => v === true || (Array.isArray(v) && v.length) || typeof v === 'string').map(([k, v]) => (v === true ? k : `${k}=${Array.isArray(v) ? v.join('|') : v}`)).join(' · ')}</div></div>`).join('')}</div>
      <div class="card"><h3>Boards</h3>
        <div class="muted" style="font-size:12px">The repositories the engine works. Every repo picker in the app offers this list.</div>
        <div id="s-repos" style="margin-top:8px"></div>
        <div style="display:flex; gap:6px; margin-top:8px">
          <input id="s-repo-add" placeholder="owner/name" style="flex:1">
          <button class="btn primary" id="s-repo-btn">Add</button>
        </div>
        <div class="muted" id="s-repo-msg" style="font-size:12px;margin-top:6px"></div></div>
      <div class="card"><h3>Paths</h3>
        <div class="kv"><span>state dir</span><span class="mono">${fmt.esc(cfg.stateDir)}</span></div>
        <div class="kv"><span>v1 usage file</span><span class="mono">${fmt.esc(cfg.v1UsagePath)}</span></div>
        <div class="kv"><span>port</span><span class="mono">${cfg.port}</span></div></div>
    </div>
    <div class="card" style="margin-top:12px"><h3>config.json in force</h3><pre class="log">${fmt.esc(JSON.stringify(cfg, null, 2))}</pre></div>`;

  const msg = el.querySelector('#s-repo-msg');
  const input = el.querySelector('#s-repo-add');

  function renderRepos(repos) {
    const box = el.querySelector('#s-repos');
    if (!repos.length) {
      box.innerHTML = '<div class="warn" style="font-size:12px">No boards yet. Add one and the engine, planner and editor all start offering it.</div>';
      return;
    }
    box.innerHTML = repos.map((r) => `<div class="kv"><span class="mono">${fmt.esc(r)}</span><button class="btn" data-rm="${fmt.esc(r)}">Remove</button></div>`).join('');
    for (const b of box.querySelectorAll('[data-rm]')) {
      b.addEventListener('click', async () => {
        // Removing a board stops the engine working it; it deletes nothing on GitHub.
        const r = await api.post('/api/settings/repos', { remove: b.dataset.rm });
        msg.textContent = r.ok ? (r.note || '') : (r.msg || 'failed');
        if (r.ok) renderRepos(r.repos);
      });
    }
  }
  renderRepos(cfg.repos ?? []);

  const add = async () => {
    const name = input.value.trim();
    if (!name) { msg.textContent = 'type owner/name first'; return; }
    const btn = el.querySelector('#s-repo-btn');
    btn.disabled = true; msg.textContent = `checking ${name} with gh…`;
    try {
      const r = await api.post('/api/settings/repos', { add: name });
      msg.textContent = r.ok ? (r.note || '') : (r.msg || 'failed');
      if (r.ok) { input.value = ''; renderRepos(r.repos); }
    } finally { btn.disabled = false; }
  };
  el.querySelector('#s-repo-btn').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
}
