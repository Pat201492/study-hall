// Arena: renders study-arena's export envelope (study-arena/export/v1) —
// corpus standing, the (harness × meter) matrix per sweep with paired CIs,
// and the verdict. Read-only; the arena computes, this shows.

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const num = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));

function matrixRows(metrics) {
  const groups = new Map();
  for (const [id, m] of Object.entries(metrics)) {
    const key = `${m.harness}|${m.meter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([id, m]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function sweepCard(s, comparisons, fmt) {
  const cmp = comparisons.filter((c) => s.lanes.includes(c.a) && s.lanes.includes(c.b));
  const rows = matrixRows(s.metrics).map(([key, lanes]) => {
    const [harness, meter] = key.split('|');
    return lanes.map(([id, m], i) => `<tr>${i === 0 ? `<td rowspan="${lanes.length}"><b>${fmt.esc(harness)}</b><br><span class="muted">${fmt.esc(meter)}</span></td>` : ''}<td class="mono">${fmt.esc(id)}</td><td>${m.n}</td><td>${pct(m.acceptanceRate)}</td><td class="mono">${m.meter === 'local' ? '$0 (local)' : m.meter === 'subscription' ? `${num(m.usdPerMergedAC)} <span class="muted">est.</span>` : num(m.usdPerMergedAC)}</td><td class="mono">${num(m.tokensPerMergedAC, 0)}</td><td>${num(m.reworkMultiplier, 2)}</td><td>${pct(m.firstPassRate)}</td><td>${pct(m.passAt1)}</td><td>${pct(m.passAt3)}</td><td>${pct(m.passHat3)}</td></tr>`).join('');
  }).join('');
  const verdictCls = s.verdict === 'keep' ? 'ok' : s.verdict === 'revert' ? 'bad' : s.verdict === 'widen' ? 'warn' : 'muted';
  return `<div class="card">
    <div class="kv"><h2>sweep ${fmt.esc(s.id)}</h2><span class="${verdictCls}" style="font-weight:600">${s.verdict ?? 'no verdict'}</span></div>
    <div class="kv muted"><span>manifest ${fmt.esc((s.manifestSha256 || '').slice(0, 12))} · ${s.startedAt ? new Date(s.startedAt).toLocaleDateString() : ''} → ${s.finishedAt ? new Date(s.finishedAt).toLocaleDateString() : 'in progress'}</span><span>${s.trials.completed}/${s.trials.planned} trials · ${s.trials.budgetExhausted} budget · ${s.trials.usageLimit} usage-limit (excluded)</span></div>
    <div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th>harness · meter</th><th>lane</th><th>n</th><th>accept</th><th>$ / merged AC</th><th>tokens / AC</th><th>rework</th><th>first-pass</th><th>Pass@1</th><th>Pass@3</th><th>Pass^3</th></tr></thead><tbody>${rows || '<tr><td colspan="11" class="muted">no metrics yet</td></tr>'}</tbody></table></div>
    <div class="muted" style="font-size:12px;margin-top:6px">Rows of different meters are never summed. Subscription $ are price-table estimates, not amounts charged.</div>
    ${cmp.length ? `<h3 style="margin-top:10px">Paired comparisons (candidate / control, bootstrap over items)</h3><table><thead><tr><th>candidate</th><th>control</th><th>metric</th><th>items</th><th>median ratio</th><th>95% CI</th><th>reading</th></tr></thead><tbody>${cmp.map((c) => { const r = c.items < 2 ? 'insufficient' : c.ci95[0] > 1 ? 'control cheaper' : c.ci95[1] < 1 ? 'candidate cheaper' : 'no detectable difference'; return `<tr><td class="mono">${fmt.esc(c.a)}</td><td class="mono">${fmt.esc(c.b)}</td><td>${fmt.esc(c.metric)}</td><td>${c.items}</td><td>${num(c.medianRatio, 2)}</td><td class="mono">[${num(c.ci95[0], 2)}, ${num(c.ci95[1], 2)}]</td><td>${r}</td></tr>`; }).join('')}</tbody></table>` : ''}
    ${s.verdictDoc ? `<div class="muted" style="margin-top:6px">verdict doc: <span class="mono">${fmt.esc(s.verdictDoc)}</span></div>` : ''}
  </div>`;
}

export async function renderArena(el, { api, fmt }) {
  el.innerHTML = '<div class="empty">reading the arena export…</div>';
  const r = await api.get('/api/arena');
  if (!r.ok) {
    el.innerHTML = `<div class="card"><h3>Arena</h3><div class="bad">${fmt.esc(r.reason)}</div>${r.expected ? `<div class="muted">expected <span class="mono">${fmt.esc(r.expected)}</span>, found <span class="mono">${fmt.esc(String(r.found))}</span></div>` : ''}<div class="muted" style="margin-top:6px">checkout: <span class="mono">${fmt.esc(r.arenaDir ?? '')}</span></div></div>`;
    return;
  }
  const e = r.envelope;
  const corpus = e.sections.corpus;
  const sweeps = e.sections.sweeps;
  const comparisons = e.sections.comparisons ?? [];
  el.innerHTML = `
    <div class="kv muted" style="margin-bottom:10px"><span><span class="mono">${fmt.esc(e.schema)}</span> · arena ${fmt.esc(e.arena.version)} · harness commit ${fmt.esc((e.arena.harnessCommit || 'unknown').slice(0, 12))} · price table ${fmt.esc(e.arena.pricingTableVersion)}</span><span>generated ${new Date(e.generatedAt).toLocaleString()}</span></div>
    <div class="grid">${corpus ? corpus.map((c) => `<div class="card"><h3>corpus ${fmt.esc(c.name)}</h3><div class="kv"><span>items</span><span class="mono">${c.items}</span></div><div class="kv"><span>validated</span><span class="mono">${c.validatedAt ? `${c.valid ?? '?'} valid` : 'never'}</span></div><div class="kv"><span>bands</span><span class="mono">${Object.entries(c.bands).map(([b, n]) => `${b}: ${n}`).join(' · ')}</span></div><div class="kv"><span>sha</span><span class="mono">${fmt.esc(c.sha256.slice(0, 12))}</span></div></div>`).join('') : '<div class="card"><h3>corpus</h3><div class="muted">never run</div></div>'}</div>
    <div style="margin-top:12px">${sweeps ? sweeps.map((s) => sweepCard(s, comparisons, fmt)).join('') : '<div class="card"><h3>sweeps</h3><div class="muted">no sweep has run</div></div>'}</div>`;
}
