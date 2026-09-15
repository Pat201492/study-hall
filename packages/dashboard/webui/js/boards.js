// Boards: each configured repo as the engine sees it — ready, blocked,
// in flight, parked (with one-click unpark) and deadlocked. Fetched live from
// GitHub; the engine's own view (in-flight students, attempts, contested) is
// merged in while it is running. A repo whose fetch fails shows its error and
// never blanks the others.

const KIND_CLASS = { MERGE: 'ok', FIX: 'warn', RESOLVE: 'warn', REVIEW: '', PROMOTE: 'muted', NEEDS_DETAIL: 'muted', TRIAGE: '', IMPLEMENT: '' };

function item(target, n, title, fmt, extra = '') {
  return `<div class="kv"><span><span class="mono muted">${target === 'pr' ? 'PR' : '#'}${n}</span> ${fmt.esc(title)}</span><span>${extra}</span></div>`;
}

function repoCard(b, fmt) {
  const head = `<div class="kv"><h2>${fmt.esc(b.repo)}</h2><span class="muted">${b.error ? '' : `${b.counts.issues} issues · ${b.counts.pulls} PRs`}${b.contested ? ' · <span class="bad">contested</span>' : ''}${b.fromEngine ? '' : ' · <span class="muted">engine view absent</span>'}</span></div>`;
  if (b.error && !b.ready.length && !b.inFlight.length) {
    return `<div class="card">${head}<div class="bad">fetch failed: ${fmt.esc(b.error)}</div></div>`;
  }
  const inFlight = b.inFlight.length
    ? b.inFlight.map((f) => item(f.target, f.number, `${f.role}`, fmt, `<span class="pill ${f.provider}">${f.provider}</span> <span class="mono muted">${fmt.esc(f.model)}</span> <a href="#/runs?id=${encodeURIComponent(f.runId)}" class="mono">${f.runId.slice(0, 8)}</a>`)).join('')
    : '<div class="muted">nothing running</div>';
  const ready = b.ready.length
    ? b.ready.map((r) => item(r.target, r.number, r.title, fmt, `<span class="${KIND_CLASS[r.kind] ?? ''}" title="${fmt.esc(r.reason)}">${r.kind}</span>`)).join('')
    : '<div class="muted">nothing ready</div>';
  const blocked = b.blocked.length
    ? b.blocked.map((r) => item(r.target, r.number, r.title, fmt, `<span class="muted">${fmt.esc(r.reason)}</span>`)).join('')
    : '<div class="muted">nothing blocked</div>';
  const parked = b.parked.length
    ? b.parked.map((p) => `<div class="kv"><span><span class="mono muted">${p.target === 'pr' ? 'PR' : '#'}${p.number}</span> ${fmt.esc(p.title)} <span class="muted">· ${p.attempts} attempt(s)</span></span><span>${p.labels.map((l) => `<button class="btn" data-unpark="${fmt.esc(b.repo)}|${p.number}|${p.target}|${l}" title="Remove the ${l} label">unpark ${l}</button>`).join(' ')}</span></div>`).join('')
    : '<div class="muted">nothing parked</div>';
  const deadlocked = b.deadlocked.length
    ? b.deadlocked.map((d) => item('pr', d.number, d.title, fmt, `<span class="bad">${d.labels.join(' + ')}</span>`)).join('')
    : '';
  return `<div class="card">${head}
    ${b.error ? `<div class="warn">last fetch failed: ${fmt.esc(b.error)} — showing the engine's last view</div>` : ''}
    <h3 style="margin-top:8px">In flight (${b.inFlight.length})</h3>${inFlight}
    <h3 style="margin-top:10px">Ready (${b.ready.length})</h3>${ready}
    <h3 style="margin-top:10px">Blocked (${b.blocked.length})</h3>${blocked}
    <h3 style="margin-top:10px">Parked (${b.parked.length})</h3>${parked}
    ${deadlocked ? `<h3 style="margin-top:10px">Deadlocked — a human must settle these</h3>${deadlocked}` : ''}
  </div>`;
}

export async function renderBoards(el, { api, fmt }) {
  el.innerHTML = '<div class="empty">loading boards…</div>';
  async function load() {
    const data = await api.get('/api/boards');
    const e = data.engine;
    const line = e.running
      ? `engine <span class="ok">running</span>${e.live ? ` · tick ${e.tick} · ${fmt.ago(Date.now() - Date.parse(e.updatedAt))}` : ' · <span class="warn">no fresh snapshot yet</span>'}${e.boundedRun ? ` · bounded ${e.boundedRun.done}/${e.boundedRun.limit} ${e.boundedRun.unit}s` : ''}${e.lastTick ? ` · last tick: ${e.lastTick.dispatched} dispatched, ${e.lastTick.acted} acted, ${e.lastTick.held} held` : ''}`
      : 'engine <span class="muted">stopped</span> — boards shown live from GitHub';
    el.innerHTML = `<div class="kv muted" style="margin-bottom:10px"><span>${line}</span><button class="btn" id="reload">Refresh</button></div>
      <div class="grid">${data.repos.length ? data.repos.map((b) => repoCard(b, fmt)).join('') : '<div class="empty">No repos configured. Add one in Settings.</div>'}</div>`;
    el.querySelector('#reload')?.addEventListener('click', load);
    el.querySelectorAll('button[data-unpark]').forEach((b) => b.addEventListener('click', async () => {
      const [repo, number, target, label] = b.dataset.unpark.split('|');
      b.disabled = true; b.textContent = 'removing…';
      const r = await api.post('/api/board/unpark', { repo, number: Number(number), target, label });
      if (!r.ok) { b.textContent = r.msg || 'failed'; b.disabled = false; return; }
      await load();
    }));
  }
  await load();
  const t = setInterval(load, 20_000);
  return () => clearInterval(t);
}
