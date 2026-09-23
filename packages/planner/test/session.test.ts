import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent, ChatOptions, ChatSession, Harness, HarnessCapabilities } from '@study-hall/harness';
import { PlannerSession } from '../src/session.js';

// A fake harness whose chat() records the options it was opened with and lets
// the test push events, so resume and replay are exercised without a CLI.

const CAPS: HarnessCapabilities = {
  warmSessions: true, seedableSessions: true, forkSessions: true, cacheUsageSplit: true, usageIsCumulative: false,
  reportsCost: true, toolAllowlist: true, mcpToolAllowlist: true, effortControl: true, sandboxModes: ['none'],
  promptTransport: 'stdin', streamsUsage: true, cancellable: true, transcripts: true, budgetStop: true, contextCompaction: false, chat: 'stream-json',
};

function fakeHarness(): { harness: Harness; opened: ChatOptions[]; emit: (e: ChatEvent) => void } {
  const opened: ChatOptions[] = [];
  let listener: ((e: ChatEvent) => void) | null = null;
  let sid: string | null = null;
  const harness: Harness = {
    id: 'claude-code', provider: 'anthropic', capabilities: CAPS,
    run: async () => { throw new Error('unused'); }, killAll: () => {}, classifyFailure: () => ({ kind: 'task' }), preflight: async () => ({ ok: true }),
    chat: (opts) => {
      opened.push(opts);
      sid = opts.resume ?? opts.sessionId ?? null;
      const s: ChatSession = {
        harness: 'claude-code', get sessionId() { return sid; },
        send: async () => {}, interrupt: async () => {}, close: async () => {},
        on: (fn) => { listener = fn; return () => { listener = null; }; },
      };
      return s;
    },
  };
  return { harness, opened, emit: (e) => listener?.(e) };
}

const opts = (stateDir: string, harness: Harness, resume?: string) => ({
  repo: 'o/r', provider: 'anthropic', harness, cwd: stateDir, stateDir,
  mcpConfigPath: () => join(stateDir, 'mcp.json'), codexOverrides: {}, resume,
});

test('events persist across sessions and a resumed session replays them, continuing the seq and the CLI session id', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'sh-planner-'));
  const f1 = fakeHarness();
  const s1 = new PlannerSession(opts(stateDir, f1.harness));
  s1.start();
  const seeded = f1.opened[0].sessionId!;
  assert.ok(seeded, 'a fresh Claude session is seeded with a uuid');
  await s1.send('plan a thing');
  f1.emit({ type: 'text', text: 'partial', partial: true });
  f1.emit({ type: 'text', text: 'Here is a plan.' });
  f1.emit({ type: 'turn_done', sessionId: seeded });
  await s1.close();
  const log = join(stateDir, 'planner', 'o-r', 'events.jsonl');
  assert.ok(existsSync(log));
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!lines.some((l) => l.event.type === 'text' && l.event.partial), 'partial text is not persisted');
  assert.deepEqual(lines.map((l) => l.event.type), ['status', 'status', 'text', 'turn_done', 'status']);
  const lastSeq = lines[lines.length - 1].seq;

  // A restarted dashboard resumes: the CLI gets --resume with the persisted id, the ring replays.
  const last = PlannerSession.lastRecord(stateDir, 'o/r');
  assert.equal(last?.sessionId, seeded);
  const f2 = fakeHarness();
  const s2 = new PlannerSession(opts(stateDir, f2.harness, last!.sessionId!));
  s2.start();
  assert.equal(f2.opened[0].resume, seeded);
  assert.equal(f2.opened[0].sessionId, undefined, 'no new seed when resuming');
  assert.equal(s2.sessionId, seeded);
  assert.equal(s2.record.turns, 1, 'turn count carries over');
  const replayed = s2.events(0);
  assert.equal(replayed.length, lines.length + 1, 'the persisted ring plus the new start status');
  assert.equal(replayed[replayed.length - 1].seq, lastSeq + 1, 'seq continues');
  assert.equal(replayed.filter((e) => e.seq > lastSeq).length, 1, '`since` cursors from before the restart stay valid');
  await s2.close();

  // A fresh (non-resumed) session starts an empty log.
  const f3 = fakeHarness();
  const s3 = new PlannerSession(opts(stateDir, f3.harness));
  s3.start();
  assert.equal(s3.events(0).length, 1);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  await s3.close();
});
