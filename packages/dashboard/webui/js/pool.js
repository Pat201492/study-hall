// Pool: the warm pool made visible — who is running, how warm they are, and
// whether the assignment ladder is actually reusing warm workers. Live students
// come from the engine's status.json; ladder tallies come from the LEDGER so
// they survive restarts (process memory does not).

function studentRow(s, fmt) {
  const warm = s.warm ? `<span class="ok" title="${fmt.esc(s.baseSessionId ?? '')}">warm</span>` : '<span class="muted">cold</span>';
  const item = s.repo && s.item != null ? `${fmt.esc(s.repo)}#${s.item}` : '<span class="muted">—</span>';
  return `<tr>
    <td class="mono">${fmt.esc(s.id)}</td>
    <td><span class="pill ${s.provider}">${s.provider}</span> <span class="muted">${fmt.esc(s.harness)}</span></td>
    <td class="mono">${fmt.esc(s.model)}</td>
    <td>${s.tier ?? '—'} / ${s.role ?? '—'}</td>
    <td>${s.state === 'busy' ? '<span class="ok">busy</span>' : '<span class="muted">idle-warm</span>'} · ${warm}</td>
    <td>${item}${s.runId ? ` <a href="#/runs?id=${encodeURIComponent(s.runId)}" class="mono muted">${s.runId.slice(0, 8)}</a>` : ''}</td>
    <td class="mono">${fmt.tok(s.tokens)}</td>
    <td>${Math.round(s.cacheHitPct ?? 0)}%</td>
    <td class="muted">${s.startedAt ? fmt.ago(Date.now() - Date.parse(s.startedAt)) : '—'}</td>
  </tr>`;
}

function providerCard(id, p, fmt) {
  const q = p.quota;
  return `<div class="card"><div class="kv"><h2><span class="pill ${id}">${id}</span></h2><span class="state ${q?.state ?? 'unknown'}">${q?.state ?? 'unknown'}</span></div>
    <div class="kv"><span>in flight</span><span class="mono">${p.inFlight} / ${p.cap}</span></div>
    ${p.halted ? `<div class="bad">halted: ${fmt.esc(p.halted)}</div>` : ''}
    ${q?.exhaustedUntil ? `<div class="warn">held until ${new Date(q.exhaustedUntil).toLocaleString()}</div>` : ''}
  </div>`;
}

function ladderCard(title, t, note) {
  if (!t) return `<div class="card"><h3>${title}</h3><div class="muted">${note ?? 'no data'}</div></div>`;
  const cell = (k, v) => `<div class="kv"><span>${k}</span><span class="mono">${v}</span></div>`;
  return `<div class="card"><h3>${title}</h3>
    ${cell('exact (same role, warm hit)', t.exact)}${cell('rerole (warm session, prefix re-cached)', t.rerole)}${cell('cross-repo', t.crossRepo)}${cell('spawn (cold)', t.spawn)}${cell('wait (at cap)', t.wait)}
    <div class="kv" style="margin-top:6px"><b>warm reuse rate</b><b class="mono">${Math.round((t.warmReuseRate ?? 0) * 100)}%</b></div>
    ${note ? `<div class="muted" style="margin-top:6px">${note}</div>` : ''}</div>`;
}

export async function renderPool(el, { api, fmt }) {
  el.innerHTML = '<div class="empty">loading pool…</div>';
  async function load() {
    const [pool, attribution] = await Promise.all([api.get('/api/pool'), api.get('/api/attribution')]);
    const e = pool.engine;
    const line = e.running
      ? `engine <span class="ok">running</span>${e.live ? ` · tick ${e.tick} · ${fmt.ago(Date.now() - Date.parse(e.updatedAt))}` : ' · <span class="warn">no fresh snapshot yet</span>'}${pool.parallelism ? ` · parallelism ${pool.parallelism.effective}/${pool.parallelism.configured}${pool.parallelism.effective < pool.parallelism.configured ? ' <span class="warn">(throttled)</span>' : ''}` : ''}${pool.capacity ? ` · <span class="warn">paused: ${fmt.esc(pool.capacity.reason)} until ${new Date(pool.capacity.pausedUntil).toLocaleTimeString()}</span>` : ''}`
      : 'engine <span class="muted">stopped</span>';
    const totals = attribution.reduce((acc, r) => { acc.tasks += r.count ?? 0; acc.tokens += r.sumTokensProcessed ?? 0; acc.cost += r.sumEstimatedCostUsd ?? 0; acc.cr += r.sumCacheRead ?? 0; acc.ci += (r.sumInput ?? 0) + (r.sumCacheRead ?? 0); return acc; }, { tasks: 0, tokens: 0, cost: 0, cr: 0, ci: 0 });
    el.innerHTML = `<div class="kv muted" style="margin-bottom:10px"><span>${line}</span><button class="btn" id="reload">Refresh</button></div>
      <div class="grid">${Object.entries(pool.providers).map(([id, p]) => providerCard(id, p, fmt)).join('') || '<div class="empty">no providers reported yet</div>'}</div>
      <div class="card" style="margin-top:12px;padding:0"><table><thead><tr><th>student</th><th>provider · harness</th><th>model</th><th>tier / role</th><th>state</th><th>item</th><th>tokens</th><th>cache hit</th><th>started</th></tr></thead>
        <tbody>${pool.students.length ? pool.students.map((s) => studentRow(s, fmt)).join('') : `<tr><td colspan="9" class="empty">${e.running ? 'no students yet' : 'engine stopped — no live students'}</td></tr>`}</tbody></table></div>
      <div class="grid" style="margin-top:12px">
        ${ladderCard('Assignment ladder (ledger, all time)', pool.ladder, 'From the ledger — survives restarts.')}
        ${ladderCard('Assignment ladder (this engine run)', pool.ladderSession, e.running ? 'Process memory; resets on restart.' : 'engine stopped')}
        <div class="card"><h3>Attribution (ledger)</h3>
          <div class="kv"><span>tasks</span><span class="mono">${fmt.n(totals.tasks)}</span></div>
          <div class="kv"><span>tokens processed</span><span class="mono">${fmt.tok(totals.tokens)}</span></div>
          <div class="kv"><span>cache hit</span><span class="mono">${totals.ci ? Math.round((totals.cr / totals.ci) * 100) : 0}%</span></div>
          <div class="kv"><span>estimated $ <span class="muted">(not billed on subscription)</span></span><span class="mono">${fmt.usd(totals.cost)}</span></div>
          <table style="margin-top:8px"><thead><tr><th>role</th><th>tier</th><th>provider</th><th>tasks</th><th>tokens</th><th>est. $</th></tr></thead><tbody>
            ${attribution.slice(0, 30).map((r) => `<tr><td>${fmt.esc(r.role)}</td><td>${fmt.esc(r.tier ?? '—')}</td><td><span class="pill ${r.provider}">${r.provider}</span></td><td>${r.count}</td><td class="mono">${fmt.tok(r.sumTokensProcessed)}</td><td class="mono">${fmt.usd(r.sumEstimatedCostUsd)}</td></tr>`).join('')}
          </tbody></table></div>
      </div>`;
    el.querySelector('#reload')?.addEventListener('click', load);
  }
  await load();
  const t = setInterval(load, 5_000);
  return () => clearInterval(t);
}
