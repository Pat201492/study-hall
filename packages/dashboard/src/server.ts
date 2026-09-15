import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_HARNESSES, BUILTIN_PROVIDERS, anthropicQuota, claudeCodeHarness, openaiQuota, registerBuiltins,
  openLedger, type Ledger, type QuotaSnapshot, type Provider, type OutcomeKind, resolveBin,
} from '@study-hall/harness';
import { Router, type SseStream } from './router.js';
import { serveStatic } from './static.js';
import { mountPlanner } from './plannerRoutes.js';
import { mountEngine, type BoardGitHub } from './engineRoutes.js';
import {
  configPath, isProviderChoice, isSurface, loadConfig, mutateConfig, providerFor, SURFACES, type StudyHallConfig,
} from './config.js';

// The study-hall dashboard server. Owns: the ledger (writer), the provider quota
// monitors (Claude fed by student streams and probes; Codex by one app-server
// process), the HTTP API the web UI polls, and SSE streams for live views.
// The engine is a separate process (phase 2) that talks to the same ledger.

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBUI = join(HERE, '..', 'webui');
const VERSION = '0.1.0';
const bootedAt = Date.now();

export interface ServerDeps {
  cfg?: StudyHallConfig;
  ledger?: Ledger;
  /** Skip starting the Codex app-server (tests). */
  startCodexQuota?: boolean;
  /** Board fetch/label port (tests fake GitHub). */
  github?: BoardGitHub;
  /** The command the engine child runs (tests use a sleeper). */
  engineCommand?: { command: string; args: string[] };
}

export function buildRouter(deps: ServerDeps = {}): { router: Router; ledger: Ledger; cfg: () => StudyHallConfig; stop: () => void } {
  registerBuiltins();
  const cfgFile = configPath();
  const cfg = (): StudyHallConfig => deps.cfg ?? loadConfig(cfgFile);
  const ledger = deps.ledger ?? openLedger(join(cfg().stateDir, 'ledger'));

  // Every quota observation is a ledger row, so the Overview's "age of
  // observation" survives a restart and the arena can see the windows a trial ran in.
  const unsubscribe = BUILTIN_PROVIDERS.map((p) => p.quota?.subscribe((s) => {
    if (s.observation) ledger.recordQuota(s.observation);
    broadcastQuota();
  }) ?? (() => {}));

  const quotaStreams = new Set<SseStream>();
  const quotaPayload = () => BUILTIN_PROVIDERS.map((p) => providerView(p));
  const broadcastQuota = (): void => {
    const payload = quotaPayload();
    for (const s of quotaStreams) s.send('quota', payload);
  };

  if (deps.startCodexQuota !== false) {
    const codexBin = resolveBin('codex');
    if (codexBin.found) {
      openaiQuota.start().catch((e: Error) => ledger.recordEvent({
        ts: new Date().toISOString(), level: 'warn', event: 'quota.codex.start-failed', reason: e.message,
      }));
    }
  }

  const router = new Router();
  const planner = mountPlanner(router, { cfg, ledger, baseUrl: () => `http://127.0.0.1:${cfg().port}` });
  const engine = mountEngine(router, { cfg, ledger, github: deps.github, engineCommand: deps.engineCommand });

  router.get('/api/health', () => ({ ok: true, version: VERSION, uptimeMs: Date.now() - bootedAt }));

  router.get('/api/status', () => {
    const c = cfg();
    return {
      version: VERSION,
      uptimeMs: Date.now() - bootedAt,
      providers: quotaPayload(),
      harnesses: BUILTIN_HARNESSES.map((h) => ({ id: h.id, provider: h.provider, capabilities: h.capabilities })),
      provider: { ...c.provider, effective: Object.fromEntries(SURFACES.map((s) => [s, providerFor(c, s)])) },
      repos: c.repos,
      engine: (() => { const v = engine.view(); const s = v.status; return { running: v.running, live: v.live, tick: s?.tick ?? 0, stopped: s?.stopped ?? false, updatedAt: s?.updatedAt ?? null, boundedRun: s?.boundedRun ?? null, lastTick: s?.lastTick ?? null, drainRequested: v.drainRequested, students: v.live ? s!.students.length : 0 }; })(),
      ledger: { dir: ledger.dir },
    };
  });

  router.get('/api/quota/stream', (ctx) => {
    const s = ctx.sse();
    quotaStreams.add(s);
    s.send('quota', quotaPayload());
    const beat = setInterval(() => s.comment('keepalive'), 15_000);
    s.onClose(() => { clearInterval(beat); quotaStreams.delete(s); });
  });

  // A provider in UNKNOWN is never assumed full or empty: this is the probe.
  router.post('/api/quota/probe/:provider', async (ctx) => {
    const id = ctx.params.provider;
    if (id === 'openai') {
      await openaiQuota.poll();
      return { ok: true, provider: id, quota: openaiQuota.snapshot() };
    }
    if (id === 'anthropic') {
      const r = await claudeCodeHarness.run('Reply with exactly the word OK.', {
        cwd: cfg().stateDir, model: 'haiku', tools: ['Read'], idleTicks: 2, approval: 'on-request',
      });
      ledger.recordEvent({ ts: new Date().toISOString(), level: 'info', event: 'quota.probe', reason: `anthropic probe: ${r.text.slice(0, 40)}` });
      return { ok: true, provider: id, quota: anthropicQuota.snapshot(), costUsd: r.costUsd ?? null };
    }
    throw new Error(`no probe for provider "${id}"`);
  });

  router.get('/api/runs', (ctx) => {
    const q = ctx.query;
    const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
    return ledger.reader.listRuns({
      repo: q.get('repo') || undefined,
      provider: q.get('provider') || undefined,
      harness: q.get('harness') || undefined,
      role: q.get('role') || undefined,
      item: num('item'),
      outcome: (q.get('outcome') || undefined) as OutcomeKind | undefined,
      since: q.get('since') || undefined,
      until: q.get('until') || undefined,
      limit: num('limit'),
      cursor: q.get('cursor') || null,
    });
  });

  router.get('/api/runs/:id', (ctx) => {
    const d = ledger.reader.runDetail(ctx.params.id);
    if (!d) { ctx.res.statusCode = 404; return { ok: false, msg: 'no such run' }; }
    const t = d.run.transcriptPath;
    return { ...d, transcript: t ? { path: t, exists: existsSync(t), bytes: existsSync(t) ? statSync(t).size : 0 } : null };
  });

  // The transcript is the CLI's own JSONL; we stream it by stored path, never copy it.
  router.get('/api/runs/:id/transcript', (ctx) => {
    const d = ledger.reader.runDetail(ctx.params.id);
    const path = d?.run.transcriptPath;
    if (!path || !existsSync(path)) { ctx.res.statusCode = 404; return { ok: false, msg: 'no transcript on disk for this run' }; }
    const res = ctx.own();
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    createReadStream(path).pipe(res);
  });

  router.get('/api/attribution', (ctx) => ledger.reader.attribution({
    repo: ctx.query.get('repo') || undefined, since: ctx.query.get('since') || undefined,
  }));
  router.get('/api/ladder', (ctx) => ledger.reader.ladderTallies({
    repo: ctx.query.get('repo') || undefined, since: ctx.query.get('since') || undefined,
  }));
  router.get('/api/events', (ctx) => ledger.reader.events({
    since: ctx.query.get('since') || undefined,
    level: (ctx.query.get('level') || undefined) as never,
    repo: ctx.query.get('repo') || undefined,
    limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : 200,
  }));

  router.get('/api/settings', () => cfg());
  router.post('/api/settings/provider', (ctx) => {
    const { surface, choice } = ctx.body as { surface?: unknown; choice?: unknown };
    if (!isProviderChoice(choice) && choice !== null) throw new Error('choice must be anthropic | openai | auto | null');
    if (surface !== undefined && surface !== 'global' && !isSurface(surface)) throw new Error(`unknown surface ${String(surface)}`);
    mutateConfig(cfgFile, (raw) => {
      const p = (raw.provider ??= {}) as Record<string, unknown>;
      if (surface === undefined || surface === 'global') { p.default = choice ?? 'anthropic'; return; }
      const per = (p.perSurface ??= {}) as Record<string, unknown>;
      if (choice === null) delete per[surface as string]; else per[surface as string] = choice;
    });
    const c = cfg();
    ledger.recordEvent({ ts: new Date().toISOString(), level: 'info', event: 'settings.provider', reason: `${surface ?? 'global'} -> ${String(choice)}` });
    return { ok: true, provider: { ...c.provider, effective: Object.fromEntries(SURFACES.map((s) => [s, providerFor(c, s)])) } };
  });

  router.post('/api/ledger/import-v1', () => {
    const p = cfg().v1UsagePath;
    if (!existsSync(p)) return { ok: false, msg: `no v1 usage file at ${p}` };
    return { ok: true, ...ledger.importV1Usage(p) };
  });

  const stop = (): void => {
    engine.stop();
    void planner.stop();
    for (const u of unsubscribe) u();
    for (const s of quotaStreams) s.close();
    openaiQuota.stop();
    ledger.close();
  };
  return { router, ledger, cfg, stop };
}

function providerView(p: Provider): { id: string; label: string; stance: string; meter: string; concurrencyCap?: number; quota: QuotaSnapshot | null } {
  return {
    id: p.id, label: p.label, stance: p.automationStance, meter: p.meter, concurrencyCap: p.concurrencyCap,
    quota: p.quota ? p.quota.snapshot() : null,
  };
}

export async function startServer(deps: ServerDeps & { port?: number } = {}): Promise<{ close: () => Promise<void>; port: number; url: string }> {
  const { router, cfg, stop } = buildRouter(deps);
  const server = createServer(async (req, res) => {
    try {
      if (await router.handle(req, res)) return;
      if (serveStatic(WEBUI, req, res)) return;
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? cfg().port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const close = (): Promise<void> => new Promise((r) => { stop(); server.close(() => r()); });
  return { close, port, url: `http://localhost:${port}` };
}

if (process.argv[1] && /server\.ts$/.test(process.argv[1])) {
  const s = await startServer();
  console.log(`study-hall dashboard ${VERSION} listening on ${s.url}`);
  const shutdown = (): void => { s.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
