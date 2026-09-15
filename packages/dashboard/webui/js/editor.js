// Editor: an architect-altitude reviewer that proposes issues in bounded
// chunks on the provider the toggle says. The instance proposes; the
// orchestrator files through the planner's filing path. State per repo is
// the handoff + the filed ledger; both survive restarts.

function stateCard(r, fmt) {
  const s = r.state;
  const head = `<div class="kv"><h2>${fmt.esc(r.repo)}</h2><span>${r.running ? '<span class="ok">running</span>' : s ? `<span class="muted">${s.status}${s.stoppedBy ? ` · stopped by ${s.stoppedBy}` : ''}</span>` : '<span class="muted">never run</span>'}</span></div>`;
  if (!s) return `<div class="card">${head}<div class="muted">No Editor run yet for this repo.</div></div>`;
  const passes = s.passes.slice(-6).map((p) => `<tr><td>${p.instance}</td><td>${p.status}</td><td>${p.chunk}</td><td>${p.maxIssuesPerChunk}</td><td class="mono">${fmt.tok(p.inputTokens + p.outputTokens)}</td><td>${p.filed}</td><td>${p.skipped}</td><td>${p.guardrailHit ? '<span class="bad">reverted</span>' : ''}</td></tr>`).join('');
  const filed = s.filed.slice(-10).map((f) => `<div class="kv"><span><a href="${fmt.esc(f.url)}" target="_blank" class="mono">${fmt.esc(f.key)}</a> ${fmt.esc(f.title)}</span><span class="muted">pass ${f.instance}</span></div>`).join('') || '<div class="muted">nothing filed yet</div>';
  return `<div class="card">${head}
    <div class="kv muted"><span>goal: ${fmt.esc(s.goal.slice(0, 120))}</span><span>${s.provider ?? ''} · ${s.instances} pass(es) · ${fmt.tok(s.totalInputTokens + s.totalOutputTokens)} tokens · ${s.guardrailHits} dirty-tree revert(s)</span></div>
    <h3 style="margin-top:8px">Filed (${s.filed.length})</h3>${filed}
    <h3 style="margin-top:8px">Passes</h3>
    <table><thead><tr><th>#</th><th>status</th><th>chunk</th><th>max</th><th>tokens</th><th>filed</th><th>skipped</th><th>tree</th></tr></thead><tbody>${passes || '<tr><td colspan="8" class="muted">none</td></tr>'}</tbody></table>
    <details style="margin-top:8px"><summary class="muted">HANDOFF.md</summary><pre class="log">${fmt.esc(s.handoff || '(empty)')}</pre></details>
    ${r.running ? `<div style="margin-top:8px"><button class="btn" data-stop="${fmt.esc(r.repo)}">Stop after this pass</button></div>` : ''}
  </div>`;
}

export async function renderEditor(el, { api, fmt, status }) {
  const repos = status?.repos ?? [];
  el.innerHTML = `
    <div class="card">
      <h3>Start an Editor run</h3>
      <div class="filters">
        <select id="ed-repo">${repos.map((r) => `<option>${fmt.esc(r)}</option>`).join('') || '<option value="">no repos configured</option>'}</select>
        <input id="ed-goal" placeholder="the brief, e.g. streamline the request path and remove dead modules" style="flex:1;min-width:280px">
        <label class="muted">passes <input id="ed-passes" type="number" min="1" max="12" value="3" style="width:56px"></label>
        <label class="muted">issues/pass <input id="ed-chunk" type="number" min="1" max="8" value="3" style="width:56px"></label>
        <label class="muted" title="File as needs-human so nothing builds before you read it"><input id="ed-park" type="checkbox" checked> park proposals</label>
        <button class="btn" id="ed-start">Start</button>
        <span class="muted" id="ed-msg"></span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">Runs on the provider selected in the header for this screen. The instance proposes; the orchestrator lints and files through the planner path (rejected drafts are not filed). A dirty tree is reverted and counted.</div>
    </div>
    <div class="grid" id="ed-cards" style="margin-top:12px"></div>`;
  async function load() {
    const st = await api.get('/api/editor/status');
    const active = new Map(st.active.map((a) => [a.repo, a]));
    el.querySelector('#ed-cards').innerHTML = st.repos.map((r) => stateCard({ ...r, running: active.has(r.repo) }, fmt)).join('') || '<div class="empty">No repos configured. Add one in Settings.</div>';
    for (const a of st.active) if (a.error) el.querySelector('#ed-msg').textContent = `${a.repo}: ${a.error}`;
    el.querySelectorAll('button[data-stop]').forEach((b) => b.addEventListener('click', async () => { b.disabled = true; await api.post('/api/editor/stop', { repo: b.dataset.stop }); }));
  }
  el.querySelector('#ed-start').addEventListener('click', async () => {
    const repo = el.querySelector('#ed-repo').value; const goal = el.querySelector('#ed-goal').value.trim();
    const msg = el.querySelector('#ed-msg');
    if (!repo || !goal) { msg.textContent = 'repo and goal are required'; return; }
    msg.textContent = 'starting…';
    const r = await api.post('/api/editor/start', { repo, goal, maxInstances: Number(el.querySelector('#ed-passes').value), maxIssuesPerChunk: Number(el.querySelector('#ed-chunk').value), park: el.querySelector('#ed-park').checked });
    msg.textContent = r.ok ? `running on ${r.provider} (${r.harness})` : (r.msg || 'failed');
    await load();
  });
  await load();
  const t = setInterval(load, 5_000);
  return () => clearInterval(t);
}
