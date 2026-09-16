import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatEvent, ChatSession, Harness, Usage } from '@study-hall/harness';
import { PLAN_ROLE } from './planRole.js';
import { parseProposals, type IssueDraft } from './drafts.js';

// One planning conversation: a ChatSession on whichever harness the provider
// toggle selected, an event ring the dashboard renders (and replays on
// reconnect), and a small persisted record so a dashboard restart can resume
// the same CLI session instead of paying a cold seed. Provider-agnostic: both
// harnesses emit the same ChatEvent union.

export interface PlannerSessionRecord {
  id: string;
  repo: string;
  provider: string;
  harness: string;
  sessionId: string | null;
  cwd: string;
  startedAt: string;
  turns: number;
}

export interface StoredEvent { seq: number; ts: number; event: ChatEvent }

export interface PlannerSessionOptions {
  repo: string;
  provider: string;
  harness: Harness;
  /** Fixed for the life of the conversation — the prompt cache is per directory. */
  cwd: string;
  stateDir: string;
  /** The Claude `--mcp-config` file exposing the planner tools (written by the dashboard). */
  mcpConfigPath: () => string;
  /** Codex `-c` overrides exposing the same tools (mcp_servers.plan.*). */
  codexOverrides: Record<string, string>;
  model?: string;
  effort?: string;
  resume?: string;
  ringSize?: number;
  /** Fallback: drafts the model emitted as a fenced `planner-proposals` block
   *  because its tools were unavailable. The caller lints and stages them. */
  onProposals?: (drafts: IssueDraft[]) => void;
  /**
   * Fired once per completed turn with that turn's spend.
   *
   * A planning conversation burns the same account window the students do. It
   * went unbanked, so the burn governor under-counted and nothing could relate
   * the vendor's utilization to tokens (#21). Both chat adapters emit per-turn
   * usage — the Codex one already nets off its cumulative baseline — so the
   * figure here is the turn's own.
   */
  onSpend?: (spend: { usage: Usage; costUsd: number | null; startedAt: number; endedAt: number }) => void;
}

export class PlannerSession {
  readonly id: string;
  readonly record: PlannerSessionRecord;
  private chat: ChatSession | null = null;
  private readonly ring: StoredEvent[] = [];
  private seq = 0;
  private readonly subs = new Set<(e: StoredEvent) => void>();
  private readonly ringSize: number;
  private busy = false;
  private turnStartedAt: number | null = null;

  constructor(private readonly opts: PlannerSessionOptions) {
    this.id = randomUUID();
    this.ringSize = opts.ringSize ?? 500;
    this.record = {
      id: this.id, repo: opts.repo, provider: opts.provider, harness: opts.harness.id,
      sessionId: opts.resume ?? null, cwd: opts.cwd, startedAt: new Date().toISOString(), turns: 0,
    };
    // A resumed session replays the previous conversation's events so the UI
    // shows the thread it is continuing, not a blank pane; seq continues from
    // where the persisted ring left off so `since` cursors stay valid.
    if (opts.resume) {
      for (const e of PlannerSession.loadEvents(opts.stateDir, opts.repo, this.ringSize)) { this.ring.push(e); this.seq = Math.max(this.seq, e.seq); }
      const last = PlannerSession.lastRecord(opts.stateDir, opts.repo);
      if (last?.sessionId === opts.resume) this.record.turns = last.turns;
    } else {
      try { writeFileSync(this.eventsPath(), ''); } catch { /* a fresh session starts an empty log */ }
    }
  }

  get isBusy(): boolean { return this.busy; }
  get sessionId(): string | null { return this.chat?.sessionId ?? this.record.sessionId; }

  start(): void {
    const h = this.opts.harness;
    if (!h.chat) throw new Error(`harness "${h.id}" has no chat transport`);
    const isCodex = h.id === 'codex';
    this.chat = h.chat({
      cwd: this.opts.cwd,
      model: this.opts.model,
      effort: this.opts.effort,
      // A planner reads and searches; it writes no code and must not reach gh.
      tools: isCodex ? undefined : ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__plan__*'],
      systemPrompt: PLAN_ROLE,
      mcpConfig: isCodex ? undefined : this.opts.mcpConfigPath(),
      resume: this.opts.resume,
      sessionId: !this.opts.resume && h.capabilities.seedableSessions ? randomUUID() : undefined,
      extra: isCodex ? { configOverrides: this.opts.codexOverrides, ignoreUserConfig: false } : undefined,
    });
    this.chat.on((e) => this.push(e));
    this.push({ type: 'status', message: `planner session started on ${this.opts.provider} via ${h.id}` });
    this.persist();
  }

  private push(event: ChatEvent): void {
    if (event.type === 'text' && !event.partial && this.opts.onProposals) {
      const drafts = parseProposals(event.text);
      if (drafts.length) { try { this.opts.onProposals(drafts); } catch { /* staging must not break the turn */ } }
    }
    if (event.type === 'turn_done') {
      this.busy = false;
      this.record.turns++;
      if (event.usage && this.opts.onSpend) {
        const startedAt = this.turnStartedAt ?? Date.now();
        try { this.opts.onSpend({ usage: event.usage, costUsd: event.costUsd ?? null, startedAt, endedAt: Date.now() }); }
        catch { /* banking spend must never break the turn */ }
      }
      this.turnStartedAt = null;
      if (event.sessionId) this.record.sessionId = event.sessionId;
      this.persist();
    }
    if (event.type === 'closed' || event.type === 'error') this.busy = false;
    const stored = { seq: ++this.seq, ts: Date.now(), event };
    this.ring.push(stored);
    if (this.ring.length > this.ringSize) this.ring.shift();
    if (event.type !== 'text' || !event.partial) {
      try { appendFileSync(this.eventsPath(), JSON.stringify(stored) + '\n'); } catch { /* the log is a convenience */ }
    }
    for (const fn of this.subs) { try { fn(stored); } catch { /* a listener must not break the session */ } }
  }

  events(since = 0): StoredEvent[] { return this.ring.filter((e) => e.seq > since); }

  subscribe(fn: (e: StoredEvent) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  async send(text: string): Promise<void> {
    if (!this.chat) throw new Error('session not started');
    if (this.busy) throw new Error('a turn is already in flight; interrupt it first');
    this.busy = true;
    this.turnStartedAt = Date.now();
    this.push({ type: 'status', message: `user: ${text}` });
    await this.chat.send(text);
  }

  async interrupt(): Promise<void> { await this.chat?.interrupt(); }

  async close(): Promise<void> {
    await this.chat?.close();
    this.chat = null;
    this.push({ type: 'status', message: 'planner session closed' });
    this.persist();
  }

  private eventsPath(): string {
    const dir = join(this.opts.stateDir, 'planner', this.opts.repo.replace(/[/:]/g, '-'));
    mkdirSync(dir, { recursive: true });
    return join(dir, 'events.jsonl');
  }
  /** The persisted event log for a repo (newest `limit`), for resume replay. */
  static loadEvents(stateDir: string, repo: string, limit = 500): StoredEvent[] {
    const p = join(stateDir, 'planner', repo.replace(/[/:]/g, '-'), 'events.jsonl');
    if (!existsSync(p)) return [];
    const out: StoredEvent[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as StoredEvent); } catch { /* a torn line */ }
    }
    return out.slice(-limit);
  }
  private recordPath(): string {
    const dir = join(this.opts.stateDir, 'planner', this.opts.repo.replace(/[/:]/g, '-'));
    mkdirSync(dir, { recursive: true });
    return join(dir, 'session.json');
  }

  private persist(): void {
    try { writeFileSync(this.recordPath(), JSON.stringify(this.record, null, 2) + '\n'); } catch { /* telemetry must not fail a turn */ }
  }

  /** The last persisted session for a repo, so the dashboard can offer "resume". */
  static lastRecord(stateDir: string, repo: string): PlannerSessionRecord | null {
    const p = join(stateDir, 'planner', repo.replace(/[/:]/g, '-'), 'session.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as PlannerSessionRecord; } catch { return null; }
  }
}
