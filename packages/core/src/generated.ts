// Generated-file conflict handling (#175).
//
// A lockfile conflict carries no information. The file is machine-written,
// thousands of lines long, and a three-way merge of it is meaningless even when
// it succeeds — the only correct resolution is to take the merged manifest
// (package.json) and regenerate. Before this, `package-lock.json` conflicts on
// test-tracker had a resolver dispatched against them four separate times, each
// reading a diff no human or model can meaningfully merge.
//
// This module is the PURE half: the rule set (which files regenerate, and with
// what command) and the partition of a conflicted-file list into "regenerate"
// vs "a resolver must read this". The git + package-manager IO lives in
// worktree.ts (regenerateLockfiles), which consumes what partitionConflicts
// returns — same split as watchdog.ts (pure counting) vs live.ts (the IO).

// One generated file and how to rebuild it from its manifest.
export interface GeneratedFileRule {
  /** Basename that, when conflicted, is regenerated rather than merged. */
  file: string;
  /** argv to regenerate it, run in the directory that holds the file. Tokenized
   *  (no shell), so it is passed straight to execFile. */
  regen: string[];
}

// The lockfiles every JS ecosystem generates, with the lockfile-only regenerate
// command for each — no node_modules download, just a lockfile consistent with
// the merged manifest. Configurable via StudyRoomConfig.generatedFiles; this is
// the default when a repo says nothing.
export const DEFAULT_GENERATED_FILES: readonly GeneratedFileRule[] = [
  { file: 'package-lock.json', regen: ['npm', 'install', '--package-lock-only', '--no-audit', '--no-fund'] },
  { file: 'npm-shrinkwrap.json', regen: ['npm', 'install', '--package-lock-only', '--no-audit', '--no-fund'] },
  { file: 'pnpm-lock.yaml', regen: ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'] },
  { file: 'yarn.lock', regen: ['yarn', 'install', '--mode', 'update-lockfile'] },
];

// The basename of a path, separator-agnostic (a conflicted path from git is
// posix-slashed even on Windows; a rule's `file` is a bare basename).
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

// One conflicted generated file, paired with the rule that rebuilds it.
export interface GeneratedConflict {
  /** The conflicted path exactly as git reported it (may be nested). */
  path: string;
  rule: GeneratedFileRule;
}

// Split a conflicted-file list into the generated files a resolver should NEVER
// three-way merge (each paired with its regenerate rule) and the ordinary source
// conflicts that genuinely need reading. Matched by basename, so a nested
// `frontend/package-lock.json` is still recognised.
//
// A file matching several rules takes the FIRST — the default order lists the
// canonical command first, and a caller's custom list decides precedence itself.
export function partitionConflicts(
  conflicted: string[],
  rules: readonly GeneratedFileRule[] = DEFAULT_GENERATED_FILES,
): { generated: GeneratedConflict[]; source: string[] } {
  const generated: GeneratedConflict[] = [];
  const source: string[] = [];
  for (const path of conflicted) {
    const rule = rules.find((r) => baseName(r.file) === baseName(path));
    if (rule) generated.push({ path, rule });
    else source.push(path);
  }
  return { generated, source };
}
