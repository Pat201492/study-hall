import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BUILTIN_PROVIDERS, defaultHarnessFor, resolveBin, type Ledger, type Harness,
} from '@study-hall/harness';
import { fetchIssues, listLabels, repoSlug } from '@study-hall/core/github';
import {
  PLAN_ROLE, PlannerSession, PlannerStore, createMcpHandler, createPlannerMcp, fileBatch, lintBatch, loadRubric,
  mcpClientConfigs, type RepoContext,
} from '@study-hall/planner';
import type { Router, SseStream } from './router.js';
import { providerFor, type StudyHallConfig } from './config.js';

// Planner wiring: the MCP tool server (mounted under /mcp/:owner/:name), the
// planning sessions (one per repo), their SSE event streams, the staged-draft
// views, filing, and the "open in a real terminal" escape hatch.

const execFileAsync = promisify(execFile);

export interface PlannerDeps {
  cfg: () => StudyHallConfig;
  ledger: Ledger;
  baseUrl: () => string;
}

export function mountPlanner(router: Router, deps: PlannerDeps): { stop: () => Promise<void> } {
  const stateDir = (): string => deps.cfg().stateDir;
  const plannerDir = (): string => { const d = join(stateDir(), 'planner'); mkdirSync(d, { recursive: true }); return d; };

  // One shared secret per install, persisted so the CLI-side config files stay valid.
  const tokenPath = (): string => join(plannerDir(), 'token');
  const token = (): string => {
    const p = tokenPath();
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
    const t = randomBytes(24).toString('hex');
    writeFileSync(p, t);
    return t;
  };
  const mcpUrl = (repo: string): string => `${deps.baseUrl()}/mcp/${repoSlug(repo)}`;
  const claudeMcpConfigPath = (repo: string): string => {
    const p = join(plannerDir(), `mcp-${repoSlug(repo).replace('/', '-')}.json`);
    writeFileSync(p, JSON.stringify(mcpClientConfigs(mcpUrl(repo), token()).claude, null, 2));
    return p;
  };

  const stores = new Map<string, PlannerStore>();
  const store = (repo: string): PlannerStore => {
    const k = repoSlug(repo);
    let s = stores.get(k);
    if (!s) { s = new PlannerStore(stateDir(), k); stores.set(k, s); }
    return s;
  };

  // Repo facts for the lint context, cached briefly (gh calls are not free).
  const ctxCache = new Map<string, { at: number; ctx: RepoContext }>();
  const repoContext = async (repo: string): Promise<RepoContext> => {
    const k = repoSlug(repo);
    const hit = ctxCache.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.ctx;
    const [labels, openIssues] = await Promise.all([listLabels(k).catch(() => [] as string[]), fetchIssues(k).catch(() => [])]);
    const ctx: RepoContext = { repo: k, labels, openIssues };
    ctxCache.set(k, { at: Date.now(), ctx });
    return ctx;
  };

  const sessions = new Map<string, PlannerSession>();
  const draftStreams = new Map<string, Set<SseStream>>();
  const notifyDrafts = (repo: string): void => {
    for (const s of draftStreams.get(repoSlug(repo)) ?? []) s.send('drafts', draftsView(repo));
  };
  const draftsView = (repo: string) => ({ staged: store(repo).staged(), filed: Object.values(store(repo).filed()) });

  const mcpFor = (repo: string) => createPlannerMcp({
    store: store(repo),
    repoContext: () => repoContext(repo),
    onStagedChange: () => notifyDrafts(repo),
    onFiled: (results) => {
      ctxCache.delete(repoSlug(repo));
      for (const r of results) {
        deps.ledger.recordEvent({ ts: new Date().toISOString(), level: r.status === 'filed' ? 'info' : 'warn', event: 'planner.file', repo: repoSlug(repo), item: r.number, reason: `${r.key}: ${r.status}${r.error ? ' — ' + r.error : ''}` });
      }
    },
  });
  const mcpHandler = (repo: string) => createMcpHandler(() => mcpFor(repo), { token: token() });
  for (const method of ['POST', 'GET', 'DELETE']) {
    router.add(method, '/mcp/:owner/:name', (ctx) => {
      const res = ctx.own();
      return mcpHandler(`${ctx.params.owner}/${ctx.params.name}`)(ctx.req, res, ctx.json);
    });
  }

  // A planning conversation runs INSIDE a checkout so Read/Grep see the code.
  const checkoutFor = async (repo: string): Promise<string> => {
    const slug = repoSlug(repo);
    const dir = join(stateDir(), 'repos', slug.replace('/', '-'));
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(join(stateDir(), 'repos'), { recursive: true });
      await execFileAsync('git', ['clone', '--depth', '50', `https://github.com/${slug}`, dir], { maxBuffer: 32 * 1024 * 1024 });
    } else {
      await execFileAsync('git', ['pull', '--ff-only'], { cwd: dir }).catch(() => undefined);
    }
    return dir;
  };

  const pickProvider = (requested?: string): string => {
    const c = deps.cfg();
    const choice = requested && requested !== 'auto' ? requested : providerFor(c, 'planner');
    if (choice !== 'auto') return choice;
    for (const id of c.provider.failoverOrder) {
      const p = BUILTIN_PROVIDERS.find((x) => x.id === id);
      if (p?.quota?.snapshot().state !== 'exhausted') return id;
    }
    return c.provider.failoverOrder[0] ?? 'anthropic';
  };

  const sessionView = (s: PlannerSession) => ({
    id: s.id, repo: s.record.repo, provider: s.record.provider, harness: s.record.harness,
    sessionId: s.sessionId, turns: s.record.turns, busy: s.isBusy, startedAt: s.record.startedAt, cwd: s.record.cwd,
  });

  router.get('/api/planner/status', () => ({
    active: [...sessions.values()].map(sessionView),
    last: deps.cfg().repos.map((r) => ({ repo: repoSlug(r), record: PlannerSession.lastRecord(stateDir(), repoSlug(r)) })),
    mcpToken: token(),
  }));

  router.post('/api/planner/start', async (ctx) => {
    const { repo, provider: requested, resume } = ctx.body as { repo?: string; provider?: string; resume?: boolean };
    if (!repo) throw new Error('repo is required');
    const slug = repoSlug(repo);
    const existing = sessions.get(slug);
    if (existing) return { ok: true, session: sessionView(existing), note: 'already running' };
    const provider = pickProvider(requested);
    const harness: Harness = defaultHarnessFor(provider);
    const cwd = await checkoutFor(slug);
    const last = resume ? PlannerSession.lastRecord(stateDir(), slug) : null;
    const session = new PlannerSession({
      repo: slug, provider, harness, cwd, stateDir: stateDir(),
      mcpConfigPath: () => claudeMcpConfigPath(slug),
      codexOverrides: mcpClientConfigs(mcpUrl(slug), token()).codexOverrides,
      model: deps.cfg().models[provider]?.default,
      resume: last?.sessionId ?? undefined,
      onProposals: (drafts) => {
        void repoContext(slug).then((c) => {
          store(slug).stage(drafts, lintBatch(drafts, { openIssues: c.openIssues, repoLabels: c.labels }));
          notifyDrafts(slug);
        });
      },
    });
    session.start();
    sessions.set(slug, session);
    deps.ledger.recordEvent({ ts: new Date().toISOString(), level: 'info', event: 'planner.start', repo: slug, reason: `${provider}/${harness.id}${last?.sessionId ? ' (resumed)' : ''}` });
    return { ok: true, session: sessionView(session) };
  });

  const need = (ctx: { body: Record<string, unknown> }): PlannerSession => {
    const s = sessions.get(repoSlug(String(ctx.body.repo ?? '')));
    if (!s) throw new Error('no planner session for that repo — start one');
    return s;
  };
  router.post('/api/planner/say', async (ctx) => { await need(ctx).send(String(ctx.body.text ?? '')); return { ok: true }; });
  router.post('/api/planner/interrupt', async (ctx) => { await need(ctx).interrupt(); return { ok: true }; });
  router.post('/api/planner/stop', async (ctx) => {
    const s = need(ctx);
    await s.close();
    sessions.delete(s.record.repo);
    return { ok: true };
  });

  router.get('/api/planner/stream', (ctx) => {
    const slug = repoSlug(ctx.query.get('repo') || '');
    const since = Number(ctx.query.get('since') || 0);
    const s = ctx.sse();
    const session = sessions.get(slug);
    if (!session) { s.send('status', { message: 'no session' }); s.close(); return; }
    for (const e of session.events(since)) s.send('event', e);
    const off = session.subscribe((e) => s.send('event', e));
    const beat = setInterval(() => s.comment('keepalive'), 15_000);
    s.onClose(() => { off(); clearInterval(beat); });
  });

  router.get('/api/planner/drafts', (ctx) => draftsView(ctx.query.get('repo') || ''));
  router.get('/api/planner/drafts/stream', (ctx) => {
    const slug = repoSlug(ctx.query.get('repo') || '');
    const s = ctx.sse();
    if (!draftStreams.has(slug)) draftStreams.set(slug, new Set());
    draftStreams.get(slug)!.add(s);
    s.send('drafts', draftsView(slug));
    s.onClose(() => draftStreams.get(slug)?.delete(s));
  });
  router.post('/api/planner/drafts/remove', (ctx) => {
    const { repo, key } = ctx.body as { repo?: string; key?: string };
    if (!repo || !key) throw new Error('repo and key are required');
    store(repo).remove(key);
    notifyDrafts(repo);
    return { ok: true };
  });
  router.post('/api/planner/file', async (ctx) => {
    const { repo, keys, confirm } = ctx.body as { repo?: string; keys?: string[]; confirm?: boolean };
    if (!repo) throw new Error('repo is required');
    if (confirm !== true) throw new Error('confirm must be true');
    const c = await repoContext(repo);
    const results = await fileBatch(store(repo), { keys, rubricSha: loadRubric().sha256, lintContext: { openIssues: c.openIssues, repoLabels: c.labels } });
    ctxCache.delete(repoSlug(repo));
    for (const r of results) {
      deps.ledger.recordEvent({ ts: new Date().toISOString(), level: r.status === 'filed' ? 'info' : 'warn', event: 'planner.file', repo: repoSlug(repo), item: r.number, reason: `${r.key}: ${r.status}${r.error ? ' — ' + r.error : ''}` });
    }
    notifyDrafts(repo);
    return { ok: true, results };
  });

  // The real TUI in a console the user owns, with the same role and the same
  // MCP tools — for users who prefer the terminal to the chat pane. Detached
  // and unref'd, so it outlives the dashboard (the ghLoginStart precedent).
  router.post('/api/planner/open-terminal', async (ctx) => {
    const { repo, provider: requested } = ctx.body as { repo?: string; provider?: string };
    if (!repo) throw new Error('repo is required');
    const slug = repoSlug(repo);
    const provider = pickProvider(requested);
    const cwd = await checkoutFor(slug);
    const rolePath = join(plannerDir(), 'PLAN_ROLE.md');
    writeFileSync(rolePath, PLAN_ROLE);
    let command: string;
    if (provider === 'openai') {
      if (!resolveBin('codex').found) throw new Error('codex is not installed');
      const o = mcpClientConfigs(mcpUrl(slug), token()).codexOverrides;
      const overrides = Object.entries(o).map(([k, v]) => `-c ${k}=${JSON.stringify(v)}`).join(' ');
      command = `codex ${overrides} "Read ${rolePath.replace(/\\/g, '/')} and follow it as your role. Then call list_repo_context and ask me what feature to plan."`;
    } else {
      // 2.1.270 has no --append-system-prompt-file and the role is too long for a
      // cmd.exe argument, so the first prompt tells the session to read and adopt it.
      const role = rolePath.replace(/\\/g, '/');
      command = `claude --mcp-config "${claudeMcpConfigPath(slug)}" --strict-mcp-config --permission-mode default "Read ${role} and adopt it as your role for this session. Then call list_repo_context and ask me what feature to plan."`;
    }
    const child = spawn('cmd', ['/c', 'start', `study-hall planner (${slug})`, 'cmd', '/k', `cd /d "${cwd}" && ${command}`], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.unref();
    deps.ledger.recordEvent({ ts: new Date().toISOString(), level: 'info', event: 'planner.terminal', repo: slug, reason: provider });
    return { ok: true, provider, cwd, note: 'A console window opened with the planner role and tools loaded. Drafts you propose there show up here.' };
  });

  return {
    stop: async () => {
      for (const s of sessions.values()) await s.close().catch(() => undefined);
      sessions.clear();
      for (const set of draftStreams.values()) for (const s of set) s.close();
    },
  };
}
