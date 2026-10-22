// Boards: each configured repo as the engine sees it — ready, blocked,
// in flight, parked (with one-click unpark) and deadlocked. Fetched live from
// GitHub; the engine's own view (in-flight students, attempts, contested) is
// merged in while it is running. A repo whose fetch fails shows its error and
// never blanks the others.

const KIND_CLASS = { MERGE: 'ok', FIX: 'warn', RESOLVE: 'warn', REVIEW: '', PROMOTE: 'muted', NEEDS_DETAIL: 'muted', TRIAGE: '', IMPLEMENT: '' };

function item(target, n, title, fmt, extra = '') {
  return `<div class="kv"><span><span class="mono muted">${target === 'pr' ? 'PR' : '#'}${n}</span> ${fmt.esc(title)}</span><span>${extra}</span></div>`;
}

// The park toggle sits in every board's header, in both views. Parked = the
// engine starts nothing on this board until it is unparked (in-flight finishes).
function parkToggle(b, fmt) {
  return `<button class="btn${b.boardParked ? ' active' : ''}" data-park="${fmt.esc(b.repo)}" data-parked="${b.boardParked ? '1' : '0'}" title="${b.boardParked ? 'Resume: let the engine work this board again' : 'Park: the engine starts nothing on this board (in-flight work finishes)'}">${b.boardParked ? 'Unpark board' : 'Park board'}</button>`;
}
function parkedBadge(b) {
  return b.boardParked ? ' <span class="pill warn" title="Parked from the Boards tab: no new work starts here">parked</span>' : '';
}

function repoCard(b, fmt) {
  const head = `<div class="kv"><h2>${fmt.esc(b.repo)}${parkedBadge(b)}</h2><span class="muted">${parkToggle(b, fmt)} ${b.error ? '' : `${b.counts.issues} issues · ${b.counts.pulls} PRs`}${b.contested ? ' · <span class="bad">contested</span>' : ''}${b.fromEngine ? '' : ' · <span class="muted">engine view absent</span>'}</span></div>`;
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


// ---- chart view ----------------------------------------------------------
// The same board as build order, ported from v1's Plan screen: one column per
// dependency wave, an arrow per "unblocks", colour by stage. The layout maths
// lives in core (planGraph.ts) where it has tests; this only draws.

const STAGE_COLOR = { ready: 'var(--ok)', 'in-pr': 'var(--auto)', blocked: 'var(--muted)', parked: 'var(--warn)' };
const NW = 210, NH = 46, CW = 276, RG = 66, MX = 20, MY = 54;

function planSvg(plan, fmt) {
  const cols = plan.columns.filter((c) => c.length);
  if (!cols.length) return '<div class="muted">No open issues to plan.</div>';
  const rows = Math.max(...cols.map((c) => c.length));
  const W = MX * 2 + cols.length * CW - (CW - NW);
  const H = MY + rows * RG + 12;
  const pos = new Map();
  cols.forEach((c, li) => c.forEach((n, ri) => pos.set(n.number, { x: MX + li * CW, y: MY + ri * RG })));

  const edges = [];
  for (const c of cols) {
    for (const n of c) {
      for (const d of n.openDeps) {
        const a = pos.get(d); const b = pos.get(n.number);
        if (!a || !b) continue;
        // Right edge of the dependency to the left edge of the dependant.
        const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x - 6, y2 = b.y + NH / 2;
        const mid = x1 + Math.max(18, (x2 - x1) / 2);
        edges.push(`<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" fill="none" stroke="var(--line)" stroke-width="1.5" marker-end="url(#ah)"/>`);
      }
    }
  }

  const heads = cols.map((c, li) => `<text x="${MX + li * CW}" y="30" fill="var(--muted)" font-size="11" font-weight="700">${li === 0 ? 'BUILDABLE NOW' : `AFTER WAVE ${li}`}</text>`).join('');
  const nodes = cols.map((c) => c.map((n) => {
    const p = pos.get(n.number);
    const color = STAGE_COLOR[n.stage] ?? 'var(--muted)';
    // A thick border is the engine's verdict that this is startable right now,
    // which is not the same as sitting in the first column.
    const stroke = n.inCycle ? 'var(--bad)' : n.stage === 'ready' ? 'var(--ok)' : 'var(--line)';
    const width = n.stage === 'ready' || n.inCycle ? 2 : 1;
    const title = n.title.length > 30 ? `${n.title.slice(0, 29)}…` : n.title;
    return `<g><title>#${fmt.esc(String(n.number))} ${fmt.esc(n.title)} — ${n.stage}${n.inCycle ? ' · in a dependency cycle' : ''}</title>
      <rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="8" fill="var(--panel)" stroke="${stroke}" stroke-width="${width}"/>
      <circle cx="${p.x + 14}" cy="${p.y + NH / 2}" r="4" fill="${color}"/>
      <text x="${p.x + 26}" y="${p.y + 19}" fill="var(--text)" font-size="12" font-weight="600">#${n.number}</text>
      <text x="${p.x + 26}" y="${p.y + 34}" fill="var(--muted)" font-size="11">${fmt.esc(title)}</text>
    </g>`;
  }).join('')).join('');

  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" style="min-width:${Math.min(W, 560)}px;width:${W}px;max-width:100%;height:auto">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--line)"/></marker></defs>
    ${heads}${edges.join('')}${nodes}
  </svg></div>`;
}

function planCard(b, fmt) {
  const head = `<div class="kv"><h2>${fmt.esc(b.repo)}${parkedBadge(b)}</h2><span class="muted">${parkToggle(b, fmt)} ${b.plan ? `${b.plan.total} open · ${b.plan.buildableNow} buildable now · ${b.plan.waves} wave${b.plan.waves === 1 ? '' : 's'}` : ''}</span></div>`;
  if (b.error && !b.plan) return `<div class="card">${head}<div class="bad">fetch failed: ${fmt.esc(b.error)}</div></div>`;
  if (!b.plan) return `<div class="card">${head}<div class="muted">no plan available — the engine's cached view has no issue bodies to read dependencies from</div></div>`;
  const cycles = b.plan.cycles.length
    ? `<div class="bad" style="margin-bottom:8px">Dependency cycle: ${b.plan.cycles.map((n) => `#${n}`).join(', ')}. This board cannot drain until a human breaks it.</div>`
    : '';
  const key = '<div class="muted" style="font-size:12px;margin-top:8px">Colour is stage: green ready, blue in a PR, amber parked, grey blocked. A green border is startable right now. An arrow means "unblocks".</div>';
  return `<div class="card">${head}${cycles}${planSvg(b.plan, fmt)}${key}</div>`;
}

export async function renderBoards(el, { api, fmt }) {
  el.innerHTML = '<div class="empty">loading boards…</div>';
  let mode = 'list';
  try { mode = localStorage.getItem('sh.boards.view') === 'chart' ? 'chart' : 'list'; } catch { /* private window */ }
  async function load(fresh = false) {
    const data = await api.get(fresh ? '/api/boards?fresh=1' : '/api/boards');
    const e = data.engine;
    const line = e.running
      ? `engine <span class="ok">running</span>${e.live ? ` · tick ${e.tick} · ${fmt.ago(Date.now() - Date.parse(e.updatedAt))}` : ' · <span class="warn">no fresh snapshot yet</span>'}${e.boundedRun ? ` · bounded ${e.boundedRun.done}/${e.boundedRun.limit} ${e.boundedRun.unit}s` : ''}${e.lastTick ? ` · last tick: ${e.lastTick.dispatched} dispatched, ${e.lastTick.acted} acted, ${e.lastTick.held} held` : ''}`
      : 'engine <span class="muted">stopped</span> — boards shown live from GitHub';
    const cards = data.repos.length
      ? data.repos.map((b) => (mode === 'chart' ? planCard(b, fmt) : repoCard(b, fmt))).join('')
      : '<div class="empty">No repos configured. Add one in Settings.</div>';
    el.innerHTML = `<div class="kv muted" style="margin-bottom:10px"><span>${line}</span><span>
        <span class="provider-toggle" style="display:inline-flex;gap:4px;margin-right:8px">
          <button id="mode-list" class="${mode === 'list' ? 'active' : ''}">List</button>
          <button id="mode-chart" class="${mode === 'chart' ? 'active' : ''}">Build order</button>
        </span>
        <button class="btn" id="reload">Refresh</button></span></div>
      <div class="grid"${mode === 'chart' ? ' style="grid-template-columns:1fr"' : ''}>${cards}</div>`;
    // The choice is per viewer and survives a reload; it is a preference, not state.
    for (const m of ['list', 'chart']) {
      el.querySelector(`#mode-${m}`)?.addEventListener('click', () => {
        if (mode === m) return;
        mode = m;
        try { localStorage.setItem('sh.boards.view', m); } catch { /* private window */ }
        load();
      });
    }
    el.querySelector('#reload')?.addEventListener('click', () => load(true));
    el.querySelectorAll('button[data-park]').forEach((b) => b.addEventListener('click', async () => {
      const parked = b.dataset.parked !== '1';
      b.disabled = true; b.textContent = parked ? 'parking…' : 'resuming…';
      const r = await api.post('/api/board/park', { repo: b.dataset.park, parked });
      if (!r.ok) { b.textContent = r.msg || 'failed'; b.disabled = false; return; }
      await load();
    }));
    el.querySelectorAll('button[data-unpark]').forEach((b) => b.addEventListener('click', async () => {
      const [repo, number, target, label] = b.dataset.unpark.split('|');
      b.disabled = true; b.textContent = 'removing…';
      const r = await api.post('/api/board/unpark', { repo, number: Number(number), target, label });
      if (!r.ok) { b.textContent = r.msg || 'failed'; b.disabled = false; return; }
      await load();
    }));
  }
  await load();
  // A background tab does not poll: every board read costs GitHub API quota
  // that the engine and its students share.
  const t = setInterval(() => { if (!document.hidden) load(); }, 20_000);
  return () => clearInterval(t);
}
