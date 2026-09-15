import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { RawIssue } from '@study-hall/core/github';
import { lintBatch, lintDraft, type DraftLint, type IssueDraft, type LintContext } from './drafts.js';
import { fileBatch, type FileDeps, type FileResult, type PlannerStore } from './staging.js';
import { loadRubric, rubricPromptBlock } from './rubric.js';

// The planner's tool surface, served over MCP so every provider — Claude Code,
// Codex, a future CLI, and the user's own terminal — gets the SAME lint and the
// SAME filing path. This is the one component with zero policy exposure: it
// never touches a provider or a credential. It is also the only reliable way to
// get a STRUCTURED issue out of a conversation: a tool call is synchronous,
// gives the model an error it can fix in-conversation, and leaves an auditable
// tool_use/tool_result pair in the transcript.

export interface RepoContext {
  repo: string;
  labels: string[];
  openIssues: Array<Pick<RawIssue, 'number' | 'title' | 'body' | 'labels'>>;
}

export interface PlannerMcpDeps {
  store: PlannerStore;
  /** Fresh repo facts (labels, open issues). Cached by the caller as it sees fit. */
  repoContext: () => Promise<RepoContext>;
  /** Filing seams (tests inject fakes). */
  file?: FileDeps;
  /** Called after any change to the staged batch, so the dashboard can refresh. */
  onStagedChange?: () => void;
  onFiled?: (results: FileResult[]) => void;
}

const draftSchema = z.object({
  key: z.string().describe('stable slug used for idempotency, e.g. "ledger-export-csv"'),
  title: z.string(),
  body: z.string().describe('markdown with ## Goal, ## Scope, ## Acceptance (- [ ] lines)'),
  labels: z.array(z.string()).optional(),
  dependsOn: z.array(z.union([z.string(), z.number()])).optional().describe('draft keys in this batch, or existing issue numbers'),
  owns: z.array(z.string()).optional().describe('file globs this issue exclusively owns'),
  difficulty: z.enum(['simple', 'standard', 'hard']).optional().describe('may only RAISE the computed difficulty'),
  needsHuman: z.boolean().optional(),
});

function lintContext(ctx: RepoContext, batch?: IssueDraft[]): LintContext {
  return { openIssues: ctx.openIssues, repoLabels: ctx.labels, batch };
}

function text(v: unknown) {
  return { content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}

function summariseLint(l: DraftLint): Record<string, unknown> {
  return { key: l.key, verdict: l.verdict, reasons: l.reasons, difficulty: l.computed.difficulty, labels: l.computed.labels, criteria: l.computed.criteria, duplicateOf: l.duplicateOf ?? null };
}

export function createPlannerMcp(deps: PlannerMcpDeps): McpServer {
  const server = new McpServer({ name: 'study-hall-planner', version: '0.1.0' });

  server.registerTool('list_repo_context', {
    description: 'Labels, open issues (number, title, labels, first line, Owns: claims) and the filing rubric for the repo being planned. Call this first.',
    inputSchema: {},
  }, async () => {
    const ctx = await deps.repoContext();
    const rubric = loadRubric();
    return text({
      repo: ctx.repo,
      labels: ctx.labels,
      openIssues: ctx.openIssues.map((i) => ({
        number: i.number, title: i.title, labels: i.labels.map((l) => l.name),
        firstLine: (i.body ?? '').split('\n').find((l) => l.trim())?.slice(0, 160) ?? '',
        owns: /^\s*(?:[-*]\s*)?owns:\s*(.+)$/gim.exec(i.body ?? '')?.[1]?.trim() ?? null,
      })),
      staged: deps.store.staged()?.lints.map(summariseLint) ?? [],
      alreadyFiled: Object.values(deps.store.filed()).map((f) => ({ key: f.key, number: f.number })),
      rubric: rubricPromptBlock(rubric),
    });
  });

  server.registerTool('lint_issue', {
    description: 'Lint ONE draft against the rubric, the repo and the currently staged batch, and stage it. Returns verdict ok|warn|reject with reasons and the computed labels. A reject cannot be filed.',
    inputSchema: draftSchema.shape,
  }, async (draft) => {
    const ctx = await deps.repoContext();
    const batch = (deps.store.staged()?.drafts ?? []).filter((d) => d.key !== draft.key).concat([draft as IssueDraft]);
    const lint = lintDraft(draft as IssueDraft, lintContext(ctx, batch));
    deps.store.upsert(draft as IssueDraft, lint);
    deps.onStagedChange?.();
    return text(summariseLint(lint));
  });

  server.registerTool('propose_issues', {
    description: 'Replace the staged batch with these drafts, lint all of them together (dependencies, shared Owns:, duplicate titles), and return one verdict per draft. Nothing is filed.',
    inputSchema: { drafts: z.array(draftSchema).min(1) },
  }, async ({ drafts }) => {
    const ctx = await deps.repoContext();
    const lints = lintBatch(drafts as IssueDraft[], lintContext(ctx));
    deps.store.stage(drafts as IssueDraft[], lints);
    deps.onStagedChange?.();
    const counts = { ok: 0, warn: 0, reject: 0 };
    for (const l of lints) counts[l.verdict]++;
    return text({ counts, drafts: lints.map(summariseLint) });
  });

  server.registerTool('find_duplicate_issue', {
    description: 'Open issues whose title resembles the given one.',
    inputSchema: { title: z.string() },
  }, async ({ title }) => {
    const ctx = await deps.repoContext();
    const words = new Set(title.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    const hits = ctx.openIssues
      .map((i) => ({ number: i.number, title: i.title, overlap: i.title.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
      .filter((h) => h.overlap >= 2).sort((a, b) => b.overlap - a.overlap).slice(0, 5);
    return text(hits);
  });

  server.registerTool('file_issues', {
    description: 'File the staged, accepted drafts on GitHub in dependency order (real numbers substituted, labels applied, keys recorded so nothing is filed twice). ONLY call this after the user has explicitly confirmed the batch; pass confirm=true.',
    inputSchema: { confirm: z.boolean(), keys: z.array(z.string()).optional().describe('subset of draft keys; omit for the whole batch') },
  }, async ({ confirm, keys }) => {
    if (!confirm) return text({ error: 'refused: confirm=true is required, and only after the user approved the batch' });
    const ctx = await deps.repoContext();
    const results = await fileBatch(deps.store, { keys, rubricSha: loadRubric().sha256, lintContext: lintContext(ctx) }, deps.file);
    deps.onStagedChange?.();
    deps.onFiled?.(results);
    return text(results);
  });

  return server;
}

/**
 * Serve the MCP server over streamable HTTP on a node:http handler, stateless
 * (one transport per request), loopback-only, with a shared secret so a random
 * browser page cannot POST to it and file issues.
 */
export function createMcpHandler(server: () => McpServer, opts: { token: string }) {
  return async (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> => {
    const remote = req.socket.remoteAddress ?? '';
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote)) { res.writeHead(403); res.end('loopback only'); return; }
    const auth = req.headers.authorization ?? '';
    const given = (req.headers['x-plan-token'] as string | undefined) ?? (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!opts.token || given !== opts.token) { res.writeHead(401); res.end('bad planner token'); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => undefined); });
    const s = server();
    await s.connect(transport);
    // A router that already consumed the request stream hands the parsed body in;
    // otherwise read it here. Reading a consumed stream yields nothing and the
    // transport answers "Parse error" — the bug that hid the tools from Claude.
    let body: unknown = parsedBody;
    if (req.method === 'POST' && body === undefined) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    }
    await transport.handleRequest(req, res, body);
  };
}

/** The client-side config files each CLI needs to reach the planner tools. */
export function mcpClientConfigs(url: string, token: string): { claude: Record<string, unknown>; codexToml: string; codexOverrides: Record<string, string> } {
  return {
    claude: { mcpServers: { plan: { type: 'http', url, headers: { 'X-Plan-Token': token } } } },
    codexToml: [`[mcp_servers.plan]`, `url = "${url}"`, `http_headers = { "X-Plan-Token" = "${token}" }`, `startup_timeout_sec = 30`, `tool_timeout_sec = 120`].join('\n'),
    codexOverrides: { 'mcp_servers.plan.url': `"${url}"`, 'mcp_servers.plan.http_headers': `{ "X-Plan-Token" = "${token}" }` },
  };
}
