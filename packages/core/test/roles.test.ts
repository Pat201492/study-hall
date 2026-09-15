import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPLEMENT_ROLE, REVIEW_ROLE, FIX_ROLE, RESOLVE_ROLE, MERGE_ROLE, EDITOR_ROLE, ROLE_PROMPTS,
} from '../src/roles.js';
import { ROLES } from '../src/types.js';

test('every Role has a non-empty prompt in ROLE_PROMPTS', () => {
  for (const r of ROLES) {
    assert.ok(ROLE_PROMPTS[r], `missing prompt for role ${r}`);
    assert.ok(ROLE_PROMPTS[r].length > 0, `empty prompt for role ${r}`);
  }
  assert.deepEqual(Object.keys(ROLE_PROMPTS).sort(), [...ROLES].sort());
});

test('ROLE_PROMPTS maps each role to its exported constant', () => {
  assert.equal(ROLE_PROMPTS.implement, IMPLEMENT_ROLE);
  assert.equal(ROLE_PROMPTS.review, REVIEW_ROLE);
  assert.equal(ROLE_PROMPTS.fix, FIX_ROLE);
  assert.equal(ROLE_PROMPTS.resolve, RESOLVE_ROLE);
  assert.equal(ROLE_PROMPTS.merge, MERGE_ROLE);
});

test('role prompts are byte-stable (no interpolation drift)', () => {
  // Re-reading the same constant must yield the identical string so re-roling a
  // warm student to the same role reproduces the cached prefix exactly.
  assert.equal(ROLE_PROMPTS.review, REVIEW_ROLE);
  assert.ok(REVIEW_ROLE.includes('APPROVE') && REVIEW_ROLE.includes('REQUEST_CHANGES'));
  assert.ok(FIX_ROLE.includes('push') && !FIX_ROLE.includes('open a new PR\n'));
  assert.ok(RESOLVE_ROLE.toLowerCase().includes('conflict'));
  assert.ok(MERGE_ROLE.toLowerCase().includes('squash'));
});

// #187: the CI artifact-hygiene convention must ride the role PREFIX (not just a
// repo's CLAUDE.md), so a student editing CI on ANY repo carries it. Guards the
// retention-days rule against being dropped from the implement/fix prefixes.
test('the CI artifact-hygiene rule is in the implement + fix role prefixes', () => {
  for (const role of [IMPLEMENT_ROLE, FIX_ROLE]) {
    assert.match(role, /retention-days/);
    assert.match(role, /upload-artifact/);
    assert.match(role, /shared/i); // the "shared account quota" reason
  }
});

test('EDITOR_ROLE is a mode prompt, not a board role', () => {
  // Editor is orchestrated by editor.ts, not assigned per-issue off the board —
  // so it must stay OUT of the board Role union / ROLE_PROMPTS map (else it would
  // pollute the pool sim and break the ROLES↔ROLE_PROMPTS coupling above).
  assert.ok(!(ROLES as string[]).includes('editor'));
  assert.ok(!('editor' in ROLE_PROMPTS));
  // But it must still be a real, non-empty, issue-only prompt.
  assert.ok(EDITOR_ROLE.length > 0);
  assert.ok(EDITOR_ROLE.includes('You are the EDITOR'));
  assert.ok(EDITOR_ROLE.includes('gh issue create'));
  assert.ok(EDITOR_ROLE.includes('NO code'));
});
