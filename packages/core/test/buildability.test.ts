import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessAdmission, labelBlockers, textBlockers, needsHumanComment, NEEDS_HUMAN_LABEL } from '../src/buildability.js';
import { PARKED_LABELS, classify } from '../src/classify.js';
import { PIPELINE_LABELS } from '../src/github.js';
import type { RawIssue } from '../src/github.js';

// Admissions asks one question: can a STUDENT finish this from a worktree?
//
// Not "is it well written" (issueAudit) and not "is it one PR" (triage). An
// issue can be beautifully specified, correctly sized, and still impossible —
// dungeonworks #47 wants 40 real image files sourced from third-party sites with
// their licences verified, and no amount of retrying makes that reachable.
//
// THE COSTS ARE ASYMMETRIC and every threshold here follows from it. A wrong
// `blocked` takes real work off the board and hides it behind a label until a
// human notices; a wrong `buildable` costs one session that fails loudly. So the
// bar for blocking is high, and `unsure` changes nothing.

function issue(body: string, labels: string[] = [], title = 'a task'): RawIssue {
  return { number: 1, title, body, labels: labels.map((name) => ({ name })) } as unknown as RawIssue;
}

test('a repo label blocks on its own — a maintainer already made that call', () => {
  // Overriding an explicit human judgement would be worse than useless.
  const a = assessAdmission(issue('Source the pack.', ['type:licensing']));
  assert.equal(a.verdict, 'blocked');
  assert.equal(a.fromLabel, true);
  assert.equal(a.blockers[0].kind, 'licensing');
  assert.match(a.blockers[0].evidence, /type:licensing/);
});

// ---- needs-gpu means two opposite things --------------------------------------
// The GPU can be needed to BUILD the deliverable or merely to RUN it, and
// dungeonworks carries the same label on both. Blocking on the label alone took
// four buildable features off the board.

test('needs-gpu + type:research is blocked — the deliverable IS the measurement', () => {
  // #19: "Run the S2 model-selection benchmark and record the decision."
  // There is no artifact without a GPU run.
  const a = assessAdmission(issue('Run the benchmark and record the result.', ['needs-gpu', 'type:research']));
  assert.equal(a.verdict, 'blocked');
  assert.equal(a.blockers[0].kind, 'hardware');
  assert.match(a.blockers[0].evidence, /needs-gpu/);
  assert.match(a.blockers[0].evidence, /type:research/, 'the evidence names BOTH labels, since one alone is not the reason');
});

test('needs-gpu + type:feature is BUILDABLE — the GPU is a runtime dependency', () => {
  // #55 states the requirement outright: a scene "must still render with the DM
  // server switched off, which is the normal state of Pat's GPU box". The spec
  // mandates a deterministic fallback, so the code is writable and testable.
  const a = assessAdmission(issue('Implement the decoration pass with a canned fallback.', ['needs-gpu', 'type:feature']));
  assert.equal(a.verdict, 'buildable', 'blocking this removes real work for no gain');
  assert.deepEqual(a.blockers, []);
});

test('needs-gpu with no type label does not block', () => {
  // Under-blocking costs one session that fails loudly. Over-blocking hides real
  // work behind a label until a human notices. The cheap error is chosen on purpose.
  assert.equal(assessAdmission(issue('Do the thing.', ['needs-gpu'])).verdict, 'buildable');
});

test('prose alone does NOT block — one phrase in a long issue is weak evidence', () => {
  // An issue can mention licensing in its background and still be pure code.
  const a = assessAdmission(issue('Background: the pack is CC0. Now refactor the loader.'));
  assert.equal(a.verdict, 'unsure', 'a single hint must not remove work from the board');
  assert.equal(a.blockers.length, 1);
});

test('two independent blocker kinds in prose is enough', () => {
  const a = assessAdmission(issue(
    'Source the sticker artwork for the pack. Everything comes from OpenGameArt or Kenney.',
  ));
  assert.equal(a.verdict, 'blocked');
  assert.equal(a.fromLabel, false);
  assert.ok(new Set(a.blockers.map((b) => b.kind)).size >= 2);
});

test('an ordinary code issue is buildable', () => {
  const a = assessAdmission(issue([
    '## Goal', 'Add a health endpoint.',
    '## Acceptance', '- [ ] `GET /health` returns 200',
  ].join('\n'), ['difficulty:standard', 'no-gpu']));
  assert.equal(a.verdict, 'buildable');
  assert.deepEqual(a.blockers, []);
});

test('`no-gpu` is the opposite of a blocker and must never trip it', () => {
  // 44 open dungeonworks issues carry it. Matching it would park most of a board.
  assert.deepEqual(labelBlockers(['no-gpu']), []);
});

test('common words do not block: download, buy-in, design a schema', () => {
  for (const s of [
    'Download the config at boot and cache it.',
    'We need buy-in from the team before shipping.',
    'Design a schema for the events table.',
    'Choose the right index for this query.',
  ]) {
    assert.deepEqual(textBlockers(s), [], `false positive on: ${s}`);
  }
});

test('THE EXEMPLAR: dungeonworks #47 is blocked', () => {
  const a = assessAdmission(issue(
    [
      'DungeonWorks renders scenes only from pre-made art.',
      'The binding constraint is licensing, not art.',
      'Sources are shortlisted: Kenney.nl (CC0), OpenGameArt (mixed), itch.io free tilesets.',
      'Import exactly 40 stickers and fill the LICENSES.md register.',
    ].join('\n'),
    ['type:licensing', 'area:data'],
    'Source and license the 40-sticker starter pack',
  ));
  assert.equal(a.verdict, 'blocked');
  assert.ok(a.blockers.some((b) => b.kind === 'licensing'));
});

// ---- the gate ---------------------------------------------------------------

test('a needs-human issue stays OPEN but yields no action', () => {
  // The point is not to close work. It is to stop a student burning sessions
  // discovering it cannot start.
  const actions = classify([issue('Source the artwork.', [NEEDS_HUMAN_LABEL])], []);
  assert.deepEqual(actions, [], 'no student is dispatched');
});

test('removing the label is the override, and needs no code path of its own', () => {
  const actions = classify([issue([
    '## Goal', 'Add a health endpoint.',
    '## Acceptance', '- [ ] returns 200',
  ].join('\n'), [])], []);
  assert.equal(actions[0]?.kind, 'IMPLEMENT', 'unlabelled work dispatches as normal');
});

test('the label is registered, or addLabel would fail and re-dispatch forever', () => {
  // A label the engine writes but never created makes `gh issue edit
  // --add-label` fail outright; the park never sticks, the item is re-dispatched
  // every heartbeat, and the watchdog eventually quarantines it.
  assert.ok((PIPELINE_LABELS as readonly string[]).includes(NEEDS_HUMAN_LABEL));
  assert.ok(PARKED_LABELS.includes(NEEDS_HUMAN_LABEL), 'and it must actually park');
});

test('the comment says what is missing and how to hand it back', () => {
  const c = needsHumanComment(assessAdmission(issue('Run it.', ['needs-gpu', 'type:research'])));
  assert.match(c, /cannot build this issue as written/);
  assert.match(c, /hardware/);
  assert.match(c, /stays open/, 'must be explicit that nothing was closed');
  assert.match(c, new RegExp(`remove \\\`${NEEDS_HUMAN_LABEL}\\\``), 'the override is stated');
});

test('duplicate blockers are not repeated in the comment', () => {
  const c = needsHumanComment({
    verdict: 'blocked',
    fromLabel: true,
    blockers: [
      { kind: 'licensing', evidence: 'a', needs: 'a human to verify the licence terms per source' },
      { kind: 'licensing', evidence: 'b', needs: 'a human to verify the licence terms per source' },
    ],
  });
  assert.equal((c.match(/\*\*licensing\*\*/g) ?? []).length, 1);
});
