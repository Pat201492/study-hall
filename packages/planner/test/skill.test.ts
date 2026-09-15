import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderClaudeSkill, renderCodexSkill, claudeMcpAddCommand } from '../src/skill.js';
import { PLAN_ROLE } from '../src/planRole.js';
import { loadRubric } from '../src/rubric.js';

const o = { mcpUrl: 'http://127.0.0.1:4800/mcp/o/r', token: 'tok123' };

test('the Claude skill is PLAN_ROLE plus the rubric, with front matter and the rubric sha stamped', () => {
  const s = renderClaudeSkill(o);
  const rubric = loadRubric();
  assert.match(s, /^---\nname: plan-feature\n/);
  assert.ok(s.includes('$ARGUMENTS'));
  assert.ok(s.includes(PLAN_ROLE), 'the persona is the same byte-stable PLAN_ROLE the dashboard uses');
  assert.ok(s.includes(rubric.text.trim()), 'the rubric is baked in verbatim');
  assert.ok(s.includes(rubric.sha256.slice(0, 12)));
  assert.match(s, /file_issues.*confirm: true/s);
  assert.match(s, /planner-proposals/);
});

test('the Codex skill carries the same persona and the config.toml block with auto tool approval', () => {
  const s = renderCodexSkill(o);
  assert.ok(s.includes(PLAN_ROLE));
  assert.ok(s.includes('[mcp_servers.plan]'));
  assert.ok(s.includes('url = "http://127.0.0.1:4800/mcp/o/r"'));
  assert.ok(s.includes('X-Plan-Token" = "tok123"'));
});

test('the MCP registration one-liner names the transport, scope, url and token header', () => {
  assert.equal(claudeMcpAddCommand(o), 'claude mcp add --transport http --scope user plan "http://127.0.0.1:4800/mcp/o/r" --header "X-Plan-Token: tok123"');
});
