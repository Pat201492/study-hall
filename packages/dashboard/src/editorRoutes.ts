import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BUILTIN_PROVIDERS, defaultHarnessFor, WarmSlot, type Ledger } from '@study-hall/harness';
import { runEditor, editorStatePath, type FiledProposal, type IssueProposal, type ProposalFiler } from '@study-hall/core/editor';
import { loadState, type EditorState } from '@study-hall/core/editorState';
import { runAdmissions, runAdmissionsSplit, realAdmissionsPort, type AdmissionsPort, type AdmissionsReport, type SplitSummary, type SplitEvent } from '@study-hall/core/admissions';
import { repoSlug, ensureLabels } from '@study-hall/core/github';
import { readSpec } from '@study-hall/core/engine/engine';
import { PlannerStore, fileBatch, lintBatch, loadRubric, type IssueDraft, type FileDeps } from '@study-hall/planner';
import type { Router } from './router.js';
import { providerFor, type StudyHallConfig } from './config.js';

// Editor and Admissions behind the provider toggle. Both run on whichever
// provider the surface says (Claude or Codex, or the first available under
// Both); the Editor's proposals go through the planner's fileBatch — one
// filing implementation, one idempotency ledger — and Admissions stays
// report-first: scan touches nothing, apply and split are explicit.

const execFileAsync = promisify(execFile);

export interface EditorDeps {
  cfg: () => StudyHallConfig;
  ledger: Ledger;
  /** Tests fake the student and GitHub. */
  runEditorFn?: typeof runEditor;
  admissionsPort?: AdmissionsPort;
  splitStudent?: (prompt: string, repo: string) => Promise<{ text: string }>;
  checkout?: (repo: string) => Promise<string>;
  /** The planner filing seams (gh) — tests fake them. */
  fileDeps?: FileDeps;
}

interface EditorRun { repo: string; provider: string; startedAt: string; abort: AbortController; promise: Promise<void>; error?: string }
interface SplitRun { startedAt: string; abort: AbortController; dry: boolean; events: SplitEvent[]; summary: SplitSummary | null; error?: string; done: boolean }

export function mountEditor(router: Router, deps: EditorDeps): { stop: () => void } {
  const stateDir = (): string => deps.cfg().stateDir;
  const editorDir = (repo: string): string => { const d = join(stateDir(), 'editor', repoSlug(repo).replace('/', '-')); mkdirSync(d, { recursive: true }); return d; };

  const checkout = deps.checkout ?? (async (repo: string): Promise<string> => {
    const slug = repoSlug(repo);
    const dir = join(stateDir(), 'repos', slug.replace('/', '-'));
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(join(stateDir(), 'repos'), { recursive: true });
      await execFileAsync('git', ['clone', '--depth', '50', `https://github.com/${slug}`, dir], { maxBuffer: 32 * 1024 * 1024 });
    } else {
      await execFileAsync('git', ['pull', '--ff-only'], { cwd: dir }).catch(() => undefined);
    }
    return dir;
  });

  const pickProvider = (surface: 'editor' | 'admissions', requested?: string): string => {
    const c = deps.cfg();
    const choice = requested && requested !== 'auto' ? requested : providerFor(c, surface);
    if (choice !== 'auto') return choice;
    for (const id of c.provider.failoverOrder) {
      const p = BUILTIN_PROVIDERS.find((x) => x.id === id);
      if (p?.quota?.snapshot().state !== 'exhausted') return id;
    }
    return c.provider.failoverOrder[0] ?? 'anthropic';
  };

  const event = (e: { level?: 'info' | 'warn' | 'error'; event: string; repo?: string; item?: number | null; reason?: string }): void => {
    deps.ledger.recordEvent({ ts: new Date().toISOString(), level: e.level ?? 'info', event: e.event, repo: e.repo ?? null, item: e.item ?? null, reason: e.reason ?? null });
  };

  // ---- Editor ---------------------------------------------------------------------------
  const editorRuns = new Map<string, EditorRun>();

  /** Proposals -> the planner's staging store + fileBatch: one filing path. */
  const plannerFiler = (repo: string): ProposalFiler => async (slug, proposals, labels): Promise<FiledProposal[]> => {
    // Its own store under <stateDir>/editor so Editor keys never collide with the
    // Planner tab's staging for the same repo; the filed ledger is what dedupes.
    const store = new PlannerStore(join(stateDir(), 'editor'), slug);
    // Park mode: the planner's way to file "not for a student yet" is needsHuman,
    // which lints as intended and lands the needs-human label at birth. A bare
    // needs-human label would instead read as an unbuildable draft and be rejected.
    const park = labels.includes('needs-human');
    const drafts: IssueDraft[] = proposals.map((p: IssueProposal) => ({ key: p.key, title: p.title, body: p.body, labels: labels.filter((l) => l !== 'needs-human'), needsHuman: park }));
    const lints = lintBatch(drafts, {});
    store.stage(drafts, lints);
    const results = await fileBatch(store, { rubricSha: loadRubric().sha256 }, deps.fileDeps);
    const out: FiledProposal[] = [];
    for (const r of results) {
      event({ level: r.status === 'filed' ? 'info' : 'warn', event: 'editor.file', repo: slug, item: r.number ?? null, reason: `${r.key}: ${r.status}${r.error ? ' — ' + r.error : ''}` });
      if ((r.status === 'filed' || r.status === 'skipped-already-filed') && r.number) out.push({ key: r.key, url: r.url ?? `https://github.com/${slug}/issues/${r.number}`, number: r.number });
    }
    void repo;
    return out;
  };

  router.get('/api/editor/status', () => {
    const c = deps.cfg();
    return {
      active: [...editorRuns.entries()].map(([repo, r]) => ({ repo, provider: r.provider, startedAt: r.startedAt, error: r.error ?? null })),
      repos: c.repos.map((r) => {
        const slug = repoSlug(r);
        const state: EditorState | null = loadState(editorStatePath(join(editorDir(slug), 'HANDOFF.md')));
        return { repo: slug, state, running: editorRuns.has(slug) };
      }),
    };
  });

  router.post('/api/editor/start', async (ctx) => {
    const { repo, goal, provider: requested, maxInstances, maxIssuesPerChunk, park } = ctx.body as { repo?: string; goal?: string; provider?: string; maxInstances?: number; maxIssuesPerChunk?: number; park?: boolean };
    if (!repo) throw new Error('repo is required');
    if (!goal?.trim()) throw new Error('goal is required');
    const slug = repoSlug(repo);
    if (editorRuns.has(slug)) return { ok: false, msg: 'an Editor run is already going for that repo' };
    const provider = pickProvider('editor', requested);
    const harness = defaultHarnessFor(provider);
    const cwd = await checkout(slug);
    const handoffPath = join(editorDir(slug), 'HANDOFF.md');
    const prior = loadState(editorStatePath(handoffPath));
    const slot = new WarmSlot({ harness, id: prior?.harness === harness.id ? prior.sessionId : undefined });
    const abort = new AbortController();
    const model = deps.cfg().models[provider]?.opus ?? deps.cfg().models[provider]?.default;
    const run: EditorRun = { repo: slug, provider, startedAt: new Date().toISOString(), abort, promise: Promise.resolve() };
    event({ event: 'editor.start', repo: slug, reason: `${provider}/${harness.id}: ${goal.slice(0, 120)}` });
    run.promise = (deps.runEditorFn ?? runEditor)({
      goal, repo: slug, cwd, handoffPath, slot, signal: abort.signal,
      run: { model, tools: ['Read', 'Grep', 'Glob', 'Bash'], approval: 'never', sandbox: provider === 'openai' ? 'read-only' : 'none', idleTicks: 20 },
      maxInstances: maxInstances ?? 3, maxIssuesPerChunk: maxIssuesPerChunk ?? 3,
      extraLabels: park ? ['needs-human'] : [],
      file: plannerFiler(slug),
      ensureLabel: async (r, l) => { await ensureLabels(r, undefined, [l]); },
      onProgress: (e) => event({ event: 'editor.pass', repo: slug, reason: `pass ${e.instance}: ${e.status}, filed ${e.filed.length}, skipped ${e.skipped}${e.guardrailHit ? ', DIRTY TREE reverted' : ''}` }),
    }).then((r) => { event({ event: 'editor.done', repo: slug, reason: `${r.status} after ${r.instances} pass(es), ${r.filed.length} filed, stopped by ${r.stoppedBy || 'DONE'}` }); })
      .catch((e: Error) => { run.error = e.message; event({ level: 'error', event: 'editor.failed', repo: slug, reason: e.message }); })
      .finally(() => { editorRuns.delete(slug); });
    editorRuns.set(slug, run);
    return { ok: true, repo: slug, provider, harness: harness.id };
  });

  router.post('/api/editor/stop', (ctx) => {
    const slug = repoSlug(String((ctx.body as { repo?: string }).repo ?? ''));
    const r = editorRuns.get(slug);
    if (!r) return { ok: false, msg: 'no Editor run for that repo' };
    r.abort.abort();
    return { ok: true, msg: 'stopping after the current pass' };
  });

  // ---- Admissions -----------------------------------------------------------------------
  let lastReport: AdmissionsReport | null = null;
  let split: SplitRun | null = null;
  const port = deps.admissionsPort ?? realAdmissionsPort;

  router.get('/api/admissions', () => ({ report: lastReport, split: split ? { ...split, abort: undefined, events: split.events } : null }));

  router.post('/api/admissions/scan', async (ctx) => {
    const repos = ((ctx.body as { repos?: string[] }).repos ?? deps.cfg().repos).map(repoSlug);
    lastReport = await runAdmissions(repos, { apply: false }, port);
    event({ event: 'admissions.scan', reason: `${repos.length} repo(s), ${lastReport.findings.filter((f) => f.wouldLabel.length).length} would be flagged` });
    return { ok: true, report: lastReport };
  });

  router.post('/api/admissions/apply', async (ctx) => {
    const { repos: requested, confirm } = ctx.body as { repos?: string[]; confirm?: boolean };
    if (confirm !== true) throw new Error('confirm must be true');
    const repos = (requested ?? deps.cfg().repos).map(repoSlug);
    lastReport = await runAdmissions(repos, { apply: true }, port);
    event({ event: 'admissions.apply', reason: lastReport.actions.slice(0, 5).join(' | ') });
    return { ok: true, report: lastReport };
  });

  router.post('/api/admissions/split', async (ctx) => {
    const { repos: requested, limit, dry, provider: requestedProvider } = ctx.body as { repos?: string[]; limit?: number; dry?: boolean; provider?: string };
    if (split && !split.done) return { ok: false, msg: 'a split run is already going' };
    const repos = (requested ?? deps.cfg().repos).map(repoSlug);
    const provider = pickProvider('admissions', requestedProvider);
    const harness = defaultHarnessFor(provider);
    const model = deps.cfg().models[provider]?.opus ?? deps.cfg().models[provider]?.default;
    const abort = new AbortController();
    const run: SplitRun = { startedAt: new Date().toISOString(), abort, dry: dry === true, events: [], summary: null, done: false };
    split = run;
    const student = deps.splitStudent ?? (async (prompt: string, repo: string) => {
      const cwd = await checkout(repo);
      const slot = new WarmSlot({ harness });
      const r = await slot.run(prompt, { cwd, model, tools: ['Read', 'Grep', 'Glob'], approval: 'never', sandbox: provider === 'openai' ? 'read-only' : 'none', signal: abort.signal, idleTicks: 20 });
      return { text: r.text };
    });
    event({ event: 'admissions.split', reason: `${run.dry ? 'dry run' : 'filing'} on ${provider}, limit ${limit ?? 10}` });
    void runAdmissionsSplit({
      repos, limit, dryRun: run.dry, run: student, signal: abort.signal,
      spec: (repo) => { try { return readSpec(join(stateDir(), 'repos', repo.replace('/', '-'))); } catch { return ''; } },
      onIssue: (e) => { run.events.push(e); event({ event: 'admissions.split.issue', repo: e.repo, item: e.number, reason: e.note }); },
    }, port).then((s) => { run.summary = s; }).catch((e: Error) => { run.error = e.message; }).finally(() => { run.done = true; });
    return { ok: true, provider, dry: run.dry };
  });

  router.post('/api/admissions/split/stop', () => {
    if (!split || split.done) return { ok: false, msg: 'no split run going' };
    split.abort.abort();
    return { ok: true };
  });

  return {
    stop: () => {
      for (const r of editorRuns.values()) r.abort.abort();
      split?.abort.abort();
    },
  };
}
