// Planner: a chat pane driven by the harness's normalised ChatEvent stream, the
// staged drafts with their lint verdicts, and the file-with-confirm gate. The
// provider comes from the header toggle (surface "planner").

const VERDICT = { ok: 'ok', warn: 'warn', reject: 'bad' };

export async function renderPlanner(el, { api, fmt, status }) {
  const repos = status?.repos ?? [];
  const st = await api.get('/api/planner/status');
  const active = st.active[0];
  let repo = active?.repo ?? repos[0] ?? '';

  el.innerHTML = `
    <div class="filters">
      <input id="p-repo" list="p-repos" placeholder="owner/name" value="${fmt.esc(repo)}"><datalist id="p-repos">${repos.map((r) => `<option value="${fmt.esc(r)}">`).join('')}</datalist>
      <button class="btn primary" id="p-start">${active ? 'Session running' : 'Start planning'}</button>
      <button class="btn" id="p-resume" ${active ? 'hidden' : ''}>Resume last</button>
      <button class="btn" id="p-stop" ${active ? '' : 'hidden'}>Stop</button>
      <button class="btn" id="p-term">Open in terminal ↗</button>
      <span class="muted" id="p-info">${active ? `${active.provider} · ${active.harness} · ${active.turns} turns` : 'no session'}</span>
    </div>
    <div class="grid" style="grid-template-columns: 2fr 1fr; align-items:start">
      <div class="card" style="display:flex; flex-direction:column; min-height:60vh">
        <h3>Conversation</h3>
        <div id="p-chat" style="flex:1; overflow:auto; font-size:13px"></div>
        <div style="display:flex; gap:8px; margin-top:8px">
          <textarea id="p-text" rows="2" style="flex:1; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px" placeholder="Describe the feature… (Enter to send, Shift+Enter for a newline)"></textarea>
          <button class="btn primary" id="p-send">Send</button>
          <button class="btn" id="p-int" title="Interrupt the current turn">⏹</button>
        </div>
      </div>
      <div class="card"><h3>Drafts</h3><div id="p-drafts" class="muted">nothing staged</div>
        <div style="margin-top:10px"><button class="btn primary" id="p-file" hidden>File accepted drafts</button> <span class="muted" id="p-file-msg"></span></div>
        <h3 style="margin-top:14px">Filed</h3><div id="p-filed" class="muted">—</div></div>
    </div>`;

  const chat = el.querySelector('#p-chat');
  const repoInput = el.querySelector('#p-repo');
  const info = el.querySelector('#p-info');
  let es = null; let des = null; let lastSeq = 0; let partialEl = null;

  function line(html, cls = '') {
    const d = document.createElement('div'); d.className = cls; d.style.padding = '4px 0'; d.innerHTML = html; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; return d;
  }
  function render(ev) {
    const e = ev.event;
    if (e.type === 'text') {
      if (e.partial) {
        if (!partialEl) partialEl = line('', 'mono');
        partialEl.textContent += e.text; chat.scrollTop = chat.scrollHeight;
      } else { partialEl = null; line(fmt.esc(e.text).replace(/\n/g, '<br>')); }
    } else if (e.type === 'tool_call') {
      partialEl = null;
      line(`<details><summary class="muted">→ ${fmt.esc(e.name)}</summary><pre class="log">${fmt.esc(JSON.stringify(e.input, null, 2)).slice(0, 4000)}</pre></details>`);
    } else if (e.type === 'tool_result') {
      line(`<details><summary class="muted">← ${fmt.esc(e.name ?? 'result')}${e.isError ? ' <span class="bad">error</span>' : ''}</summary><pre class="log">${fmt.esc(typeof e.output === 'string' ? e.output : JSON.stringify(e.output, null, 2)).slice(0, 4000)}</pre></details>`);
    } else if (e.type === 'turn_done') {
      partialEl = null;
      const u = e.usage; const tok = u ? fmt.tok(u.inputTokens + u.outputTokens + u.cacheReadInputTokens) : '';
      line(`<span class="muted">— turn done${tok ? ` · ${tok} tokens` : ''}${e.costUsd != null ? ` · ${fmt.usd(e.costUsd)} eq.` : ''}</span>`);
      el.querySelector('#p-send').disabled = false;
    } else if (e.type === 'status') {
      if (e.message.startsWith('user: ')) line(`<b>you:</b> ${fmt.esc(e.message.slice(6)).replace(/\n/g, '<br>')}`, 'ok');
      else line(`<span class="muted">${fmt.esc(e.message)}</span>`);
    } else if (e.type === 'quota') {
      const q = e.observation; line(`<span class="muted">quota: 5h ${fmt.pct(q.fiveHour?.utilization)} · 7d ${fmt.pct(q.sevenDay?.utilization)}</span>`);
    } else if (e.type === 'error') {
      line(`<span class="bad">${fmt.esc(e.message)}</span>`); el.querySelector('#p-send').disabled = false;
    } else if (e.type === 'closed') {
      line(`<span class="muted">session closed (exit ${e.exitCode})</span>`);
    }
    lastSeq = ev.seq;
  }
  function connect() {
    es?.close(); des?.close();
    if (!repo) return;
    es = new EventSource(`/api/planner/stream?repo=${encodeURIComponent(repo)}&since=${lastSeq}`);
    es.addEventListener('event', (m) => render(JSON.parse(m.data)));
    des = new EventSource(`/api/planner/drafts/stream?repo=${encodeURIComponent(repo)}`);
    des.addEventListener('drafts', (m) => renderDrafts(JSON.parse(m.data)));
  }
  function renderDrafts(d) {
    const box = el.querySelector('#p-drafts');
    const staged = d.staged;
    if (!staged || !staged.drafts.length) { box.innerHTML = '<span class="muted">nothing staged</span>'; el.querySelector('#p-file').hidden = true; }
    else {
      const byKey = Object.fromEntries(staged.lints.map((l) => [l.key, l]));
      box.innerHTML = staged.drafts.map((dr) => {
        const l = byKey[dr.key.toLowerCase().replace(/[^a-z0-9]+/g, '-')] ?? byKey[dr.key];
        return `<div style="border-bottom:1px solid var(--line); padding:6px 0">
          <div class="kv"><b>${fmt.esc(dr.title)}</b><span class="state ${l ? VERDICT[l.verdict] === 'bad' ? 'exhausted' : l.verdict === 'warn' ? 'unknown' : 'available' : ''}">${l?.verdict ?? '?'}</span></div>
          <div class="muted mono" style="font-size:11px">${fmt.esc(dr.key)} · ${l?.computed.difficulty ?? ''} · ${l?.computed.criteria ?? '?'} criteria${dr.dependsOn?.length ? ' · depends on ' + dr.dependsOn.map(fmt.esc).join(', ') : ''}</div>
          ${l?.reasons?.length ? `<ul style="margin:4px 0 0 16px; font-size:12px">${l.reasons.map((r) => `<li>${fmt.esc(r)}</li>`).join('')}</ul>` : ''}
          <details><summary class="muted" style="font-size:12px">body</summary><pre class="log" style="max-height:30vh">${fmt.esc(dr.body)}</pre></details>
          <button class="btn" data-remove="${fmt.esc(dr.key)}" style="font-size:11px; padding:2px 8px">remove</button>
        </div>`;
      }).join('');
      const accepted = staged.lints.filter((l) => l.verdict !== 'reject').length;
      const fb = el.querySelector('#p-file'); fb.hidden = accepted === 0; fb.textContent = `File ${accepted} accepted draft${accepted === 1 ? '' : 's'}`;
      box.querySelectorAll('button[data-remove]').forEach((b) => b.addEventListener('click', () => api.post('/api/planner/drafts/remove', { repo, key: b.dataset.remove })));
    }
    el.querySelector('#p-filed').innerHTML = d.filed?.length ? d.filed.map((f) => `<div class="kv"><a href="${f.url}" target="_blank">#${f.number} ${fmt.esc(f.title)} ↗</a><span class="muted">${new Date(f.ts).toLocaleDateString()}</span></div>`).join('') : '—';
  }

  async function start(resume) {
    repo = repoInput.value.trim(); if (!repo) return;
    el.querySelector('#p-start').disabled = true; info.textContent = 'starting (cloning the repo on first use)…';
    const r = await api.post('/api/planner/start', { repo, resume });
    if (!r.ok) { info.textContent = r.msg || 'failed'; el.querySelector('#p-start').disabled = false; return; }
    info.textContent = `${r.session.provider} · ${r.session.harness}`;
    el.querySelector('#p-start').textContent = 'Session running'; el.querySelector('#p-stop').hidden = false; el.querySelector('#p-resume').hidden = true;
    chat.innerHTML = ''; lastSeq = 0; connect();
  }
  el.querySelector('#p-start').addEventListener('click', () => start(false));
  el.querySelector('#p-resume').addEventListener('click', () => start(true));
  el.querySelector('#p-stop').addEventListener('click', async () => { await api.post('/api/planner/stop', { repo }); el.querySelector('#p-stop').hidden = true; el.querySelector('#p-start').textContent = 'Start planning'; el.querySelector('#p-start').disabled = false; el.querySelector('#p-resume').hidden = false; });
  el.querySelector('#p-term').addEventListener('click', async () => { repo = repoInput.value.trim(); const r = await api.post('/api/planner/open-terminal', { repo }); info.textContent = r.ok ? r.note : (r.msg || 'failed'); if (r.ok) connect(); });
  const send = async () => {
    const t = el.querySelector('#p-text'); const text = t.value.trim(); if (!text) return;
    el.querySelector('#p-send').disabled = true; t.value = '';
    const r = await api.post('/api/planner/say', { repo, text });
    if (!r.ok) { line(`<span class="bad">${fmt.esc(r.msg || 'send failed')}</span>`); el.querySelector('#p-send').disabled = false; }
  };
  el.querySelector('#p-send').addEventListener('click', send);
  el.querySelector('#p-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  el.querySelector('#p-int').addEventListener('click', () => api.post('/api/planner/interrupt', { repo }));
  el.querySelector('#p-file').addEventListener('click', async () => {
    if (!confirm('File every accepted draft on GitHub now? Dependencies are filed first and real numbers written into dependants.')) return;
    const m = el.querySelector('#p-file-msg'); m.textContent = 'filing…';
    const r = await api.post('/api/planner/file', { repo, confirm: true });
    m.textContent = r.ok ? r.results.map((x) => `${x.key}: ${x.status}${x.number ? ' #' + x.number : ''}`).join(' · ') : (r.msg || 'failed');
  });

  if (active) connect();
  else if (repo) { const d = await api.get(`/api/planner/drafts?repo=${encodeURIComponent(repo)}`); renderDrafts(d); }
  return () => { es?.close(); des?.close(); };
}
