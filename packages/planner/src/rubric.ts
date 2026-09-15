import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/ISSUE-RUBRIC.md is the single source of the filing rules. v1 kept it as
// a document no model ever read (only the smaller DIFFICULTY_RUBRIC constant
// reached a prompt, and only the Editor's). Here the doc IS the prompt: it is
// loaded at startup, so the rubric a human reads and the rubric the planner
// obeys cannot drift. The sha travels on every filed batch for the record.

const HERE = dirname(fileURLToPath(import.meta.url));

/** Candidate locations, nearest first: the monorepo docs dir, then a cwd-relative docs dir. */
export function rubricCandidates(): string[] {
  return [
    resolve(HERE, '..', '..', '..', 'docs', 'ISSUE-RUBRIC.md'),
    resolve(process.cwd(), 'docs', 'ISSUE-RUBRIC.md'),
  ];
}

export interface RubricText {
  path: string;
  text: string;
  sha256: string;
}

let cached: RubricText | null = null;

export function loadRubric(path?: string): RubricText {
  if (!path && cached) return cached;
  const file = path ?? rubricCandidates().find((p) => existsSync(p));
  if (!file || !existsSync(file)) {
    throw new Error(`ISSUE-RUBRIC.md not found (tried ${rubricCandidates().join(', ')})`);
  }
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const r = { path: file, text, sha256: createHash('sha256').update(text).digest('hex') };
  if (!path) cached = r;
  return r;
}

/** The rubric as a prompt block, prefixed so the model knows what it is reading. */
export function rubricPromptBlock(r: RubricText = loadRubric()): string {
  return [
    `# Filing rules (docs/ISSUE-RUBRIC.md, sha256 ${r.sha256.slice(0, 12)})`,
    `The rules below are ENFORCED mechanically by the lint_issue / propose_issues tools;`,
    `a draft that violates them is rejected before it can be filed.`,
    ``,
    r.text.trim(),
  ].join('\n');
}

/** Test seam. */
export function resetRubricCache(): void { cached = null; }
