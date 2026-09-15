import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpHandler, createPlannerMcp, mcpClientConfigs } from '../src/mcp.js';
import { PlannerStore } from '../src/staging.js';
import { GOOD_BODY } from './fixtures.js';

async function connected() {
  const store = new PlannerStore(mkdtempSync(join(tmpdir(), 'sh-mcp-')), 'o/r');
  const opened: string[] = [];
  const filed: unknown[] = [];
  const server = createPlannerMcp({
    store,
    repoContext: async () => ({ repo: 'o/r', labels: ['bug', 'triaged'], openIssues: [{ number: 7, title: 'Export runs as CSV', body: 'Owns: x.ts', labels: [] }] }),
    file: { openIssue: async (_r, title) => { opened.push(title); return `https://github.com/o/r/issues/${200 + opened.length}`; }, addLabel: async () => {}, ensure: async () => {} },
    onFiled: (r) => filed.push(r),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  };
  return { store, client, call, opened, filed };
}

test('the planner exposes exactly the five tools and list_repo_context carries the rubric', async () => {
  const { client, call } = await connected();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['file_issues', 'find_duplicate_issue', 'lint_issue', 'list_repo_context', 'propose_issues']);
  const ctx = await call('list_repo_context');
  assert.equal(ctx.repo, 'o/r');
  assert.equal(ctx.openIssues[0].owns, 'x.ts');
  assert.match(ctx.rubric, /Filing rules/);
  assert.match(ctx.rubric, /Acceptance/);
});

test('propose_issues lints the batch and stages it; lint_issue refines one draft', async () => {
  const { store, call } = await connected();
  const r = await call('propose_issues', { drafts: [
    { key: 'csv', title: 'Runs ledger CSV route', body: GOOD_BODY },
    { key: 'weak', title: 'Vague thing', body: '## Goal\nsomething' },
  ] });
  assert.deepEqual(r.counts, { ok: 1, warn: 0, reject: 1 });
  assert.equal(store.staged()?.drafts.length, 2);
  const one = await call('lint_issue', { key: 'weak', title: 'Vague thing, fixed', body: GOOD_BODY });
  assert.equal(one.verdict, 'ok');
  assert.equal(store.staged()?.lints.find((l) => l.key === 'weak')?.verdict, 'ok');
  const dup = await call('find_duplicate_issue', { title: 'Export the runs as CSV please' });
  assert.equal(dup[0]?.number, 7);
});

test('file_issues refuses without confirm, then files the accepted drafts and reports', async () => {
  const { call, opened, filed } = await connected();
  await call('propose_issues', { drafts: [{ key: 'csv', title: 'Runs ledger CSV route', body: GOOD_BODY }] });
  const refused = await call('file_issues', { confirm: false });
  assert.match(refused.error, /confirm=true/);
  assert.equal(opened.length, 0);
  const results = await call('file_issues', { confirm: true });
  assert.deepEqual(results.map((r: { status: string }) => r.status), ['filed']);
  assert.deepEqual(opened, ['Runs ledger CSV route']);
  assert.equal(filed.length, 1);
});

test('the HTTP handler requires the shared token', async () => {
  const handler = createMcpHandler(() => createPlannerMcp({ store: new PlannerStore(mkdtempSync(join(tmpdir(), 'sh-mcp-')), 'o/r'), repoContext: async () => ({ repo: 'o/r', labels: [], openIssues: [] }) }), { token: 'secret' });
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
  const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: JSON.stringify(init), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  assert.equal(noAuth.status, 401);
  const ok = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: JSON.stringify(init), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-plan-token': 'secret' } });
  assert.equal(ok.status, 200);
  server.close();
  const cfg = mcpClientConfigs('http://127.0.0.1:4800/mcp', 'secret');
  assert.equal((cfg.claude.mcpServers as Record<string, { type: string }>).plan.type, 'http');
  assert.match(cfg.codexToml, /X-Plan-Token/);
});
