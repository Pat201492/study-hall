import type { Blocker } from './buildability.js';

// Carving buildable work out of a parked issue (ported verbatim from v1
// admissionsSplit.ts). Deliberately NOT triage's contract: triage splits an
// oversized issue into pieces that REPLACE it; this carves pieces out of a
// parent that stays put, flagged, for the human part.

export interface BuildablePiece {
  title: string;
  body: string;
  /** Which part of the parent this carries. Free text, quoted back to the human. */
  covers: string;
}

export interface SplitVerdict {
  /** Pieces that can be built now. Empty = nothing separable; leave the issue alone. */
  pieces: BuildablePiece[];
  /** What is left that still needs a human, in one or two sentences. */
  remainder: string;
  /** Why the boundary falls where it does. */
  reason: string;
}

export const ADMISSIONS_SPLIT_FENCE = 'admissions-split';

/** Label marking an issue the splitter has already considered. */
export const SPLIT_CONSIDERED_LABEL = 'split-considered';

export const ADMISSIONS_SPLIT_ROLE = [
  'You are carving buildable work out of an issue that Study Hall cannot finish as written.',
  '',
  'A Study Hall student is a headless coding-agent CLI in a git worktree with bash, file tools,',
  'git and `gh`. It cannot acquire files from third-party websites, accept a licence on someone\'s',
  'behalf, run hardware it does not have, hold credentials, or make a product decision.',
  '',
  'This issue has been flagged because something in it needs a human. Your job is NOT to argue',
  'with that. It is to find the work inside the issue that does NOT depend on the human part, and',
  'state it as issues a student could pick up today.',
  '',
  '## What makes a good piece',
  '',
  '- It can be finished and REVIEWED without the human part existing. Code that consumes a missing',
  '  asset still qualifies if it can be tested against a fixture or a fallback the issue already',
  '  requires — say so explicitly in the body, and name the fixture.',
  '- It is one pull request. If it is not, propose it as two.',
  '- Its acceptance criteria come from the PARENT. You are carving, not designing. Do not invent',
  '  scope the parent never asked for, and do not weaken a criterion to make it fit.',
  '',
  '## When to propose nothing',
  '',
  'Returning zero pieces is a correct and expected answer. If every part of the issue genuinely',
  'waits on the human — "run the benchmark and record which model wins" has no code half — say so.',
  'A piece that cannot actually be finished is worse than no piece: it costs a full session to',
  'discover, which is the exact failure this whole system exists to prevent.',
  '',
  '## Output',
  '',
  'Read the issue. Explore the repo if it helps you judge what already exists. Write NO code, open',
  'NO pull request, and change NO files.',
  '',
  'Finish with exactly one fenced block:',
  '',
  '```' + ADMISSIONS_SPLIT_FENCE,
  '{',
  '  "reason": "one or two sentences on where the boundary falls and why",',
  '  "remainder": "what is left that still needs a human",',
  '  "pieces": [',
  '    { "title": "…", "body": "## Goal\\n…\\n\\n## Acceptance\\n- [ ] …", "covers": "which part of the parent" }',
  '  ]',
  '}',
  '```',
  '',
  'Use "pieces": [] if nothing is separable.',
].join('\n');

/** The per-issue half of the prompt. */
export function splitPrompt(
  slug: string, number: number, title: string, body: string, blockers: Blocker[], spec = '',
): string {
  const why = blockers.length
    ? blockers.map((b) => `- **${b.kind}** — ${b.needs} (evidence: ${b.evidence})`).join('\n')
    : '- (no machine-readable blocker recorded; read the issue and judge)';
  return [
    ADMISSIONS_SPLIT_ROLE, '',
    ...(spec ? ['## Project spec', '', spec.slice(0, 6000), ''] : []),
    `## The issue: ${slug} #${number} — ${title}`, '',
    body || '(no description provided)', '',
    '## Why it was flagged', '', why,
  ].join('\n');
}

/** A missing or malformed block yields zero pieces rather than throwing: the
 *  caller files nothing on zero pieces, so a garbled answer costs one session
 *  and changes nothing on the board. */
export function parseAdmissionsSplit(text: string): SplitVerdict {
  const empty: SplitVerdict = { pieces: [], remainder: '', reason: '' };
  const fence = new RegExp('```' + ADMISSIONS_SPLIT_FENCE + '\\s*([\\s\\S]*?)```', 'i');
  const m = fence.exec(text ?? '');
  if (!m) return empty;
  let parsed: unknown;
  try { parsed = JSON.parse(m[1].trim()); } catch { return empty; }
  if (!parsed || typeof parsed !== 'object') return empty;
  const o = parsed as Record<string, unknown>;
  const pieces: BuildablePiece[] = [];
  for (const raw of Array.isArray(o.pieces) ? o.pieces : []) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const title = String(p.title ?? '').trim();
    const body = String(p.body ?? '').trim();
    if (!title || !body) continue;
    pieces.push({ title, body, covers: String(p.covers ?? '').trim() });
  }
  return { pieces, remainder: String(o.remainder ?? '').trim(), reason: String(o.reason ?? '').trim() };
}

/** The comment left on the parent once its buildable half has been filed. */
export function splitComment(filed: number[], v: SplitVerdict, label: string): string {
  const lines = [`**Carved the buildable part out of this issue: ${filed.map((n) => `#${n}`).join(', ')}.**`, ''];
  if (v.reason) lines.push(v.reason, '');
  lines.push(
    'Those can be built now. This issue keeps its `' + label + '` flag and stays open, because what',
    'is left still needs you:', '',
    `> ${v.remainder || 'the part a student cannot do from a worktree'}`, '',
    'Nothing here was closed, reworded, or removed from the board.',
  );
  return lines.join('\n');
}

/** The comment left when nothing could be separated. */
export function nothingSeparableComment(v: SplitVerdict): string {
  return [
    '**Checked whether any part of this could be built without you: none of it can.**', '',
    v.reason || 'Every part of this issue depends on the piece that needs a human.', '',
    'The issue stays open and unchanged. It is simply not dispatched until the blocking part exists.',
  ].join('\n');
}
