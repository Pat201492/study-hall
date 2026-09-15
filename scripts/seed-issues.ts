import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureLabels, fetchIssues, listLabels, PIPELINE_LABELS } from '@study-hall/core/github';
import { PlannerStore, fileBatch, lintBatch, loadRubric } from '@study-hall/planner';

// Seed a repo's issues from a drafts module, through the planner's own filing
// path. Usage: node --import tsx scripts/seed-issues.ts <owner/name> <drafts-module> [--dry-run]
// Dry run lints and prints the filing order; nothing touches GitHub.

const [repo, mod, ...flags] = process.argv.slice(2);
if (!repo || !mod) { console.error('usage: seed-issues.ts <owner/name> <drafts-module> [--dry-run]'); process.exit(2); }
const dry = flags.includes('--dry-run');
const { drafts } = await import(pathToFileURL(join(process.cwd(), mod)).href);

const openIssues = await fetchIssues(repo).catch(() => []);
const repoLabels = await listLabels(repo).catch(() => [] as string[]);
const lints = lintBatch(drafts, { openIssues, repoLabels });
for (const l of lints) {
  const flag = l.verdict === 'ok' ? '  ' : l.verdict === 'warn' ? '! ' : 'X ';
  console.error(`${flag}${l.key} — ${l.computed.difficulty}, ${l.computed.criteria} criteria${l.reasons.length ? '\n     ' + l.reasons.join('\n     ') : ''}`);
}
const rejected = lints.filter((l) => l.verdict === 'reject');
if (rejected.length) { console.error(`${rejected.length} draft(s) rejected; fix them first.`); process.exit(1); }
if (dry) { console.error('dry run: nothing filed'); process.exit(0); }

await ensureLabels(repo, undefined, PIPELINE_LABELS);
const store = new PlannerStore(mkdtempSync(join(tmpdir(), 'seed-')), repo);
store.stage(drafts, lints);
const results = await fileBatch(store, { rubricSha: loadRubric().sha256, lintContext: { openIssues, repoLabels } });
for (const r of results) console.log(`${r.status.padEnd(22)} ${r.key}${r.number ? ` #${r.number}` : ''}${r.error ? ` — ${r.error}` : ''}`);
