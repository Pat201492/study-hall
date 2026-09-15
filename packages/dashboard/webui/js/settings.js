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
      <div class="card"><h3>Paths</h3>
        <div class="kv"><span>state dir</span><span class="mono">${fmt.esc(cfg.stateDir)}</span></div>
        <div class="kv"><span>v1 usage file</span><span class="mono">${fmt.esc(cfg.v1UsagePath)}</span></div>
        <div class="kv"><span>port</span><span class="mono">${cfg.port}</span></div></div>
    </div>
    <div class="card" style="margin-top:12px"><h3>config.json in force</h3><pre class="log">${fmt.esc(JSON.stringify(cfg, null, 2))}</pre></div>`;
}
