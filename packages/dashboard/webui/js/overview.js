// Overview: per-provider quota (5h / 7d windows with reset and AGE of the
// observation — a bare percentage with no age is the failure mode that makes
// arena results unfalsifiable), engine state, and quick actions.

const WINDOW_LABEL = { fiveHour: '5-hour window', sevenDay: '7-day window' };

function bar(w) {
  if (!w) return '<div class="bar"><i style="width:0"></i></div><div class="kv"><span>?</span><span class="muted">no observation</span></div>';
  const pct = Math.min(100, Math.round(w.utilization * 100));
  const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  const left = Math.max(0, 100 - Math.round(w.utilization * 100));
  return `<div class="bar"><i class="${cls}" style="width:${pct}%"></i><b style="left:90%"></b></div>
  <div class="kv"><span>${pct}% used · <b>${left}% left</b></span><span class="muted">resets ${new Date(w.resetsAt).toLocaleString()}</span></div>`;
}

function providerCard(p, fmt) {
  const q = p.quota;
  const st = q?.state ?? 'unknown';
  const o = q?.observation;
  const windows = [];
  if (o?.fiveHour) windows.push(['fiveHour', o.fiveHour]);
  if (o?.sevenDay) windows.push(['sevenDay', o.sevenDay]);
  for (const [k, w] of Object.entries(o?.extra ?? {})) windows.push([k, w]);
  const rows = windows.length
    ? windows.map(([k, w]) => `<div><div class="muted">${WINDOW_LABEL[k] ?? k}</div>${bar(w)}</div>`).join('')
    : `<div class="muted">No window observed yet — probe or run one task.</div>`;
  const reason = o?.detail ? `<div class="muted" style="margin-top:6px">${fmt.esc(o.detail)}</div>` : '';
  return `<div class="card">
    <div class="kv"><h2><span class="pill ${p.id}">${fmt.esc(p.label)}</span></h2><span class="state ${st}">${st}</span></div>
    <div class="kv muted"><span>meter: ${p.meter} · stance: ${p.stance}${p.concurrencyCap ? ` · cap ${p.concurrencyCap}` : ''}</span><span>observed ${q?.ageMs != null ? fmt.ago(q.ageMs) : 'never'}${o?.source ? ` via ${o.source}` : ''}</span></div>
    ${q?.exhaustedUntil ? `<div class="bad">held until ${new Date(q.exhaustedUntil).toLocaleString()}</div>` : ''}
    <div style="margin-top:8px">${rows}</div>${reason}
    <div style="margin-top:10px"><button class="btn" data-probe="${p.id}">Probe now</button> <span class="muted" id="probe-${p.id}"></span></div>
  </div>`;
}

export async function renderOverview(el, { api, fmt, refreshStatus }) {
  const status = await api.get('/api/status');
  const eff = status.provider?.effective ?? {};
  el.innerHTML = `
    <div class="grid" id="providers">${status.providers.map((p) => providerCard(p, fmt)).join('')}</div>
    <div class="grid" style="margin-top:12px">
      <div class="card"><h3>Engine</h3>
        <div id="engine-line">${engineLine(status.engine, fmt)}</div>
        <div class="muted" style="margin-top:6px">repos: ${status.repos.length ? status.repos.map(fmt.esc).join(', ') : 'none configured'}</div>
        <div style="margin-top:10px"><button class="btn" id="eng-start">Start</button> <button class="btn" id="eng-drain" title="Finish in-flight work, start nothing new">Drain</button> <button class="btn" id="eng-stop" title="Tree-kill the engine and its students">Stop</button> <span class="muted" id="eng-msg"></span></div>
        <div class="kv" style="margin-top:10px"><span>bounded run</span><span><input id="br-n" type="number" min="0" style="width:60px" value="${status.engine.boundedRun?.limit ?? 5}"> <select id="br-unit"><option value="pr">PRs</option><option value="merge">merges</option></select> <button class="btn" id="br-save">Save</button></span></div>
        <div class="muted" style="font-size:12px">0 = unbounded (every expensive incident was one). Takes effect on the next start.</div>
        <pre class="log" id="eng-log" style="margin-top:8px;max-height:160px;overflow:auto"></pre></div>
      <div class="card"><h3>Provider in force per surface</h3>
        ${Object.entries(eff).map(([s, c]) => `<div class="kv"><span>${s}</span><span class="pill ${c === 'auto' ? '' : c}">${c === 'auto' ? 'Both (failover ' + (status.provider.failoverOrder || []).join(' → ') + ')' : c === 'anthropic' ? 'Claude' : 'ChatGPT'}</span></div>`).join('')}
        <div class="muted" style="margin-top:6px">Claude hands over at ${Math.round((status.provider.handoverAt ?? 0.9) * 100)}% of its limiting window; ChatGPT on <span class="mono">ordinaryUsageAllowed=false</span>.</div></div>
      <div class="card"><h3>Ledger</h3><div class="mono muted">${fmt.esc(status.ledger.dir)}</div>
        <div style="margin-top:8px"><button class="btn" id="import-v1">Import v1 usage.jsonl</button> <span class="muted" id="import-msg"></span></div></div>
    </div>`;

  el.querySelectorAll('button[data-probe]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.probe; const msg = el.querySelector(`#probe-${id}`);
    b.disabled = true; msg.textContent = id === 'anthropic' ? 'running one haiku turn…' : 'reading app-server…';
    try { const r = await api.post(`/api/quota/probe/${id}`); msg.textContent = r.ok ? `${r.quota.state}${r.costUsd != null ? ` · est. ${fmt.usd(r.costUsd)}` : ''}` : (r.msg || 'failed'); }
    catch (e) { msg.textContent = String(e); }
    b.disabled = false; await refreshStatus();
  }));
  el.querySelector('#import-v1').addEventListener('click', async () => {
    const m = el.querySelector('#import-msg'); m.textContent = 'importing…';
    const r = await api.post('/api/ledger/import-v1');
    m.textContent = r.ok ? `imported ${r.imported ?? '?'} (skipped ${r.skipped ?? 0})` : r.msg;
  });

  const stopEngineTail = wireEngineControls(el, { api, fmt, refreshStatus });

  // Live quota via SSE; re-render only the provider cards.
  const es = new EventSource('/api/quota/stream');
  es.addEventListener('quota', (ev) => {
    const providers = JSON.parse(ev.data);
    const box = el.querySelector('#providers');
    if (box) box.innerHTML = providers.map((p) => providerCard(p, fmt)).join('');
    el.querySelectorAll('button[data-probe]').forEach((b) => b.addEventListener('click', () => location.reload()));
  });
  return () => { es.close(); stopEngineTail(); };
}

function engineLine(e, fmt) {
  if (!e) return '<span class="muted">unknown</span>';
  if (!e.running) return `<span class="muted">stopped</span>${e.stopped && e.updatedAt ? ` <span class="muted">— last snapshot ${fmt.ago(Date.now() - Date.parse(e.updatedAt))}</span>` : ''}`;
  const parts = [`<span class="ok">running</span>`];
  if (e.live) parts.push(`tick ${e.tick}`, `${e.students} student(s)`, fmt.ago(Date.now() - Date.parse(e.updatedAt)));
  else parts.push('<span class="warn">no fresh snapshot yet</span>');
  if (e.boundedRun) parts.push(`bounded ${e.boundedRun.done}/${e.boundedRun.limit} ${e.boundedRun.unit}s`);
  if (e.drainRequested) parts.push('<span class="warn">draining</span>');
  return parts.join(' · ');
}

export function wireEngineControls(el, { api, fmt, refreshStatus }) {
  const msg = el.querySelector('#eng-msg');
  const log = el.querySelector('#eng-log');
  const act = (path) => async () => {
    msg.textContent = '…';
    const r = await api.post(path);
    msg.textContent = r.msg || (r.ok ? 'ok' : 'failed');
    await refreshStatus();
    await tail();
  };
  el.querySelector('#eng-start')?.addEventListener('click', act('/api/engine/start'));
  el.querySelector('#eng-drain')?.addEventListener('click', act('/api/engine/drain'));
  el.querySelector('#eng-stop')?.addEventListener('click', act('/api/engine/stop'));
  el.querySelector('#br-save')?.addEventListener('click', async () => {
    const n = Number(el.querySelector('#br-n').value); const unit = el.querySelector('#br-unit').value;
    const r = await api.post('/api/settings/bounded-run', { n, unit, unbounded: n === 0 });
    msg.textContent = r.ok ? `bounded run: ${r.boundedRun.n === 0 ? 'UNBOUNDED' : `${r.boundedRun.n} ${r.boundedRun.unit}(s)`} (next start)` : (r.msg || 'failed');
  });
  async function tail() {
    if (!log) return;
    const r = await api.get('/api/engine/log?n=30');
    log.textContent = (r.lines || []).join('\n') || '(no engine output yet)';
    log.scrollTop = log.scrollHeight;
    const st = await api.get('/api/status');
    const line = el.querySelector('#engine-line'); if (line) line.innerHTML = engineLine(st.engine, fmt);
  }
  void tail();
  const t = setInterval(tail, 5_000);
  return () => clearInterval(t);
}
