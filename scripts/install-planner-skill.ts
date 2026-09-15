import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderClaudeSkill, renderCodexSkill, claudeMcpAddCommand } from '@study-hall/planner';

// Install /plan-feature for your own terminal.
//   node --import tsx scripts/install-planner-skill.ts <owner/name> [--port 4800]
// Writes ~/.claude/skills/plan-feature/SKILL.md (Claude Code) and
// ~/.codex/skills/plan-feature.md (Codex), then prints the MCP registration
// command. The token comes from the running dashboard's state dir.

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith('--'));
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('usage: install-planner-skill.ts <owner/name> [--port 4800]'); process.exit(2); }
const port = Number(args[args.indexOf('--port') + 1]) || 4800;
const stateDir = process.env.STUDY_HALL_STATE_DIR || join(homedir(), '.study-hall');
const tokenPath = join(stateDir, 'planner', 'token');
if (!existsSync(tokenPath)) { console.error(`no planner token at ${tokenPath} — start the dashboard once first`); process.exit(1); }
const token = readFileSync(tokenPath, 'utf8').trim();
const mcpUrl = `http://127.0.0.1:${port}/mcp/${repo}`;

const claudeDir = join(homedir(), '.claude', 'skills', 'plan-feature');
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(claudeDir, 'SKILL.md'), renderClaudeSkill({ mcpUrl, token }));
const codexDir = join(homedir(), '.codex', 'skills');
mkdirSync(codexDir, { recursive: true });
writeFileSync(join(codexDir, 'plan-feature.md'), renderCodexSkill({ mcpUrl, token }));

console.log(`wrote ${join(claudeDir, 'SKILL.md')}`);
console.log(`wrote ${join(codexDir, 'plan-feature.md')}`);
console.log('\nRegister the planner tools for plain `claude` terminals (once per repo):');
console.log(`  ${claudeMcpAddCommand({ mcpUrl, token })}`);
console.log('\nThen in any terminal:  claude  →  /plan-feature <your idea>');
console.log('Codex: add the [mcp_servers.plan] block printed in the skill file to ~/.codex/config.toml.');
