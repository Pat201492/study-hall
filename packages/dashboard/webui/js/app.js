// study-hall web UI: hash router + shared API helpers + the provider toggle
// that every screen carries. Vanilla ES modules, no bundler (house style).
import { renderOverview } from './overview.js';
import { renderRuns } from './runs.js';
import { renderSettings } from './settings.js';

/** @typedef {'anthropic'|'openai'|'auto'} ProviderChoice */

const SURFACE_OF_TAB = { overview: null, boards: 'board', pool: 'board', runs: null, planner: 'planner', arena: 'arena', settings: null };
const LABEL = { anthropic: 'Claude', openai: 'ChatGPT', auto: 'Both (failover)' };

export const api = {
  async get(path) { const r = await fetch(path, { cache: 'no-store' }); return r.json(); },
  async post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return r.json();
  },
};

export const fmt = {
  n(v) { return v == null ? '—' : Number(v).toLocaleString(); },
  tok(v) { if (v == null) return '—'; return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(v); },
  usd(v) { return v == null ? '—' : '$' + Number(v).toFixed(3); },
  pct(v) { return v == null ? '?' : Math.round(v * 100) + '%'; },
  ago(ms) { if (ms == null) return '—'; const s = Math.round(ms / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`; },
  when(epochMs) { return epochMs == null ? '—' : new Date(epochMs).toLocaleString(); },
  dur(ms) { if (ms == null) return '—'; const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; },
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
};

const state = { status: null, tab: 'overview' };
export function currentStatus() { return state.status; }

function currentTab() {
  const m = location.hash.match(/^#\/(\w+)/);
  return m ? m[1] : 'overview';
}

async function refreshStatus() {
  try { state.status = await api.get('/api/status'); } catch { state.status = null; }
  document.getElementById('version').textContent = state.status ? `v${state.status.version}` : 'offline';
  document.getElementById('engine-dot').classList.toggle('on', !!state.status?.engine?.running);
  renderToggle();
}

// ---- provider toggle ----------------------------------------------------------
function renderToggle() {
  const el = document.getElementById('provider-toggle');
  const surface = SURFACE_OF_TAB[state.tab];
  const p = state.status?.provider;
  if (!p) { el.hidden = true; return; }
  el.hidden = false;
  const scope = document.getElementById('toggle-scope');
  const override = surface ? p.perSurface?.[surface] : undefined;
  const effective = surface ? (override ?? p.default) : p.default;
  scope.textContent = surface ? (override ? `${surface}:` : `${surface} (global):`) : 'global:';
  for (const b of el.querySelectorAll('button[data-choice]')) {
    const c = b.dataset.choice;
    if (c === 'inherit') { b.hidden = !surface || !override; continue; }
    b.classList.toggle('active', c === effective);
    b.classList.toggle('inherited', !!surface && !override && c === effective);
    b.title = c === effective ? `Effective: ${LABEL[c]}` : LABEL[c];
  }
}

document.getElementById('provider-toggle').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-choice]');
  if (!b) return;
  const surface = SURFACE_OF_TAB[state.tab] ?? 'global';
  const choice = b.dataset.choice === 'inherit' ? null : b.dataset.choice;
  await api.post('/api/settings/provider', { surface, choice });
  await refreshStatus();
  route();
});

// ---- routing ------------------------------------------------------------------
const screens = {
  overview: renderOverview,
  runs: renderRuns,
  settings: renderSettings,
  boards: (el) => { el.innerHTML = '<div class="empty">Boards land with the engine port (phase 2).</div>'; },
  pool: (el) => { el.innerHTML = '<div class="empty">Pool lands with the engine port (phase 2).</div>'; },
  planner: (el) => { el.innerHTML = '<div class="empty">Planner terminal lands in phase 4 (chat transport + MCP lint/file tools are built; UI next).</div>'; },
  arena: (el) => { el.innerHTML = '<div class="empty">Arena report viewer lands with study-arena (phase 5).</div>'; },
};

let teardown = null;
async function route() {
  state.tab = currentTab();
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.tab === state.tab);
  renderToggle();
  if (teardown) { try { teardown(); } catch {} teardown = null; }
  const el = document.getElementById('screen');
  const render = screens[state.tab] ?? screens.overview;
  teardown = await render(el, { api, fmt, status: state.status, refreshStatus });
}

window.addEventListener('hashchange', route);
await refreshStatus();
await route();
setInterval(refreshStatus, 10_000);
