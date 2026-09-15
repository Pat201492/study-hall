import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ChatEvent, ChatOptions, ChatSession, ChildLike, QuotaMonitor, SpawnLike,
} from '../contract.js';
import { NdjsonFramer } from '../ndjson.js';
import { resolveBin as defaultResolveBin, treeKill, type ResolvedBin } from '../proc.js';
import { classifyClaudeFailure, parseClaudeResult, quotaFromRateLimitEvent } from './claudeCode.js';

// The planner's interactive transport on Claude Code: ONE long-lived stock
// `claude -p --input-format stream-json --output-format stream-json` process.
// Spike (a) in docs/adr/ADR-000-phase0-spikes.md: it stays alive after the
// first `result`, answers a second stdin user message (1.1 s vs 3.9 s for the
// boot turn), and exits 0 only once stdin is closed. No Agent SDK — Anthropic's
// docs disallow it on a subscription; the unmodified `claude` binary is the
// carve-out — and no PTY.
//
// No idle watchdog here, deliberately: a human thinks in silence, and the
// student watchdog exists to catch a process that will never speak again, not
// one waiting to be spoken to. Budgets are advisory (usage events) only.
//
// Module graph note: this file imports the pure helpers from ./claudeCode.js,
// which imports createClaudeChat from here for Harness.chat(). The cycle is
// benign — hoisted function declarations referenced only inside method bodies.

export interface ClaudeChatDeps {
  resolveBin?: (name: string) => ResolvedBin;
  spawnFn?: SpawnLike;
  quota?: QuotaMonitor;
  now?: () => number;
  /** Request ids for control requests (interrupt). */
  uuid?: () => string;
  /** close(): how long to wait for the process to exit after stdin EOF before
   *  tree-killing it. */
  closeGraceMs?: number;
}

/**
 * Argv for the chat process. `--include-partial-messages` streams text deltas
 * so the UI can show typing; `--replay-user-messages` echoes our own turns
 * (ignored here, useful in the transcript); `--permission-mode default` keeps
 * the planner on the read-only side of every tool prompt — it proposes, the
 * orchestrator files. `--strict-mcp-config` makes the given MCP config the
 * ONLY one, so a stray user-level server cannot leak into the planner.
 */
export function chatArgs(opts: ChatOptions): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages',
    '--permission-mode', 'default',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    ...(opts.tools && opts.tools.length ? ['--tools', ...opts.tools] : []),
    ...(opts.systemPrompt ? ['--append-system-prompt', opts.systemPrompt] : []),
    ...(opts.mcpConfig ? ['--mcp-config', opts.mcpConfig, '--strict-mcp-config'] : []),
    ...(opts.sessionId ? ['--session-id', opts.sessionId] : []),
    ...(opts.resume ? ['--resume', opts.resume] : []),
  ];
}

/** The one stdin line shape the CLI accepts for a user turn. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`;
}

/**
 * The interrupt control request. Its exact shape is feature-detected: the
 * CLI advertises `interrupt_receipt_v1` in `system/init.capabilities` (spike:
 * ["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"] on
 * 2.1.270). A build without it ignores the line — best effort by design.
 */
export function interruptLine(requestId: string): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })}\n`;
}

const INTERRUPT_CAPABILITY = 'interrupt_receipt_v1';

export function createClaudeChat(opts: ChatOptions, deps: ClaudeChatDeps = {}): ChatSession {
  const resolveBin = deps.resolveBin ?? ((name: string) => defaultResolveBin(name));
  const spawnFn: SpawnLike = opts.spawnFn ?? deps.spawnFn ?? (spawn as unknown as SpawnLike);
  const now = deps.now ?? (() => Date.now());
  const uuid = deps.uuid ?? randomUUID;
  const closeGraceMs = deps.closeGraceMs ?? 5_000;

  const listeners = new Set<(e: ChatEvent) => void>();
  const emit = (e: ChatEvent): void => {
    for (const fn of listeners) {
      try { fn(e); } catch { /* a listener must not break the session */ }
    }
  };

  let sessionId: string | null = opts.sessionId ?? opts.resume ?? null;
  let capabilities: string[] | undefined;
  let exited = false;
  let exitCode: number | null = null;
  const exitWaiters: Array<() => void> = [];
  const framer = new NdjsonFramer();
  const sink = opts.transcriptSink;

  const handleEvent = (evt: Record<string, unknown>): void => {
    const type = evt.type;
    if (type === 'system') {
      if (evt.subtype === 'init') {
        if (typeof evt.session_id === 'string') sessionId = evt.session_id;
        if (Array.isArray(evt.capabilities)) capabilities = evt.capabilities.filter((c): c is string => typeof c === 'string');
        const servers = Array.isArray(evt.mcp_servers)
          ? evt.mcp_servers.map((s) => {
            const m = (s ?? {}) as Record<string, unknown>;
            return `${String(m.name ?? '?')}:${String(m.status ?? '?')}`;
          })
          : [];
        const model = typeof evt.model === 'string' ? evt.model : 'unknown model';
        emit({ type: 'status', message: `ready · model ${model}${servers.length ? ` · mcp ${servers.join(', ')}` : ''}` });
      } else if (evt.subtype === 'api_retry') {
        emit({ type: 'status', message: `api retry ${String(evt.attempt ?? '?')}/${String(evt.max_retries ?? '?')}: ${String(evt.error ?? 'unknown')}` });
      }
      return;
    }
    if (type === 'stream_event') {
      const ev = evt.event as Record<string, unknown> | undefined;
      const delta = ev?.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        emit({ type: 'text', text: delta.text, partial: true });
      }
      return;
    }
    if (type === 'assistant') {
      const msg = evt.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (!Array.isArray(content)) return;
      for (const c of content) {
        const block = (c ?? {}) as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') emit({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') {
          emit({
            type: 'tool_call',
            id: typeof block.id === 'string' ? block.id : undefined,
            name: typeof block.name === 'string' ? block.name : 'unknown',
            input: block.input,
          });
        }
      }
      return;
    }
    if (type === 'user') {
      // Our own replayed turns arrive here too (string content); only tool
      // results are events the UI needs.
      const msg = evt.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (!Array.isArray(content)) return;
      for (const c of content) {
        const block = (c ?? {}) as Record<string, unknown>;
        if (block.type !== 'tool_result') continue;
        emit({
          type: 'tool_result',
          id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          output: block.content,
          isError: block.is_error === true ? true : undefined,
        });
      }
      return;
    }
    if (type === 'rate_limit_event') {
      const reading = quotaFromRateLimitEvent(evt, now());
      if (!reading) return;
      deps.quota?.observe(reading.observation);
      emit({ type: 'quota', observation: reading.observation });
      return;
    }
    if (type === 'result') {
      const r = parseClaudeResult(evt);
      if (r.sessionId) sessionId = r.sessionId;
      if (r.isError) {
        const status = r.apiErrorStatus !== undefined ? ` [api_error_status=${r.apiErrorStatus}]` : '';
        const message = `claude -p error (${r.subtype}): ${r.text.slice(-500)}${status}`;
        emit({ type: 'error', message, verdict: classifyClaudeFailure(message, now()) });
      }
      emit({ type: 'usage', usage: r.usage, costUsd: r.costUsd });
      emit({ type: 'turn_done', usage: r.usage, costUsd: r.costUsd, sessionId: r.sessionId || sessionId || undefined });
      return;
    }
    // Unknown types (hook_*, thinking_tokens, control_response…) are ignored.
  };

  const bin = resolveBin('claude');
  let child: ChildLike;
  try {
    child = spawnFn(bin.path, chatArgs(opts), {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Surface as a closed session rather than throwing out of the factory: the
    // planner UI subscribes first and reads the error like any other event.
    const err = e as Error;
    const dead: ChatSession = {
      harness: 'claude-code',
      get sessionId() { return sessionId; },
      send: () => Promise.reject(new Error(`chat process failed to start: ${err.message}`)),
      interrupt: () => Promise.resolve(),
      close: () => Promise.resolve(),
      on(fn) {
        listeners.add(fn);
        queueMicrotask(() => { emit({ type: 'error', message: `spawn failed: ${err.message}`, verdict: classifyClaudeFailure(err.message, now()) }); emit({ type: 'closed', exitCode: null }); });
        return () => { listeners.delete(fn); };
      },
    };
    return dead;
  }

  let stderrTail = '';
  child.stdout?.on('data', (b) => { for (const evt of framer.push(b.toString(), sink)) handleEvent(evt); });
  child.stderr?.on('data', (b) => { stderrTail = (stderrTail + b.toString()).slice(-2000); });
  child.on('error', (e) => {
    emit({ type: 'error', message: e.message, verdict: classifyClaudeFailure(e.message, now()) });
  });
  child.on('close', (code) => {
    exited = true;
    exitCode = code;
    for (const evt of framer.flush(sink)) handleEvent(evt);
    if (code !== 0 && code !== null && stderrTail.trim()) {
      emit({ type: 'error', message: `claude chat exited ${code}: ${stderrTail.trim().slice(-500)}`, verdict: classifyClaudeFailure(stderrTail, now()) });
    }
    emit({ type: 'closed', exitCode });
    for (const w of exitWaiters.splice(0)) w();
  });

  let closing: Promise<void> | undefined;

  const session: ChatSession = {
    harness: 'claude-code',
    get sessionId() { return sessionId; },

    send(text: string): Promise<void> {
      if (exited || closing) return Promise.reject(new Error('chat session is closed'));
      try {
        child.stdin?.write(userMessageLine(text));
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e as Error);
      }
    },

    interrupt(): Promise<void> {
      if (exited || closing) return Promise.resolve();
      if (capabilities && !capabilities.includes(INTERRUPT_CAPABILITY)) {
        emit({ type: 'status', message: `interrupt sent, but this claude build does not advertise ${INTERRUPT_CAPABILITY}` });
      }
      try { child.stdin?.write(interruptLine(uuid())); } catch { /* best effort */ }
      return Promise.resolve();
    },

    close(): Promise<void> {
      if (closing) return closing;
      closing = new Promise<void>((resolve) => {
        if (exited) { resolve(); return; }
        try { child.stdin?.end(); } catch { /* already gone */ }
        // The CLI exits on stdin EOF; a wedged one is reaped, not waited on.
        const timer = setTimeout(() => { treeKill(child); }, closeGraceMs);
        (timer as { unref?: () => void }).unref?.();
        exitWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
      return closing;
    },

    on(fn: (e: ChatEvent) => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  return session;
}
