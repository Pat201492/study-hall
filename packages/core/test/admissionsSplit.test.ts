import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAdmissionsSplit, splitPrompt, splitComment, nothingSeparableComment,
  ADMISSIONS_SPLIT_ROLE, ADMISSIONS_SPLIT_FENCE, SPLIT_CONSIDERED_LABEL,
} from '../src/admissionsSplit.js';
import { PIPELINE_LABELS } from '../src/github.js';
import { SPLIT_FENCE } from '../src/triage.js';

function fenced(json: string): string {
  return `Some reasoning first.\n\n\`\`\`${ADMISSIONS_SPLIT_FENCE}\n${json}\n\`\`\`\n`;
}

test('a well-formed verdict parses; zero pieces is a valid answer', () => {
  const v = parseAdmissionsSplit(fenced(JSON.stringify({
    reason: 'the loader does not need the art to exist', remainder: 'acquiring 40 licensed images',
    pieces: [{ title: 'Implement the sticker manifest loader', body: '## Goal\nLoad it.', covers: 'the loader' }],
  })));
  assert.equal(v.pieces.length, 1);
  assert.equal(v.pieces[0].title, 'Implement the sticker manifest loader');
  assert.match(v.remainder, /acquiring 40/);
  const none = parseAdmissionsSplit(fenced('{"reason":"all of it needs the GPU run","remainder":"the run","pieces":[]}'));
  assert.deepEqual(none.pieces, []);
  assert.match(none.reason, /GPU run/);
});

test('a missing fence, malformed JSON, or a piece without title/body yields nothing rather than throwing', () => {
  assert.deepEqual(parseAdmissionsSplit('I could not work out how to split this.').pieces, []);
  assert.deepEqual(parseAdmissionsSplit('').pieces, []);
  assert.deepEqual(parseAdmissionsSplit(fenced('{ pieces: [ oops')).pieces, []);
  const v = parseAdmissionsSplit(fenced(JSON.stringify({ pieces: [
    { title: '', body: '## Goal\nreal', covers: 'x' }, { title: 'Has no body', body: '   ', covers: 'y' }, { title: 'Good one', body: '## Goal\nreal', covers: 'z' },
  ] })));
  assert.deepEqual(v.pieces.map((p) => p.title), ['Good one']);
});

test("the fence is NOT triage's — the two contracts differ", () => {
  assert.notEqual(ADMISSIONS_SPLIT_FENCE, SPLIT_FENCE);
  assert.deepEqual(parseAdmissionsSplit('```' + SPLIT_FENCE + '\n{"pieces":[{"title":"t","body":"b"}]}\n```').pieces, []);
});

test('the role forbids writing code and states that nothing is a valid answer', () => {
  assert.match(ADMISSIONS_SPLIT_ROLE, /Write NO code/);
  assert.match(ADMISSIONS_SPLIT_ROLE, /zero pieces is a correct and expected answer/i);
  assert.match(ADMISSIONS_SPLIT_ROLE, /carving, not designing/i);
});

test('the prompt leads with the byte-stable role, then the issue, and names the blocker', () => {
  const p = splitPrompt('o/r', 47, 'Source the pack', 'body text', [{ kind: 'licensing', evidence: 'label `type:licensing`', needs: 'a human to accept the terms' }]);
  assert.ok(p.startsWith(ADMISSIONS_SPLIT_ROLE));
  assert.match(p, /o\/r #47 — Source the pack/);
  assert.match(p, /body text/);
  assert.match(p, /\*\*licensing\*\* — a human to accept the terms/);
  assert.match(splitPrompt('o/r', 1, 't', 'b', []), /no machine-readable blocker recorded/);
});

test('the parent comments say it stays open; split-considered is a registered label', () => {
  const c = splitComment([101, 102], { pieces: [], remainder: 'sourcing the art', reason: 'the loader is independent' }, 'needs-human');
  assert.match(c, /#101, #102/);
  assert.match(c, /stays open/);
  assert.match(c, /needs-human/);
  assert.match(c, /Nothing here was closed, reworded, or removed/);
  assert.match(nothingSeparableComment({ pieces: [], remainder: '', reason: 'it is all one GPU run' }), /stays open and unchanged/);
  assert.ok((PIPELINE_LABELS as readonly string[]).includes(SPLIT_CONSIDERED_LABEL));
});
