import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listOpenPulls, prChecks, prMergeable, rollupState,
  addLabel, removeLabel, approvePr, requestChangesPr, ensureLabels,
  prReviewFeedback, PIPELINE_LABELS, findOpenIssueByTitle, openIssueOnce, githubRateLimitReset, prState,
  addIssueDeps, parseDeps, type GhRunner,
} from '../src/github.js';
import { TRIAGED_LABEL, EPIC_LABEL } from '../src/triage.js';
import { NEEDS_DETAIL_LABEL } from '../src/issueAudit.js';
import { NEEDS_HUMAN_LABEL } from '../src/buildability.js';
import { DIFFICULTIES, difficultyLabel } from '../src/difficulty.js';

// A faked `gh` runner: records every argv it's handed and replies with canned
// stdout (a fixed string or a per-call lookup). No `gh` binary is launched.
function fakeGh(stdout: string | ((args: string[]) => string) = '') {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    return typeof stdout === 'function' ? stdout(args) : stdout;
  };
  return { run, calls };
}

test('listOpenPulls parses + normalizes the gh pr list JSON', async () => {
  const json = JSON.stringify([
    {
      number: 7, title: 'Add thing', headRefName: 'feat/thing',
      labels: [{ name: 'ready' }, { name: 'reviewed-ok' }],
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      reviewDecision: 'APPROVED',
    },
    // sparse PR: missing labels/rollup/decision default cleanly
    { number: 8, title: 'WIP', headRefName: 'feat/wip', mergeable: 'CONFLICTING' },
  ]);
  const { run, calls } = fakeGh(json);
  const pulls = await listOpenPulls('me/repo', run);

  assert.deepEqual(calls[0].slice(0, 6), ['pr', 'list', '-R', 'me/repo', '--state', 'open']);
  assert.ok(calls[0].join(' ').includes('statusCheckRollup'));
  assert.deepEqual(pulls[0], {
    number: 7, title: 'Add thing', headRefName: 'feat/thing',
    labels: ['ready', 'reviewed-ok'], mergeable: 'MERGEABLE',
    statusCheckRollup: 'SUCCESS', reviewDecision: 'APPROVED', files: [],
  });
  assert.deepEqual(pulls[1], {
    number: 8, title: 'WIP', headRefName: 'feat/wip',
    labels: [], mergeable: 'CONFLICTING', statusCheckRollup: '', reviewDecision: '', files: [],
  });
  // #177: `files` rides the same list fetch.
  assert.ok(calls[0].join(' ').includes('files'));
});

test('listOpenPulls parses a PR file set for the collision hold (#177)', async () => {
  const json = JSON.stringify([{
    number: 56, title: 'Harness', headRefName: 'feat/harness', mergeable: 'MERGEABLE',
    files: [{ path: 'vitest.config.ts' }, { path: 'package.json' }, { path: '' }],
  }]);
  const { run } = fakeGh(json);
  const pulls = await listOpenPulls('me/repo', run);
  assert.deepEqual(pulls[0].files, ['vitest.config.ts', 'package.json']);
});

test('rollupState reduces mixed checks to one verdict', () => {
  assert.equal(rollupState([]), '');
  assert.equal(rollupState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'SUCCESS');
  assert.equal(rollupState([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'IN_PROGRESS' },
  ]), 'PENDING');
  assert.equal(rollupState([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'IN_PROGRESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
  ]), 'FAILURE');
  // legacy StatusContext (state, no status/conclusion)
  assert.equal(rollupState([{ state: 'PENDING' }]), 'PENDING');
  assert.equal(rollupState([{ state: 'ERROR' }]), 'FAILURE');
  assert.equal(rollupState([{ state: 'SUCCESS' }]), 'SUCCESS');
});

test('prChecks pulls statusCheckRollup for one PR and rolls it up', async () => {
  const { run, calls } = fakeGh(JSON.stringify({
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
  }));
  const r = await prChecks('me/repo', 12, run);
  assert.equal(r, 'FAILURE');
  assert.deepEqual(calls[0], ['pr', 'view', '12', '-R', 'me/repo', '--json', 'statusCheckRollup']);
});

test('prMergeable narrows to MERGEABLE | CONFLICTING | UNKNOWN', async () => {
  const mk = (v?: string) => fakeGh(JSON.stringify(v === undefined ? {} : { mergeable: v }));
  const a = mk('MERGEABLE'); assert.equal(await prMergeable('me/repo', 1, a.run), 'MERGEABLE');
  const b = mk('CONFLICTING'); assert.equal(await prMergeable('me/repo', 1, b.run), 'CONFLICTING');
  const c = mk('UNKNOWN'); assert.equal(await prMergeable('me/repo', 1, c.run), 'UNKNOWN');
  const d = mk(); assert.equal(await prMergeable('me/repo', 1, d.run), 'UNKNOWN');
  assert.deepEqual(a.calls[0], ['pr', 'view', '1', '-R', 'me/repo', '--json', 'mergeable']);
});

test('addLabel / removeLabel target issue or pr with array argv', async () => {
  const add = fakeGh(); await addLabel('me/repo', 5, 'ready', 'issue', add.run);
  assert.deepEqual(add.calls[0], ['issue', 'edit', '5', '-R', 'me/repo', '--add-label', 'ready']);

  const rm = fakeGh(); await removeLabel('me/repo', 5, 'blocked', 'pr', rm.run);
  assert.deepEqual(rm.calls[0], ['pr', 'edit', '5', '-R', 'me/repo', '--remove-label', 'blocked']);

  const dflt = fakeGh(); await addLabel('me/repo', 9, 'reviewed-ok', undefined, dflt.run);
  assert.equal(dflt.calls[0][0], 'issue'); // defaults to issue
});

test('approvePr appends --body only when given; requestChangesPr always does', async () => {
  const bare = fakeGh(); await approvePr('me/repo', 3, '', bare.run);
  assert.deepEqual(bare.calls[0], ['pr', 'review', '3', '-R', 'me/repo', '--approve']);

  const withBody = fakeGh(); await approvePr('me/repo', 3, 'lgtm', withBody.run);
  assert.deepEqual(withBody.calls[0], ['pr', 'review', '3', '-R', 'me/repo', '--approve', '--body', 'lgtm']);

  const changes = fakeGh(); await requestChangesPr('me/repo', 3, 'fix x', changes.run);
  assert.deepEqual(changes.calls[0], ['pr', 'review', '3', '-R', 'me/repo', '--request-changes', '--body', 'fix x']);
});

test('prReviewFeedback joins review + comment bodies, skipping empties', async () => {
  const json = JSON.stringify({
    reviews: [
      { state: 'CHANGES_REQUESTED', body: 'fix the null check' },
      { state: 'COMMENTED', body: '  ' }, // blank -> skipped
    ],
    comments: [{ body: '**Review verdict: REQUEST_CHANGES**\n\ndetails' }, { body: '' }],
  });
  const { run, calls } = fakeGh(json);
  const fb = await prReviewFeedback('me/repo', 7, run);
  assert.deepEqual(calls[0], ['pr', 'view', '7', '-R', 'me/repo', '--json', 'reviews,comments']);
  assert.match(fb, /\[review CHANGES_REQUESTED\]\nfix the null check/);
  assert.match(fb, /\[comment\]\n\*\*Review verdict/);
  assert.doesNotMatch(fb, /\[review COMMENTED\]/); // blank body dropped
});

test('prReviewFeedback is empty when a PR has no reviews or comments', async () => {
  const { run } = fakeGh(JSON.stringify({}));
  assert.equal(await prReviewFeedback('me/repo', 7, run), '');
});

// The regression this guards is worth stating plainly, because it cost a board.
//
// Triage (#163) introduced `triaged` and `epic` and registered neither here. So
// ensureLabels never created them, `gh issue edit --add-label triaged` failed
// with "'triaged' not found", live.ts swallowed that with `.catch(() =>
// undefined)`, and needsTriage() therefore stayed true forever. classify ranks
// TRIAGE above IMPLEMENT, so the issue was re-triaged every heartbeat -- three
// wasted student runs -- until the watchdog quarantined it as "wedged (4
// attempts, no progress)". Two boards were parked that way before anyone could
// see why, because the only evidence was a swallowed exception.
//
// Asserted against the label CONSTANTS rather than string literals: a rename
// that misses this list should fail here rather than in production.
test('every label the engine writes is registered in PIPELINE_LABELS', () => {
  const registered = new Set<string>(PIPELINE_LABELS);
  // `editor-proposed` (the Editor's stamp on every issue it files) and
  // `context-card` (the board's deposited card) were both written by v1 and
  // both missing from this list; editor.ts had to pass an explicit name list
  // to ensureLabels to work around it.
  for (const label of [
    TRIAGED_LABEL, EPIC_LABEL, NEEDS_DETAIL_LABEL, NEEDS_HUMAN_LABEL,
    'editor-proposed', 'context-card',
    ...DIFFICULTIES.map(difficultyLabel),
  ]) {
    assert.ok(
      registered.has(label),
      `the engine calls addLabel('${label}') but it is not in PIPELINE_LABELS, `
      + 'so ensureLabels never creates it and every add of it fails',
    );
  }
});

// Roles are handed an OpenPull snapshot taken at classify time and then run for
// minutes, so the PR can settle underneath them. Observed on test-tracker #56:
// dispatched to FIX at 03:08, merged at 03:16, fix pushed to its branch at
// 03:20. prState is the re-check the landing step makes before acting.
test('prState reports the PR state as it is now', async () => {
  for (const [reported, expected] of [['OPEN', 'OPEN'], ['MERGED', 'MERGED'], ['CLOSED', 'CLOSED']]) {
    const { run, calls } = fakeGh(JSON.stringify({ state: reported }));
    assert.equal(await prState('me/repo', 7, run), expected);
    assert.deepEqual(calls[0], ['pr', 'view', '7', '-R', 'me/repo', '--json', 'state']);
  }
});

test('prState treats an unrecognized or missing state as OPEN, not as settled', async () => {
  // Only MERGED and CLOSED stop a role landing its work. Anything unexpected
  // must fail toward doing the work, never toward silently binning a finished
  // fix on a PR that was fine.
  for (const body of ['{}', '{"state":""}', '{"state":"SOMETHING_NEW"}']) {
    const { run } = fakeGh(body);
    assert.equal(await prState('me/repo', 7, run), 'OPEN');
  }
});

test('prState is case-insensitive about what gh returns', async () => {
  const { run } = fakeGh(JSON.stringify({ state: 'merged' }));
  assert.equal(await prState('me/repo', 7, run), 'MERGED');
});

test('ensureLabels creates every pipeline label a bare repo is missing', async () => {
  const { run, calls } = fakeGh('[]'); // repo defines no labels at all
  const made = await ensureLabels('me/repo', run);

  assert.deepEqual(made, [...PIPELINE_LABELS]);
  assert.deepEqual(calls[0].slice(0, 4), ['label', 'list', '-R', 'me/repo']);
  const creates = calls.slice(1);
  assert.equal(creates.length, PIPELINE_LABELS.length);
  for (const c of creates) {
    assert.deepEqual(c.slice(0, 2), ['label', 'create']);
    assert.ok(c.includes('-R') && c.includes('me/repo'));
    assert.ok(c.includes('--color'));
  }
  assert.deepEqual(creates.map((c) => c[2]), [...PIPELINE_LABELS]);
});

// The repo's own `ready`/`blocked` carry colors and descriptions it set for its
// own workflow — re-creating them (--force) would silently rewrite both.
test('ensureLabels leaves labels the repo already defines untouched', async () => {
  const existing = JSON.stringify([{ name: 'Ready' }, { name: 'blocked' }, { name: 'bug' }]);
  const { run, calls } = fakeGh(existing);
  const made = await ensureLabels('me/repo', run);

  // Derived, not hardcoded: the point of this case is "everything EXCEPT what
  // the repo already had", which stays true as the pipeline set grows.
  const preexisting = ['ready', 'blocked'];
  assert.deepEqual(made, PIPELINE_LABELS.filter((l) => !preexisting.includes(l)));
  const touched = calls.slice(1).map((c) => c[2]);
  assert.ok(!touched.includes('ready'), 'must not re-create a pre-existing label');
  assert.ok(!touched.includes('blocked'));
  for (const c of calls) assert.ok(!c.includes('--force'), 'never clobber an existing definition');
});

test('ensureLabels is a no-op when every pipeline label already exists', async () => {
  const { run, calls } = fakeGh(JSON.stringify(PIPELINE_LABELS.map((name) => ({ name }))));
  assert.deepEqual(await ensureLabels('me/repo', run), []);
  assert.equal(calls.length, 1); // the list call, nothing else
});

test('findOpenIssueByTitle matches exactly, not fuzzily', async () => {
  const json = JSON.stringify([
    { title: '[watchdog] stuck item REVIEW:pr-112 on me/repo', url: 'https://gh/1' },
    { title: '[watchdog] stuck item REVIEW:pr-113 on me/repo', url: 'https://gh/2' },
  ]);
  const { run, calls } = fakeGh(json);

  assert.equal(await findOpenIssueByTitle('me/repo', '  [watchdog] stuck item REVIEW:pr-113 on me/repo  ', run),
    'https://gh/2');
  assert.deepEqual(calls[0].slice(0, 6), ['issue', 'list', '-R', 'me/repo', '--state', 'open']);
  // A prefix of an open title is NOT a match — pr-11 must not dedupe onto pr-112.
  assert.equal(await findOpenIssueByTitle('me/repo', '[watchdog] stuck item REVIEW:pr-11', run), null);
});

test('openIssueOnce reuses an open report instead of filing a duplicate', async () => {
  const open = JSON.stringify([{ title: '[watchdog] engine killed: 6 items wedged', url: 'https://gh/104' }]);
  const dupe = fakeGh(open);
  assert.deepEqual(
    await openIssueOnce('me/repo', '[watchdog] engine killed: 6 items wedged', 'body', dupe.run),
    { url: 'https://gh/104', created: false },
  );
  assert.equal(dupe.calls.length, 1); // list only — no issue create
});

test('openIssueOnce files when no open issue carries the title', async () => {
  const fresh = fakeGh((args) => (args[1] === 'list' ? '[]' : 'https://gh/999\n'));
  assert.deepEqual(
    await openIssueOnce('me/repo', 'new report', 'body', fresh.run),
    { url: 'https://gh/999', created: true },
  );
  assert.deepEqual(fresh.calls[1].slice(0, 4), ['issue', 'create', '-R', 'me/repo']);
});

// A lookup failure (rate limit, no read scope) must not swallow the report.
test('openIssueOnce still files when the dedupe lookup throws', async () => {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === 'list') throw new Error('API rate limit exceeded');
    return 'https://gh/1000\n';
  };
  assert.deepEqual(await openIssueOnce('me/repo', 't', 'b', run), { url: 'https://gh/1000', created: true });
  assert.equal(calls[1][1], 'create');
});

// #170: GitHub's own rate-limit reset drives the backoff. githubRateLimitReset
// returns the soonest EXHAUSTED bucket's reset epoch, or null.
test('githubRateLimitReset returns the soonest exhausted bucket reset', async () => {
  const body = JSON.stringify({ resources: {
    core: { remaining: 42, reset: 100 },        // not exhausted -> ignored
    graphql: { remaining: 0, reset: 900 },      // exhausted
    search: { remaining: 0, reset: 500 },       // exhausted, sooner
  }});
  const { run, calls } = fakeGh(body);
  assert.equal(await githubRateLimitReset(run), 500);
  assert.deepEqual(calls[0], ['api', 'rate_limit']);
});

test('githubRateLimitReset is null when nothing is exhausted or the call fails', async () => {
  const ok = fakeGh(JSON.stringify({ resources: { core: { remaining: 10, reset: 100 } } }));
  assert.equal(await githubRateLimitReset(ok.run), null);
  const bad: GhRunner = async () => { throw new Error('rate_limit unreachable'); };
  assert.equal(await githubRateLimitReset(bad), null);
});

// (v1 asserted here that cliStudent.isCapacityError recognises the GitHub
// rate-limit text. The capacity classifier lives in @study-hall/harness now and
// is tested there.)

// --- addIssueDeps: the pieces go in the BODY --------------------------------
// parseDeps() reads the body and nothing else, so a split that named its
// children only in a comment left the parent reading deps-closed.

test('addIssueDeps appends a Depends on line per piece, in the body', async () => {
  const { run, calls } = fakeGh((args) => (args[0] === 'issue' && args[1] === 'view'
    ? JSON.stringify({ body: '## Context\n\nOriginal.\n\nDepends on #51\n' })
    : ''));
  await addIssueDeps('me/repo', 81, [234, 235, 236], run);

  assert.deepEqual(calls[0], ['issue', 'view', '81', '-R', 'me/repo', '--json', 'body']);
  const edit = calls[1];
  assert.deepEqual(edit.slice(0, 5), ['issue', 'edit', '81', '-R', 'me/repo']);
  const body = edit[edit.indexOf('--body') + 1];
  // The pre-existing body survives, and every piece is now machine-readable.
  assert.match(body, /Original\./);
  assert.deepEqual(parseDeps(body), ['#51', '#234', '#235', '#236']);
});

test('addIssueDeps is idempotent — a re-run stacks no duplicate lines', async () => {
  const existing = 'Body.\n\n## Depends on its pieces\n\nDepends on #234\nDepends on #235\n';
  const { run, calls } = fakeGh((args) => (args[0] === 'issue' && args[1] === 'view'
    ? JSON.stringify({ body: existing })
    : ''));
  await addIssueDeps('me/repo', 81, [234, 235], run);
  // Nothing fresh to record, so the body is never rewritten.
  assert.equal(calls.length, 1, `expected the view only, got ${JSON.stringify(calls)}`);
});

test('addIssueDeps records only the pieces the body is missing', async () => {
  const { run, calls } = fakeGh((args) => (args[0] === 'issue' && args[1] === 'view'
    ? JSON.stringify({ body: 'Depends on #234\n' })
    : ''));
  await addIssueDeps('me/repo', 81, [234, 235, 236], run);
  const body = calls[1][calls[1].indexOf('--body') + 1];
  assert.deepEqual(parseDeps(body), ['#234', '#235', '#236']);
  assert.equal((body.match(/Depends on #234/g) ?? []).length, 1);
});

test('addIssueDeps refuses to guess when the body cannot be read', async () => {
  const { run } = fakeGh('not json');
  await assert.rejects(() => addIssueDeps('me/repo', 81, [234], run), /could not read the issue body/);
});

// --- parseDeps: both forms, every number ------------------------------------
// v1's regex read only the bare `Depends on #N` form the engine itself writes,
// and only the FIRST number on a line. The rubric, EDITOR_ROLE and the planner
// all prescribe the colon form (`Depends on: #N`), so every human- or
// Editor-authored dependency parsed to nothing and never gated dispatch.

test('parseDeps reads the bare form the engine writes', () => {
  assert.deepEqual(parseDeps('Depends on #12'), ['#12']);
  assert.deepEqual(parseDeps('depends on #7\nDEPENDS ON #8'), ['#7', '#8']);
  assert.deepEqual(parseDeps('Depends on #12\nDepends on #12'), ['#12'], 'de-duplicated');
});

test('parseDeps reads the colon form the rubric prescribes', () => {
  assert.deepEqual(parseDeps('Depends on: #5'), ['#5']);
  assert.deepEqual(parseDeps('- Depends on: #5'), ['#5']);
  assert.deepEqual(parseDeps('**Depends on:** #9'), [], 'markdown between the words and the colon is not the convention');
});

test('parseDeps takes every number on a multi-dependency line, in order', () => {
  assert.deepEqual(parseDeps('Depends on: #12, #13'), ['#12', '#13']);
  assert.deepEqual(parseDeps('Depends on #12 #13'), ['#12', '#13']);
  assert.deepEqual(parseDeps('Depends on: #12, #13 and #14'), ['#12', '#13', '#14']);
  assert.deepEqual(parseDeps('Depends on #3, #2, #1'), ['#3', '#2', '#1'], 'body order, not numeric order');
});

test('parseDeps stays on the line — a #N on the next line is not a dependency', () => {
  assert.deepEqual(parseDeps('Depends on #12\n#13 is unrelated'), ['#12']);
  assert.deepEqual(parseDeps('Depends on: #12\nSee also #99'), ['#12']);
});

test('parseDeps ignores prose that is not a dependency line', () => {
  assert.deepEqual(parseDeps('This depends on nothing.'), []);
  assert.deepEqual(parseDeps('Closes #12'), []);
  assert.deepEqual(parseDeps(''), []);
});

test('addIssueDeps keeps writing the bare form, which parseDeps still reads', async () => {
  const { run, calls } = fakeGh((args) => (args[0] === 'issue' && args[1] === 'view'
    ? JSON.stringify({ body: 'Body.\n\nDepends on: #51, #52\n' })
    : ''));
  await addIssueDeps('me/repo', 81, [51, 234], run);
  const body = calls[1][calls[1].indexOf('--body') + 1];
  // #51 was already recorded in the colon form, so only #234 is appended...
  assert.match(body, /Depends on #234/);
  assert.equal((body.match(/#51/g) ?? []).length, 1, 'the colon-form dep is recognised, not re-added');
  // ...and the writer's own line is the no-colon form.
  assert.doesNotMatch(body, /Depends on: #234/);
  assert.deepEqual(parseDeps(body), ['#51', '#52', '#234']);
});
