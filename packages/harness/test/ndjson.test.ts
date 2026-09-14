import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonFramer, num } from '../src/ndjson.js';

test('a line split across two chunks is reassembled', () => {
  const f = new NdjsonFramer();
  assert.deepEqual(f.push('{"type":"a","n":1}\n{"type":"b","n'), [{ type: 'a', n: 1 }]);
  assert.deepEqual(f.push('":2}\n'), [{ type: 'b', n: 2 }]);
});

test('a final unterminated line is returned by flush', () => {
  const f = new NdjsonFramer();
  assert.deepEqual(f.push('{"type":"result"}'), []);
  assert.deepEqual(f.flush(), [{ type: 'result' }]);
  assert.deepEqual(f.flush(), []);
});

test('non-JSON, blank, CRLF and array lines are skipped, never thrown on', () => {
  const f = new NdjsonFramer();
  const out = f.push('warning: something\r\n\r\n[1,2]\r\n{"ok":true}\r\n');
  assert.deepEqual(out, [{ ok: true }]);
});

test('onLine receives every raw complete line, including non-JSON ones', () => {
  const f = new NdjsonFramer();
  const lines: string[] = [];
  f.push('noise\n{"a":1}\n', (l) => lines.push(l));
  f.push('{"b":2}', (l) => lines.push(l));
  f.flush((l) => lines.push(l));
  assert.deepEqual(lines, ['noise', '{"a":1}', '{"b":2}']);
});

test('num defaults anything non-finite to 0', () => {
  assert.equal(num(3), 3);
  assert.equal(num('3'), 0);
  assert.equal(num(NaN), 0);
  assert.equal(num(undefined), 0);
});
