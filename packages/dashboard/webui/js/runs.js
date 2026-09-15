// Runs: paged run history from the ledger with filters, a detail dialog
// (tokens split, cost per meter, outcomes, events) and the transcript viewer.

function pill(v) { return `<span class="pill ${v}">${v}</span>`; }

function row(r, fmt) {
  const tokens = r.inputTokens + r.outputTokens + r.cacheReadInputTokens;
  const cost = r.meter === 'subscription' ? `${fmt.usd(r.estimatedCostUsd)} <span class="muted">eq.</span>` : r.meter === 'metered' ? fmt.usd(r.estimatedCostUsd) : '<span class="muted">local</span>';
  return `<tr class="row" data-id="${r.runId}">
    <td class="mono muted">${new Date(r.ts).toLocaleString()}</td>
    <td>${fmt.esc(r.repo)}#${r.item}</td><td>${fmt.esc(r.role)}</td>
    <td>${pill(r.provider)} <span class="muted">${fmt.esc(r.harness)}</span></td>
    <td class="mono">${fmt.esc(r.model ?? '')}</td>
    <td>${r.warmMechanism ?? '—'}</td>
    <td class="mono" title="in ${fmt.n(r.inputTokens)} · out ${fmt.n(r.outputTokens)} · cache read ${fmt.n(r.cacheReadInputTokens)} · cache write ${fmt.n(r.cacheCreationInputTokens)} · reasoning ${fmt.n(r.reasoningTokens)}">${fmt.tok(tokens)}</td>
    <td>${r.turns ?? '—'}</td><td>${fmt.dur(r.durationMs)}</td>
    <td>${cost}</td>
    <td>${r.stoppedBy ? `<span class="warn">${r.stoppedBy}</span>` : r.errorClass ? `<span class="bad">${r.errorClass}</span>` : '<span class="ok">ok</span>'}<span class="muted"> · ${r.fidelity}</span></td>
  </tr>`;
}

export async function renderRuns(el, { api, fmt }) {
  el.innerHTML = `
    <div class="filters">
      <input id="f-repo" placeholder="repo owner/name">
      <select id="f-provider"><option value="">any provider</option><option>anthropic</option><option>openai</option><option>local</option></select>
      <select id="f-role"><option value="">any role</option><option>implement</option><option>review</option><option>fix</option><option>rewrite</option><option>resolve</option><option>triage</option><option>merge</option><option>planner</option><option>probe</option></select>
      <select id="f-outcome"><option value="">any outcome</option><option>merged</option><option>pr-opened</option><option>review-approve</option><option>review-changes</option><option>empty-diff</option><option>failed</option><option>abandoned</option></select>
      <button class="btn" id="f-go">Filter</button>
      <span class="muted" id="count"></span>
    </div>
    <div class="card" style="padding:0"><table><thead><tr>
      <th>when</th><th>item</th><th>role</th><th>provider · harness</th><th>model</th><th>warm</th><th>tokens</th><th>turns</th><th>time</th><th>cost</th><th>result · fidelity</th>
    </tr></thead><tbody id="rows"></tbody></table>
    <div style="padding:10px"><button class="btn" id="more" hidden>Load more</button></div></div>
    <dialog id="detail"></dialog>`;

  let cursor = null; let rows = [];
  const filter = () => {
    const q = new URLSearchParams();
    for (const [k, id] of [['repo', 'f-repo'], ['provider', 'f-provider'], ['role', 'f-role'], ['outcome', 'f-outcome']]) {
      const v = el.querySelector('#' + id).value.trim(); if (v) q.set(k, v);
    }
    if (cursor) q.set('cursor', cursor);
    q.set('limit', '50');
    return q.toString();
  };
  async function load(reset) {
    if (reset) { cursor = null; rows = []; }
    const page = await api.get('/api/runs?' + filter());
    rows = rows.concat(page.rows); cursor = page.nextCursor;
    el.querySelector('#rows').innerHTML = rows.length ? rows.map((r) => row(r, fmt)).join('') : '<tr><td colspan="11" class="empty">No runs yet. Import v1 usage from Overview, or start the engine.</td></tr>';
    el.querySelector('#more').hidden = !cursor;
    el.querySelector('#count').textContent = `${rows.length} shown`;
  }
  el.querySelector('#f-go').addEventListener('click', () => load(true));
  el.querySelector('#more').addEventListener('click', () => load(false));
  el.querySelector('#rows').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr.row'); if (!tr) return;
    const d = await api.get('/api/runs/' + encodeURIComponent(tr.dataset.id));
    showDetail(el.querySelector('#detail'), d, fmt);
  });
  await load(true);
}

function showDetail(dlg, d, fmt) {
  const r = d.run;
  const kv = (k, v) => `<div class="kv"><span class="muted">${k}</span><span class="mono">${v}</span></div>`;
  dlg.innerHTML = `
    <h2>${fmt.esc(r.repo)}#${r.item} · ${fmt.esc(r.role)} · ${pill(r.provider)} ${fmt.esc(r.harness)}</h2>
    <div class="grid">
      <div class="card"><h3>Spend</h3>
        ${kv('input (fresh)', fmt.n(r.inputTokens))}${kv('cache read', fmt.n(r.cacheReadInputTokens))}${kv('cache write', fmt.n(r.cacheCreationInputTokens))}${kv('output', fmt.n(r.outputTokens))}${kv('reasoning', fmt.n(r.reasoningTokens))}
        ${kv('turns', r.turns ?? '—')}${kv('duration', fmt.dur(r.durationMs))}
        ${kv(r.meter === 'subscription' ? 'estimated equivalent $ (not billed)' : 'estimated $', fmt.usd(r.estimatedCostUsd) + ` <span class="muted">${r.costBasis ?? ''} · table ${r.pricingTableVersion ?? ''}</span>`)}
        ${r.reportedCostUsd != null ? kv('harness-reported $', fmt.usd(r.reportedCostUsd)) : ''}
        ${kv('fidelity', r.fidelity)}${kv('meter', r.meter)}</div>
      <div class="card"><h3>Run</h3>
        ${kv('runId', r.runId)}${kv('model / effort', `${fmt.esc(r.model ?? '')} ${fmt.esc(r.effort ?? '')}`)}${kv('warm', `${r.warmMechanism ?? '—'} ${r.sessionId ? '· ' + fmt.esc(r.sessionId) : ''}`)}
        ${kv('started', new Date(r.startedAt).toLocaleString())}${kv('branch', fmt.esc(r.branch ?? '—'))}${kv('worktree', fmt.esc(r.worktree ?? '—'))}
        ${kv('tools', fmt.esc((r.toolAllowlist ?? []).join(' ') || 'default surface'))}${kv('stopped / error', `${r.stoppedBy ?? '—'} / ${r.errorClass ?? '—'}`)}
        ${d.transcript ? kv('transcript', d.transcript.exists ? `<a href="/api/runs/${encodeURIComponent(r.runId)}/transcript" target="_blank">${fmt.tok(d.transcript.bytes)} bytes ↗</a>` : '<span class="muted">not on disk</span>') : kv('transcript', '<span class="muted">none recorded</span>')}</div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Outcomes</h3>${d.outcomes.length ? d.outcomes.map((o) => `<div class="kv"><span>${new Date(o.ts).toLocaleString()} · <b>${o.outcome}</b> ${o.prUrl ? `<a href="${o.prUrl}" target="_blank">#${o.prNumber} ↗</a>` : ''}</span><span class="muted">${fmt.esc(o.detail ?? '')} ${o.additions != null ? `+${o.additions}/−${o.deletions}` : ''}</span></div>`).join('') : '<div class="muted">none yet</div>'}</div>
    <div class="card" style="margin-top:12px"><h3>Events</h3><pre class="log">${d.events.map((e) => `${e.ts} [${e.level}] ${e.event}${e.reason ? ' — ' + fmt.esc(e.reason) : ''}`).join('\n') || 'none'}</pre></div>
    <div style="margin-top:10px; text-align:right"><button class="btn" id="close">Close</button></div>`;
  dlg.querySelector('#close').addEventListener('click', () => dlg.close());
  dlg.showModal();
}
