// Admissions: the sweep that flags what the board cannot build. Report first
// (scan changes nothing), then Apply (labels + one explanatory comment each,
// confirm-gated), then Split (a student carves buildable pieces out of parked
// issues; dry run available; bounded by a limit; stop button).

function findingRow(f, fmt) {
  const v = f.verdict === 'blocked' ? '<span class="bad">blocked</span>' : f.verdict === 'unsure' ? '<span class="warn">unsure</span>' : '<span class="ok">buildable</span>';
  const audit = f.audit?.verdict && f.audit.verdict !== 'ok' ? `<span class="muted">· ${f.audit.verdict}</span>` : '';
  const would = f.wouldLabel.length ? f.wouldLabel.map((l) => `<span class="pill">${l}</span>`).join(' ') : f.alreadyFlagged ? '<span class="muted">already flagged</span>' : '';
  return `<tr><td>${fmt.esc(f.repo)}</td><td><a href="${fmt.esc(f.url)}" target="_blank">#${f.number}</a> ${fmt.esc(f.title)}</td><td>${v} ${audit}</td><td>${would}</td><td class="muted">${(f.admission?.blockers ?? []).map((b) => fmt.esc(b.kind)).join(', ')}</td></tr>`;
}

export async function renderAdmissions(el, { api, fmt }) {
  el.innerHTML = `
    <div class="card">
      <div class="filters">
        <button class="btn" id="ad-scan">Scan (report only)</button>
        <button class="btn" id="ad-apply" disabled title="Adds needs-human / needs-detail with one explanatory comment each">Apply flags</button>
        <span style="flex:1"></span>
        <label class="muted">split limit <input id="ad-split-limit" type="number" min="1" max="50" value="5" style="width:56px"></label>
        <button class="btn" id="ad-split-dry">Split (dry run)</button>
        <button class="btn" id="ad-split-go">Split and file</button>
        <button class="btn" id="ad-split-stop" hidden>Stop split</button>
        <span class="muted" id="ad-msg"></span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">Scan touches nothing. Apply writes only <span class="mono">needs-human</span> / <span class="mono">needs-detail</span> plus a marker-guarded comment. Split asks a student (on this screen's provider) what can be carved out of each parked issue; children are filed <span class="mono">triaged</span> with their difficulty, parents stay open and flagged, nothing is ever closed.</div>
    </div>
    <div id="ad-summary" class="grid" style="margin-top:12px"></div>
    <div class="card" style="margin-top:12px;padding:0"><table><thead><tr><th>repo</th><th>issue</th><th>verdict</th><th>would gain</th><th>blockers</th></tr></thead><tbody id="ad-rows"><tr><td colspan="5" class="empty">Run a scan.</td></tr></tbody></table></div>
    <div class="card" style="margin-top:12px"><h3>Split run</h3><div id="ad-split" class="muted">none yet</div></div>`;
  const msg = el.querySelector('#ad-msg');
  let pending = [];
  function renderReport(report) {
    if (!report) return;
    pending = report.findings.filter((f) => f.wouldLabel.length);
    el.querySelector('#ad-apply').disabled = pending.length === 0 || report.applied;
    el.querySelector('#ad-summary').innerHTML = report.repos.map((r) => `<div class="card"><h2>${fmt.esc(r.repo)}</h2>${r.error ? `<div class="bad">${fmt.esc(r.error)}</div>` : `<div class="kv"><span>open</span><span class="mono">${r.open}</span></div><div class="kv"><span>buildable</span><span class="mono ok">${r.buildable}</span></div><div class="kv"><span>blocked (needs a human)</span><span class="mono bad">${r.blocked}</span></div><div class="kv"><span>unsure</span><span class="mono warn">${r.unsure}</span></div><div class="kv"><span>underspecified</span><span class="mono">${r.underspecified}</span></div><div class="kv"><span>oversized (triage owns)</span><span class="mono">${r.oversized}</span></div>`}</div>`).join('');
    const rows = report.findings.filter((f) => f.verdict !== 'buildable' || f.wouldLabel.length || f.audit?.verdict !== 'ok');
    el.querySelector('#ad-rows').innerHTML = rows.length ? rows.map((f) => findingRow(f, fmt)).join('') : '<tr><td colspan="5" class="empty">Every open issue is buildable and well-formed.</td></tr>';
    msg.textContent = `${report.applied ? 'applied' : 'scanned'} ${new Date(report.ran).toLocaleTimeString()} · ${pending.length} would be flagged${report.actions.length ? ` · ${report.actions.length} action(s)` : ''}`;
  }
  function renderSplit(s) {
    const box = el.querySelector('#ad-split');
    el.querySelector('#ad-split-stop').hidden = !s || s.done;
    if (!s) { box.textContent = 'none yet'; return; }
    const head = `${s.dry ? 'dry run' : 'filing'} · started ${new Date(s.startedAt).toLocaleTimeString()} · ${s.done ? (s.error ? `<span class="bad">failed: ${fmt.esc(s.error)}</span>` : `done: ${s.summary?.considered ?? 0} considered, ${s.summary?.filed ?? 0} filed`) : '<span class="ok">running</span>'}`;
    box.innerHTML = `<div>${head}</div>` + (s.events.map((e) => `<div class="kv" style="margin-top:4px"><span>${fmt.esc(e.repo)}#${e.number} ${fmt.esc(e.title.slice(0, 60))}</span><span class="muted">${fmt.esc(e.note)}</span></div>`).join('') || '<div class="muted">no issues considered yet</div>');
  }
  async function load() {
    const d = await api.get('/api/admissions');
    renderReport(d.report);
    renderSplit(d.split);
  }
  el.querySelector('#ad-scan').addEventListener('click', async () => { msg.textContent = 'scanning…'; const r = await api.post('/api/admissions/scan'); renderReport(r.report); });
  el.querySelector('#ad-apply').addEventListener('click', async () => {
    if (!confirm(`Apply ${pending.length} label(s) with explanatory comments on GitHub?`)) return;
    msg.textContent = 'applying…'; const r = await api.post('/api/admissions/apply', { confirm: true }); renderReport(r.report);
  });
  const runSplit = async (dry) => {
    if (!dry && !confirm('File carved-out issues on GitHub for every parked issue the student can split? Parents stay open and flagged.')) return;
    const r = await api.post('/api/admissions/split', { dry, limit: Number(el.querySelector('#ad-split-limit').value) });
    msg.textContent = r.ok ? `split ${dry ? 'dry run' : ''} started on ${r.provider}` : (r.msg || 'failed');
    await load();
  };
  el.querySelector('#ad-split-dry').addEventListener('click', () => runSplit(true));
  el.querySelector('#ad-split-go').addEventListener('click', () => runSplit(false));
  el.querySelector('#ad-split-stop').addEventListener('click', async () => { await api.post('/api/admissions/split/stop'); await load(); });
  await load();
  const t = setInterval(load, 5_000);
  return () => clearInterval(t);
}
