import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt, reviewPrompt, fixPrompt, resolvePrompt, specBlock, MAX_SPEC_CHARS } from '../src/prompts.js';
import { IMPLEMENT_ROLE, REVIEW_ROLE, FIX_ROLE, RESOLVE_ROLE } from '../src/roles.js';
import type { OpenPull } from '../src/github.js';
import type { Task } from '../src/taskmap.js';

function pull(over: Partial<OpenPull> = {}): OpenPull {
  return {
    number: 42,
    title: 'Add the thing',
    headRefName: 'study/issue-7',
    labels: [],
    mergeable: 'MERGEABLE',
    statusCheckRollup: 'SUCCESS',
    reviewDecision: '',
    ...over,
  } as OpenPull;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: '#7', title: 'Add the thing', model: 'sonnet', role: 'implement',
    priority: 1, deps: [], pinned: false, assignedStudent: null, stage: 'ready',
    ...over,
  } as Task;
}

// THE invariant that makes warm-session reuse pay off: the byte-stable role
// block is the cached prefix, so nothing task-specific may precede it. If a
// builder ever interpolates ahead of the role constant the cache boundary moves
// and every task goes back to a cold read.
test('every builder puts its stable ROLE constant first, byte-for-byte', () => {
  assert.ok(taskPrompt(task(), 'body').startsWith(IMPLEMENT_ROLE));
  assert.ok(reviewPrompt(pull(), 7, 'body', 'me/repo').startsWith(REVIEW_ROLE));
  assert.ok(fixPrompt(pull(), 'me/repo', 'feedback', 'body').startsWith(FIX_ROLE));
  assert.ok(resolvePrompt(pull(), 'master', 'body').startsWith(RESOLVE_ROLE));
});

test('the role prefix is identical across differing task specifics', () => {
  const a = reviewPrompt(pull({ number: 1, title: 'A' }), 1, 'alpha', 'me/repo');
  const b = reviewPrompt(pull({ number: 999, title: 'Z' }), 999, 'omega', 'you/other');
  assert.equal(a.slice(0, REVIEW_ROLE.length), b.slice(0, REVIEW_ROLE.length));
});

test('taskPrompt carries the issue id + title, and marks an empty body', () => {
  const p = taskPrompt(task({ id: '#7', title: 'Add the thing' }), '');
  assert.match(p, /## Issue #7: Add the thing/);
  assert.match(p, /\(no description provided\)/);
});

test('reviewPrompt interpolates the PR number, repo slug, and verdict contract', () => {
  const p = reviewPrompt(pull({ number: 42 }), 7, 'acceptance criteria here', 'me/repo');
  assert.match(p, /## Pull request #42: Add the thing/);
  assert.match(p, /gh pr diff 42 -R me\/repo/);
  assert.match(p, /closes? issue #7/i);
  assert.match(p, /acceptance criteria here/);
  // parseVerdict reads exactly these two markers — the prompt must ask for them
  assert.match(p, /VERDICT: APPROVE/);
  assert.match(p, /VERDICT: REQUEST_CHANGES/);
});

test('reviewPrompt says to review on its own merits when no issue is linked', () => {
  const p = reviewPrompt(pull(), null, '', 'me/repo');
  assert.match(p, /no linked issue found/);
  assert.doesNotMatch(p, /claims to close issue/);
});

test('fixPrompt includes review feedback when there is some', () => {
  const p = fixPrompt(pull(), 'me/repo', 'the null check is wrong', 'issue body');
  assert.match(p, /## PR #42: Add the thing {2}\(branch `study\/issue-7`\)/);
  assert.match(p, /Review feedback to address:/);
  assert.match(p, /the null check is wrong/);
  assert.match(p, /issue body/);
  assert.doesNotMatch(p, /CI is RED/);
});

test('fixPrompt points at the failing checks when CI is red', () => {
  const p = fixPrompt(pull({ statusCheckRollup: 'FAILURE' }), 'me/repo', '', '');
  assert.match(p, /CI is RED on this PR/);
  assert.match(p, /gh pr checks 42 -R me\/repo/);
});

// #172: a classified harness failure forbids editing test bodies and shows the log.
test('fixPrompt forbids touching tests on a harness CI failure and includes the log', () => {
  const p = fixPrompt(pull({ statusCheckRollup: 'FAILURE' }), 'me/repo', '', '', '', {
    class: 'harness', log: 'Test Files  no tests\nErrors  13 errors',
  });
  assert.match(p, /HARNESS/);
  assert.match(p, /do NOT edit.*test/i);
  assert.match(p, /no tests/);            // the log excerpt is present
});

test('fixPrompt tells an assertion-class fixer to fix the code or test', () => {
  const p = fixPrompt(pull({ statusCheckRollup: 'FAILURE' }), 'me/repo', '', '', '', {
    class: 'assertion', log: 'AssertionError: expected 4 to be 5',
  });
  assert.match(p, /ASSERTION/);
  assert.doesNotMatch(p, /do NOT edit.*test/i);
});

// Neither signal present means the PR was rejected for a reason not captured in
// written feedback — the fixer still needs to be told what it is doing there.
test('fixPrompt falls back to the changes-requested reason with no feedback and green CI', () => {
  const p = fixPrompt(pull(), 'me/repo', '', '');
  assert.match(p, /marked changes-requested/);
  assert.doesNotMatch(p, /Review feedback to address/);
  assert.doesNotMatch(p, /CI is RED/);
});

test('resolvePrompt names the base and forbids re-running the merge', () => {
  const p = resolvePrompt(pull(), 'master', 'issue body');
  assert.match(p, /origin\/master/);
  assert.match(p, /Do NOT re-run `git merge`/);
  assert.match(p, /issue body/);
});

test('resolvePrompt marks a missing issue body rather than emitting an empty section', () => {
  assert.match(resolvePrompt(pull(), 'main', ''), /\(no issue body\)/);
});

// The builders slice long inputs so a huge issue/feedback body can't crowd out
// the role block or blow the context.
test('long feedback and issue bodies are truncated', () => {
  const p = fixPrompt(pull(), 'me/repo', 'F'.repeat(9000), 'I'.repeat(9000));
  // Match runs, not totals — the role constant contains these letters too.
  assert.match(p, /F{4000}/);
  assert.doesNotMatch(p, /F{4001}/);
  assert.match(p, /I{1500}/);
  assert.doesNotMatch(p, /I{1501}/);

  assert.match(resolvePrompt(pull(), 'master', 'R'.repeat(9000)), /R{1500}/);
  assert.doesNotMatch(resolvePrompt(pull(), 'master', 'R'.repeat(9000)), /R{1501}/);
});

// -- the repo spec block (#125) ----------------------------------------------
// readSpec() loaded the repo's CLAUDE.md at boot and assigned it to this.spec,
// which nothing read. Students got the role constant plus the issue body and
// rediscovered the repo's conventions by reading files, every task.
//
// The spec now sits immediately after the role block. The GUARANTEED-stable
// prefix is still the role constant alone -- repo-agnostic, so warm slots stay
// fungible across repos -- and two tasks in the same repo additionally share
// [role + spec].

const SPEC = '===== CLAUDE.md =====\nAlways use tabs. Never use semicolons.';

test('the spec reaches the student, after the role block and before the task', () => {
  const p = taskPrompt(task(), 'Build the thing', SPEC);
  assert.ok(p.includes('Always use tabs'), 'spec must be present');
  assert.ok(p.startsWith(IMPLEMENT_ROLE), 'role block still leads');
  assert.ok(p.indexOf('Always use tabs') < p.indexOf('Build the thing'),
    'spec must precede the per-task specifics');
});

test('every role builder carries the spec', () => {
  assert.ok(taskPrompt(task(), 'b', SPEC).includes('Always use tabs'));
  assert.ok(reviewPrompt(pull(), 7, 'b', 'o/r', SPEC).includes('Always use tabs'));
  assert.ok(fixPrompt(pull(), 'o/r', 'fb', 'b', SPEC).includes('Always use tabs'));
  assert.ok(resolvePrompt(pull(), 'master', 'b', SPEC).includes('Always use tabs'));
});

test('the cached prefix is byte-identical across two tasks in the SAME repo', () => {
  const a = taskPrompt(task({ id: '#1', title: 'One' }), 'first body', SPEC);
  const b = taskPrompt(task({ id: '#2', title: 'Two' }), 'second body', SPEC);
  const shared = [IMPLEMENT_ROLE, '', ...specBlock(SPEC)].join('\n');
  assert.ok(a.startsWith(shared), 'task A shares the role+spec prefix');
  assert.ok(b.startsWith(shared), 'task B shares the role+spec prefix');
});

test('prompts for DIFFERENT repos diverge only after the role block', () => {
  const a = taskPrompt(task(), 'body', SPEC);
  const b = taskPrompt(task(), 'body', '===== CLAUDE.md =====\nUse four spaces.');
  // The role constant is common -- this is what keeps slots fungible.
  assert.ok(a.startsWith(IMPLEMENT_ROLE) && b.startsWith(IMPLEMENT_ROLE));
  // ...and the divergence begins at the spec, not before it.
  assert.notEqual(a, b);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  assert.ok(i >= IMPLEMENT_ROLE.length,
    'the shared prefix must cover at least the whole role block');
});

test('no spec means no block at all — not filler', () => {
  assert.deepEqual(specBlock(''), []);
  assert.deepEqual(specBlock('   \n  '), []);
  const p = taskPrompt(task(), 'Build it', '');
  assert.ok(!p.includes('Repository conventions'));
  assert.ok(!p.toLowerCase().includes('no spec files'));
  // Identical to the pre-#125 shape when a repo genuinely has no spec.
  assert.equal(p, taskPrompt(task(), 'Build it'));
});

test('an oversized spec is truncated with a visible marker', () => {
  const huge = 'x'.repeat(MAX_SPEC_CHARS + 5000);
  const block = specBlock(huge).join('\n');
  assert.ok(block.length < huge.length, 'must actually shrink');
  assert.ok(block.includes('spec truncated'), 'truncation must be visible');
  assert.ok(block.includes(String(MAX_SPEC_CHARS)), 'marker names the limit');
});
