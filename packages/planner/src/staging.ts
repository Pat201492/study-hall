import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLabels, openIssue, addLabel, repoSlug, type GhRunner } from '@study-hall/core/github';
import { lintBatch, normaliseKey, orderForFiling, renderBody, type DraftLint, type IssueDraft } from './drafts.js';

// The staging area and the filing ledger. Two files, two owners (the Editor's
// lesson): `drafts.json` is the batch the model is shaping and the dashboard
// shows; `filed.json` is the orchestrator's record of what has ALREADY been
// filed, keyed by idempotency key, so a resumed or re-run session cannot file
// the same issue twice. Nothing here runs `gh` except fileBatch, and it is the
// only writer the planner has.

export interface FiledRecord {
  key: string;
  number: number;
  url: string;
  ts: string;
  title: string;
  rubricSha?: string;
}

export interface StagedBatch {
  repo: string;
  updatedAt: string;
  drafts: IssueDraft[];
  lints: DraftLint[];
}

export interface FileResult {
  key: string;
  status: 'filed' | 'skipped-already-filed' | 'skipped-rejected' | 'failed';
  number?: number;
  url?: string;
  error?: string;
}

export class PlannerStore {
  readonly dir: string;
  constructor(stateDir: string, readonly repo: string) {
    this.dir = join(stateDir, 'planner', repoSlug(repo).replace('/', '-'));
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: string): string { return join(this.dir, name); }
  private read<T>(name: string, fallback: T): T {
    const p = this.path(name);
    if (!existsSync(p)) return fallback;
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private write(name: string, v: unknown): void { writeFileSync(this.path(name), JSON.stringify(v, null, 2) + '\n'); }

  staged(): StagedBatch | null { return this.read<StagedBatch | null>('drafts.json', null); }
  filed(): Record<string, FiledRecord> { return this.read<Record<string, FiledRecord>>('filed.json', {}); }

  /** Replace the staged batch (the model re-proposes the whole set each time). */
  stage(drafts: IssueDraft[], lints: DraftLint[]): StagedBatch {
    const batch: StagedBatch = { repo: this.repo, updatedAt: new Date().toISOString(), drafts, lints };
    this.write('drafts.json', batch);
    return batch;
  }

  /** Merge drafts into the staged batch by key (a lint_issue call refines one). */
  upsert(draft: IssueDraft, lint: DraftLint): StagedBatch {
    const cur = this.staged() ?? { repo: this.repo, updatedAt: '', drafts: [], lints: [] };
    const k = normaliseKey(draft.key);
    const drafts = cur.drafts.filter((d) => normaliseKey(d.key) !== k).concat([draft]);
    const lints = cur.lints.filter((l) => l.key !== k).concat([lint]);
    return this.stage(drafts, lints);
  }

  remove(key: string): StagedBatch | null {
    const cur = this.staged();
    if (!cur) return null;
    const k = normaliseKey(key);
    return this.stage(cur.drafts.filter((d) => normaliseKey(d.key) !== k), cur.lints.filter((l) => l.key !== k));
  }

  clear(): void { this.write('drafts.json', null); }

  markFiled(rec: FiledRecord): void {
    const all = this.filed();
    all[rec.key] = rec;
    this.write('filed.json', all);
  }
}

export interface FileDeps {
  gh?: GhRunner;
  /** Labels known on the repo (so `ensureLabels` creates only what is missing). */
  ensure?: (repo: string, labels: string[]) => Promise<void>;
  openIssue?: (repo: string, title: string, body: string) => Promise<string>;
  addLabel?: (repo: string, number: number, label: string) => Promise<void>;
  now?: () => Date;
}

/**
 * File the ACCEPTED drafts of the staged batch in dependency order, substituting
 * real numbers into dependants, labelling each at birth, and recording every
 * key in the ledger. Rejected drafts are skipped; already-filed keys are skipped
 * (idempotent). Failures do not abort the batch — a dependant of a failed draft
 * is reported as failed too rather than filed with a missing dependency.
 */
export async function fileBatch(
  store: PlannerStore,
  opts: { keys?: string[]; rubricSha?: string; lintContext?: Parameters<typeof lintBatch>[1] } = {},
  deps: FileDeps = {},
): Promise<FileResult[]> {
  const batch = store.staged();
  if (!batch) return [];
  const wanted = opts.keys ? new Set(opts.keys.map(normaliseKey)) : null;
  const selected = batch.drafts.filter((d) => !wanted || wanted.has(normaliseKey(d.key)));
  const lints = new Map(lintBatch(selected, opts.lintContext ?? {}).map((l) => [l.key, l]));
  const filed = store.filed();
  const numbers = new Map<string, number>(Object.values(filed).map((r) => [r.key, r.number]));
  const results: FileResult[] = [];
  const failed = new Set<string>();

  const doOpen = deps.openIssue ?? ((repo, title, body) => openIssue(repo, title, body, deps.gh));
  const doLabel = deps.addLabel ?? ((repo, n, label) => addLabel(repo, n, label, 'issue', deps.gh));
  const doEnsure = deps.ensure ?? (async (repo, labels) => { await ensureLabels(repo, deps.gh, labels); });

  let ordered: IssueDraft[];
  try { ordered = orderForFiling(selected); } catch (e) {
    return selected.map((d) => ({ key: normaliseKey(d.key), status: 'failed', error: (e as Error).message }));
  }

  const allLabels = new Set<string>();
  for (const l of lints.values()) for (const x of l.computed.labels) allLabels.add(x);
  try { await doEnsure(store.repo, [...allLabels]); } catch (e) {
    return ordered.map((d) => ({ key: normaliseKey(d.key), status: 'failed', error: `label registration failed: ${(e as Error).message}` }));
  }

  for (const draft of ordered) {
    const key = normaliseKey(draft.key);
    const lint = lints.get(key);
    if (filed[key]) { results.push({ key, status: 'skipped-already-filed', number: filed[key].number, url: filed[key].url }); continue; }
    if (!lint || lint.verdict === 'reject') { results.push({ key, status: 'skipped-rejected', error: lint?.reasons.join('; ') }); failed.add(key); continue; }
    const blockedBy = (draft.dependsOn ?? []).map((d) => (typeof d === 'string' && !/^#?\d+$/.test(d) ? normaliseKey(d) : null)).find((k) => k && failed.has(k));
    if (blockedBy) { results.push({ key, status: 'failed', error: `dependency "${blockedBy}" was not filed` }); failed.add(key); continue; }
    try {
      const body = renderBody(draft, numbers, opts.rubricSha);
      const url = await doOpen(store.repo, draft.title, body);
      const number = Number(/\/(\d+)\s*$/.exec(url.trim())?.[1]);
      if (!Number.isFinite(number)) throw new Error(`could not parse the issue number from "${url}"`);
      for (const label of lint.computed.labels) {
        try { await doLabel(store.repo, number, label); } catch { /* the issue exists; a missing label is recoverable */ }
      }
      numbers.set(key, number);
      const rec: FiledRecord = { key, number, url: url.trim(), ts: (deps.now ?? (() => new Date()))().toISOString(), title: draft.title, rubricSha: opts.rubricSha };
      store.markFiled(rec);
      results.push({ key, status: 'filed', number, url: rec.url });
    } catch (e) {
      failed.add(key);
      results.push({ key, status: 'failed', error: (e as Error).message });
    }
  }
  // Drop what was filed from the staging area; keep the rest for another pass.
  const remaining = batch.drafts.filter((d) => !numbers.has(normaliseKey(d.key)) || failed.has(normaliseKey(d.key)));
  const remainingKeys = new Set(remaining.map((d) => normaliseKey(d.key)));
  store.stage(remaining, batch.lints.filter((l) => remainingKeys.has(l.key)));
  return results;
}
