import { join } from 'node:path';
import { registerBuiltins, DEFAULT_HARNESS_FOR_PROVIDER } from '@study-hall/harness/harnesses';
import { getHarness, getProvider, killAllHarnesses } from '@study-hall/harness/registry';
import { openLedger } from '@study-hall/harness/ledger/index';
import { loadEngineConfig, engineConfigPath } from './config.js';
import { Engine, realEngineGit, realEngineGitHub, realReports, readSpec } from './engine/engine.js';
import { Governance } from './engine/governance.js';
import { Persistence } from './engine/persistence.js';
import { drainRequested, clearDrain } from './drain.js';
import { log } from './logger.js';

// The engine entry. `--live` drives the configured boards with real students;
// `--once` runs a single tick and exits (for a manual check); anything else
// prints usage. The dashboard owns this process as a ManagedProcess child.

const args = new Set(process.argv.slice(2));
if (!args.has('--live') && !args.has('--once')) {
  console.error('usage: node --import tsx packages/core/src/index.ts --live [--once]');
  process.exit(2);
}

const cfgPath = engineConfigPath();
let config = loadEngineConfig(cfgPath);
const stateDir = config.stateDir;
const drainFlag = join(stateDir, 'drain.flag');

registerBuiltins();
const ledger = openLedger(join(stateDir, 'ledger'));
const persistence = new Persistence({ stateDir, log: (m) => log.info(m) });
const governance = new Governance({
  watchdog: config.watchdog, throttle: config.throttle, blackout: config.blackout, crashBurst: config.crashBurst,
  maxParallel: config.maxParallel && config.maxParallel > 0 ? config.maxParallel : config.maxConcurrent,
});
const engine = new Engine({
  config: () => config,
  persistence, governance,
  harnessFor: { ...DEFAULT_HARNESS_FOR_PROVIDER },
  ports: {
    github: realEngineGitHub, git: realEngineGit, reports: realReports, ledger, readSpec, log,
    harnesses: {
      get: getHarness,
      quotaFor: (id) => { try { return getProvider(id).quota; } catch { return undefined; } },
      meterFor: (id) => { try { return getProvider(id).meter; } catch { return undefined; } },
      killAll: killAllHarnesses,
    },
  },
});
engine.onChange = () => engine.writeStatus();

const finish = (code: number): never => {
  try { for (const id of config.provider.failoverOrder) getProvider(id).quota?.stop?.(); } catch { /* best effort */ }
  killAllHarnesses();
  engine.writeStatus();
  ledger.close();
  process.exit(code);
};

log.ok(`study-hall engine booting — ${config.repos.map((r) => r.repo).join(', ') || '(no repos)'}, mode ${config.optimizationMode}, provider ${config.provider.perSurface.board ?? config.provider.default}`);
clearDrain(drainFlag);
try {
  await engine.boot();
} catch (e) {
  log.err(`boot failed: ${(e as Error).message}`);
  finish(1);
}
log.info(`status snapshot → ${persistence.statusPath()}`);

if (args.has('--once')) {
  await engine.tick();
  await engine.drain();
  log.ok('single tick complete');
  finish(0);
}

let draining: Promise<void> | null = null;
const heartbeat = setInterval(() => {
  config = loadEngineConfig(cfgPath);
  if (!draining && drainRequested(drainFlag)) {
    log.info('drain requested — finishing in-flight work, starting nothing new');
    draining = engine.drain().then(() => { clearInterval(heartbeat); clearDrain(drainFlag); log.ok('soft stop complete — every in-flight student finished'); finish(0); });
  }
  void engine.tick().then(() => {
    if (!engine.running && engine.busy === 0) { clearInterval(heartbeat); log.info(`engine stopped: ${engine.stoppedReason}`); finish(0); }
  });
}, config.pollMs);

const shutdown = (): void => {
  clearInterval(heartbeat);
  engine.stop('signal');
  log.info('engine stopped by signal');
  finish(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.on('exit', () => killAllHarnesses());
